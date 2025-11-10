// animated_renderer.rs - Animated path tracer with Three.js animation system integration

use anyhow::{Context, Result};
use bytemuck::{Pod, Zeroable};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;

use crate::animation::{
    AnimationOrchestrator, LightingAnimator, CameraAnimator, PathAnimator,
    AnimationState, Vec3, OrchestratorBuilder, MazeSolution, PathData, PathPoint,
};
use crate::{Args, MazeData, PathTracer, Uniforms};

/// Enhanced path tracer with integrated animation systems
/// This extends the basic PathTracer with dynamic lighting, camera animation, and path sequencing
pub struct AnimatedPathTracer {
    // Core path tracing components
    base_tracer: PathTracer,

    // Animation orchestrator managing all animation systems
    orchestrator: AnimationOrchestrator,

    // Animation state
    is_animation_enabled: bool,
    animation_start_time: Instant,
    last_update_time: Instant,
}

impl AnimatedPathTracer {
    /// Create new animated path tracer with Three.js animation system integration
    pub async fn new(width: u32, height: u32) -> Result<Self> {
        // Create default args for streaming mode
        let args = Args::default_for_streaming(width, height);
        Self::new_with_args(width, height, &args).await
    }

    /// Create new animated path tracer with specified args
    pub async fn new_with_args(width: u32, height: u32, args: &Args) -> Result<Self> {
        // Create base path tracer
        let base_tracer = PathTracer::new(width, height, args).await?;

        // Create animation systems
        let lighting_animator = LightingAnimator::new(
            base_tracer.device.clone(),
            base_tracer.queue.clone(),
        );

        let camera_animator = CameraAnimator::new();
        let path_animator = PathAnimator::new();

        // Build orchestrator with Three.js timing
        let orchestrator = OrchestratorBuilder::new()
            .intro_duration(5000)      // 5 second intro
            .transition_duration(2000) // 2 second transitions
            .validation_delay(200)     // 200ms between component validations
            .build(lighting_animator, camera_animator, path_animator);

        let now = Instant::now();

        Ok(Self {
            base_tracer,
            orchestrator,
            is_animation_enabled: args.animated,
            animation_start_time: now,
            last_update_time: now,
        })
    }

    /// Initialize with maze data and start animation sequence
    pub fn initialize_with_maze(&mut self, maze: &MazeData) -> Result<()> {
        // Load maze into base tracer
        self.base_tracer.load_maze(maze)?;

        if self.is_animation_enabled {
            // Calculate maze center and radius for animation system
            let (center, radius) = self.calculate_maze_bounds(maze);

            // Initialize animation orchestrator
            self.orchestrator.initialize(center, radius)
                .map_err(|e| anyhow::anyhow!("Failed to initialize animation orchestrator: {:?}", e))?;

            // Start intro sequence
            self.orchestrator.start_intro_sequence()
                .map_err(|e| anyhow::anyhow!("Failed to start intro sequence: {:?}", e))?;
        }

        Ok(())
    }

    /// Update animation systems and render frame
    pub fn update_and_render(&mut self) -> Result<()> {
        let current_time = Instant::now();
        let dt = current_time.duration_since(self.last_update_time);
        self.last_update_time = current_time;

        if self.is_animation_enabled {
            // Update animation systems
            self.orchestrator.update(dt);

            // Update camera uniforms from animation system
            let (position, target, up) = self.orchestrator.get_camera_view();
            self.update_camera_uniforms(position, target, up);
        }

        // Render frame with current state
        self.base_tracer.render_frame()
    }

    /// Calculate maze bounds for animation system initialization
    fn calculate_maze_bounds(&self, maze: &MazeData) -> (Vec3, f32) {
        if maze.cells.is_empty() {
            return (Vec3::zero(), 10.0);
        }

        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_z = f32::INFINITY;
        let mut max_z = f32::NEG_INFINITY;
        let mut avg_y = 0.0;

        for cell in &maze.cells {
            min_x = min_x.min(cell.center.x);
            max_x = max_x.max(cell.center.x);
            min_z = min_z.min(cell.center.z);
            max_z = max_z.max(cell.center.z);
            avg_y += cell.center.y;
        }

        avg_y /= maze.cells.len() as f32;

        let center = Vec3::new(
            (min_x + max_x) * 0.5,
            avg_y,
            (min_z + max_z) * 0.5,
        );

        let radius = ((max_x - min_x).powi(2) + (max_z - min_z).powi(2)).sqrt() * 0.5;

        (center, radius)
    }

    /// Update camera uniforms from animation system
    fn update_camera_uniforms(&mut self, position: Vec3, target: Vec3, up: Vec3) {
        // Update base tracer's camera uniforms
        self.base_tracer.uniforms.camera_position = [position.x, position.y, position.z];

        let direction = (target - position).normalize();
        self.base_tracer.uniforms.camera_direction = [direction.x, direction.y, direction.z];
        self.base_tracer.uniforms.camera_up = [up.x, up.y, up.z];
    }

    /// Transition from intro to solving state
    pub async fn finish_intro_and_start_solving(&mut self) -> Result<()> {
        if !self.is_animation_enabled {
            return Ok(());
        }

        self.orchestrator.finish_intro_animation().await
            .map_err(|e| anyhow::anyhow!("Failed to finish intro animation: {:?}", e))
    }

