// animation/camera_animator.rs - Safe, production-ready camera animation system

use std::cell::Cell;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use super::{Vec3, Color, TweenGroup, Easing, AnimationError, Result};

/// Camera animation system with smooth transitions
pub struct CameraAnimator {
    // Animation engine  
    tween_engine: TweenGroup,
    
    // Camera state using Cell for interior mutability (safe for single-threaded access)
    position: Cell<Vec3>,
    target: Cell<Vec3>, 
    up: Cell<Vec3>,
    fov: Cell<f32>,
    
    // Path animation state
    current_path: Option<Arc<Vec<Vec3>>>,
    path_progress: Cell<f32>,
    path_completion: Option<oneshot::Receiver<()>>,
    
    // Animation parameters
    look_ahead_factor: f32,
    
    // Default positions
    overview_position: Vec3,
    overview_target: Vec3,
    
    // State
    is_animating: Cell<bool>,
}

impl CameraAnimator {
    pub fn new() -> Self {
        Self {
            tween_engine: TweenGroup::new(),
            position: Cell::new(Vec3::new(0.0, 10.0, 10.0)),
            target: Cell::new(Vec3::zero()),
            up: Cell::new(Vec3::new(0.0, 1.0, 0.0)),
            fov: Cell::new(45.0_f32.to_radians()),
            current_path: None,
            path_progress: Cell::new(0.0),
            path_completion: None,
            look_ahead_factor: 0.2,
            overview_position: Vec3::new(0.0, 15.0, 15.0),
            overview_target: Vec3::zero(),
            is_animating: Cell::new(false),
        }
    }
    
    /// Initialize with maze bounds
    pub fn initialize(&mut self, maze_center: Vec3, maze_radius: f32) {
        self.overview_position = Vec3::new(
            maze_center.x,
            maze_center.y + maze_radius * 1.5,
            maze_center.z + maze_radius * 1.5,
        );
        self.overview_target = maze_center;
        
        self.position.set(self.overview_position);
        self.target.set(self.overview_target);
    }
    
    /// Update camera animation
    pub fn update(&mut self, dt: Duration) -> Result<()> {
        // Update tween engine
        self.tween_engine.update(dt);
        
        // Update path progress from tween
        if let Some(progress) = self.tween_engine.get_f32("path_progress") {
            self.path_progress.set(progress);
        }
        
        // Update path-based position if animating
        if let Some(path) = &self.current_path {
            self.update_path_animation(path.clone())?;
        }
        
        // Update is_animating flag
        self.is_animating.set(self.tween_engine.active_count() > 0);
        
        Ok(())
    }
    
    /// Generate spiral approach path
    pub fn generate_spiral_path(
        &self,
        center: Vec3,
        start_radius: f32,
        end_radius: f32,
        start_height: f32,
        end_height: f32,
        revolutions: f32,
    ) -> Vec<Vec3> {
        const NUM_POINTS: usize = 60;
        let mut points = Vec::with_capacity(NUM_POINTS + 1);
        
        for i in 0..=NUM_POINTS {
            let t = i as f32 / NUM_POINTS as f32;
            let angle = t * revolutions * std::f32::consts::TAU;
            let radius = start_radius + (end_radius - start_radius) * t;
            let height = start_height + (end_height - start_height) * t;
            
            let (sin, cos) = angle.sin_cos(); // Optimize trig calls
            points.push(Vec3::new(
                center.x + cos * radius,
                center.y + height,
                center.z + sin * radius,
            ));
        }
        
        points
    }
    
    /// Start spiral camera animation
    pub fn animate_spiral_approach(
        &mut self,
        center: Vec3,
        start_radius: f32,
        end_radius: f32,
        start_height: f32,
        end_height: f32,
        duration: Duration,
    ) -> Result<oneshot::Receiver<()>> {
        let path = self.generate_spiral_path(
            center,
            start_radius,
            end_radius,
            start_height,
            end_height,
            1.5, // 1.5 revolutions
        );
        
        self.current_path = Some(Arc::new(path));
        self.path_progress.set(0.0);
        self.is_animating.set(true);
        
        // Create completion channel
        let (tx, rx) = oneshot::channel();
        
        // Add tween for path progress with completion callback
        self.tween_engine.add_f32("path_progress", 0.0, 1.0, duration)?
            .with_easing(Easing::CubicOut);
        
        self.tween_engine.on_complete("path_progress", move || {
            let _ = tx.send(());
        });
        
        Ok(rx)
    }
    