    /// Animate maze solution with path elevation
    pub async fn animate_solution(&mut self, solution_paths: Vec<PathData>) -> Result<()> {
        if !self.is_animation_enabled {
            return Ok(());
        }

        // Create solution structure
        let component_data = vec![
            ("solution".to_string(), solution_paths, true)
        ];
        let solution = AnimationOrchestrator::create_solution_from_paths(component_data);

        // Animate the solution
        self.orchestrator.validate_and_raise_solved_components(solution).await
            .map_err(|e| anyhow::anyhow!("Failed to animate solution: {:?}", e))
    }

    /// Convert maze cells to path data for animation
    pub fn create_solution_from_maze(&self, maze: &MazeData) -> Vec<PathData> {
        if let Some(ref solution_ids) = maze.solution {
            // Filter cells that are part of the solution
            let solution_cells: Vec<_> = maze.cells.iter()
                .filter(|cell| solution_ids.contains(&cell.id))
                .collect();

            // Convert to path points
            let path_points = AnimationOrchestrator::maze_cells_to_path_points(&solution_cells);

            // Create single path data for the solution
            vec![PathData::new(path_points, "maze_solution".to_string(), true)]
        } else {
            vec![]
        }
    }

    /// Check if animations are currently running
    pub fn is_animating(&self) -> bool {
        self.is_animation_enabled && self.orchestrator.is_animating()
    }

    /// Get current animation state
    pub fn get_animation_state(&self) -> AnimationState {
        if self.is_animation_enabled {
            self.orchestrator.get_current_state()
        } else {
            AnimationState::Solved // Default to solved if not animated
        }
    }

    /// Force animation state transition (for testing/debugging)
    pub fn force_animation_state(&mut self, state: AnimationState) {
        if self.is_animation_enabled {
            self.orchestrator.force_state_transition(state);
        }
    }

    /// Save current frame to PNG - delegates to base tracer
    pub async fn save_image<P: AsRef<std::path::Path>>(&self, path: P) -> Result<()> {
        self.base_tracer.save_image(path).await
    }

    /// Save current frame to buffer - delegates to base tracer
    pub async fn save_image_to_buffer(&self) -> Result<Vec<u8>> {
        self.base_tracer.save_image_to_buffer().await
    }

    /// Get total accumulated samples
    pub fn get_sample_count(&self) -> u32 {
        self.base_tracer.sample_count
    }

    /// Get maximum samples target
    pub fn get_max_samples(&self) -> u32 {
        self.base_tracer.max_samples
    }

    /// Get animation elapsed time
    pub fn get_animation_elapsed(&self) -> Duration {
        self.animation_start_time.elapsed()
    }

    /// Enable/disable animation system at runtime
    pub fn set_animation_enabled(&mut self, enabled: bool) {
        self.is_animation_enabled = enabled;
        if !enabled {
            // When disabling animations, transition to a stable solved state
            self.orchestrator.force_state_transition(AnimationState::Solved);
        }
    }

    // ============= STREAMING INTERFACE =============

    /// Start animation with maze and solution data (WebSocket streaming interface)
    pub async fn start_animation(&mut self, maze_data: crate::MazeData, solution_data: serde_json::Value) -> Result<()> {
        // Initialize with maze data
        self.initialize_with_maze(&maze_data)?;

        // Parse solution data and start animation sequence
        if let Ok(solution_paths) = self.parse_solution_data(solution_data) {
            // Start intro, then transition to solving, then animate solution
            tokio::spawn(async move {
                // Wait for intro to complete (handled by orchestrator)
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
        }

        self.is_animation_enabled = true;
        self.animation_start_time = Instant::now();
        self.last_update_time = Instant::now();

        Ok(())
    }

    /// Get next animation frame as RGBA bytes (WebSocket streaming interface)
    pub async fn next_frame(&mut self) -> Option<Vec<u8>> {
        if !self.is_animation_enabled {
            return None;
        }

        // Update animation systems
        if let Err(e) = self.update_and_render() {
            log::error!("Animation update failed: {}", e);
            return None;
        }

        // Extract frame data as RGBA bytes
        match self.base_tracer.get_frame_data().await {
            Ok(frame_data) => Some(frame_data),
            Err(e) => {
                log::error!("Failed to get frame data: {}", e);
                None
            }
        }
    }

    /// Parse solution data from various formats
    fn parse_solution_data(&self, solution_data: serde_json::Value) -> Result<Vec<PathData>> {
        // Handle different solution data formats from frontend
        match solution_data {
            serde_json::Value::Array(paths) => {
                let mut path_data = Vec::new();

                for (i, path) in paths.iter().enumerate() {
                    if let serde_json::Value::Array(points) = path {
                        let mut path_points = Vec::new();

                        for point in points {
                            if let serde_json::Value::String(cell_id) = point {
                                // Convert cell ID to path point (simplified)
                                let path_point = PathPoint {
                                    cell_id: cell_id.clone(),
                                    position: Vec3::new(0.0, 0.0, 0.0), // Would be calculated from maze
                                    elevation: 0.0,
                                };
                                path_points.push(path_point);
                            }
                        }

                        if !path_points.is_empty() {
                            path_data.push(PathData::new(
                                path_points,
                                format!("component_{}", i),
                                true
                            ));
                        }
                    }
                }

                Ok(path_data)
            }
            _ => Ok(vec![]) // Return empty if can't parse
        }
    }
}

// Implement delegation pattern for common PathTracer functionality
impl std::ops::Deref for AnimatedPathTracer {
    type Target = PathTracer;

    fn deref(&self) -> &Self::Target {
        &self.base_tracer
    }
}

impl std::ops::DerefMut for AnimatedPathTracer {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.base_tracer
    }
}