    /// Update position along path
    fn update_path_animation(&self, path: Arc<Vec<Vec3>>) -> Result<()> {
        if path.is_empty() {
            return Ok(());
        }
        
        let progress = self.path_progress.get();
        let total_segments = path.len() - 1;
        let float_index = progress * total_segments as f32;
        let current_index = float_index.floor() as usize;
        let local_t = float_index.fract();
        
        if current_index < total_segments {
            // Interpolate position
            let current_pos = path[current_index];
            let next_pos = path[current_index + 1];
            self.position.set(current_pos.lerp(next_pos, local_t));
            
            // Calculate look-ahead target
            let look_ahead_distance = usize::min(3, total_segments - current_index);
            let target_index = current_index + look_ahead_distance;
            
            let target_pos = if target_index < path.len() {
                let current = path[current_index];
                let target = path[target_index];
                current.lerp(target, self.look_ahead_factor)
            } else {
                path[path.len() - 1]
            };
            
            self.target.set(target_pos);
        }
        
        Ok(())
    }
    
    /// Transition to overview position
    pub async fn transition_to_overview(&mut self, duration: Duration) -> Result<()> {
        let start_pos = self.position.get();
        let start_target = self.target.get();
        
        // Add position tween
        self.tween_engine.add_vec3("overview_pos", start_pos, self.overview_position, duration)?
            .with_easing(Easing::CubicInOut);
        
        // Add target tween  
        self.tween_engine.add_vec3("overview_target", start_target, self.overview_target, duration)?
            .with_easing(Easing::CubicInOut);
        
        // Create completion future
        let (tx, rx) = oneshot::channel();
        let completion_sent = Arc::new(std::sync::Mutex::new(false));
        let completion_sent_clone = completion_sent.clone();
        
        self.tween_engine.on_complete("overview_pos", move || {
            let mut sent = completion_sent_clone.lock().unwrap();
            if !*sent {
                let _ = tx.send(());
                *sent = true;
            }
        });
        
        // Drive animation until complete
        let mut last_update = std::time::Instant::now();
        loop {
            // Check if complete
            if rx.try_recv().is_ok() {
                break;
            }
            
            // Update animation
            let now = std::time::Instant::now();
            let dt = now - last_update;
            last_update = now;
            
            self.update(dt)?;
            
            // Apply tween values
            if let Some(pos) = self.tween_engine.get_vec3("overview_pos") {
                self.position.set(pos);
            }
            if let Some(target) = self.tween_engine.get_vec3("overview_target") {
                self.target.set(target);
            }
            
            // Small yield to prevent busy-wait
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        
        Ok(())
    }
    
    /// Start intro sequence
    pub fn start_intro_sequence(&mut self, maze_center: Vec3, maze_radius: f32) -> Result<()> {
        let intro_height = maze_radius * 3.0;
        let intro_position = Vec3::new(
            maze_center.x + maze_radius * 0.5,
            maze_center.y + intro_height,
            maze_center.z + maze_radius * 0.5,
        );
        
        self.position.set(intro_position);
        self.target.set(maze_center);
        
        // Start spiral animation
        self.animate_spiral_approach(
            maze_center,
            maze_radius * 2.0,
            maze_radius * 1.2,
            intro_height,
            maze_radius * 0.8,
            Duration::from_millis(5000),
        )?;
        
        Ok(())
    }
    
    /// Get current camera matrices
    pub fn get_view_components(&self) -> (Vec3, Vec3, Vec3) {
        (self.position.get(), self.target.get(), self.up.get())
    }
    
    /// Set field of view
    pub fn set_fov(&mut self, fov: f32, animate: bool, duration: Duration) -> Result<()> {
        if animate {
            let current = self.fov.get();
            self.tween_engine.add_f32("fov", current, fov, duration)?
                .with_easing(Easing::CubicOut);
        } else {
            self.fov.set(fov);
        }
        Ok(())
    }
    
    pub fn is_animating(&self) -> bool {
        self.is_animating.get()
    }
}

impl Default for CameraAnimator {
    fn default() -> Self {
        Self::new()
    }
}