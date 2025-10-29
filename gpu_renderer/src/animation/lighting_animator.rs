// animation/lighting_animator.rs - Safe, production-ready lighting animation

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;
use std::cell::Cell;
use std::sync::Arc;
use std::time::{Duration, Instant};
use super::{AnimationState, TweenGroup, Vec3, Easing, Result};

/// Spotlight structure matching WGSL layout
#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct SpotLight {
    pub position: [f32; 3],
    pub _pad0: f32,
    pub direction: [f32; 3],
    pub _pad1: f32,
    pub color: [f32; 3],
    pub intensity: f32,
    pub inner_cone_angle: f32,
    pub outer_cone_angle: f32,
    pub range: f32,
    pub _pad2: f32,
}

impl Default for SpotLight {
    fn default() -> Self {
        Self {
            position: [0.0, 0.0, 0.0],
            _pad0: 0.0,
            direction: [0.0, -1.0, 0.0],
            _pad1: 0.0,
            color: [1.0, 1.0, 1.0],
            intensity: 1.0,
            inner_cone_angle: 0.5,
            outer_cone_angle: 0.7,
            range: 10.0,
            _pad2: 0.0,
        }
    }
}

/// Lighting uniforms for GPU
#[repr(C, align(16))]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct LightingUniforms {
    pub num_spotlights: u32,
    pub _pad0: [u32; 3],
    pub spotlights: [SpotLight; 8],
    pub time: f32,
    pub animation_state: u32,
    pub _pad1: [u32; 2],
}

impl Default for LightingUniforms {
    fn default() -> Self {
        Self {
            num_spotlights: 0,
            _pad0: [0; 3],
            spotlights: [SpotLight::default(); 8],
            time: 0.0,
            animation_state: 0,
            _pad1: [0; 2],
        }
    }
}

/// Dynamic lighting animator
pub struct LightingAnimator {
    // GPU resources
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    lighting_buffer: wgpu::Buffer,
    lighting_bind_group: Option<wgpu::BindGroup>,
    lighting_bind_group_layout: wgpu::BindGroupLayout,
    
    // Animation state
    uniforms: LightingUniforms,
    current_state: AnimationState,
    tween_engine: TweenGroup,
    
    // Per-light intensity for smooth transitions
    light_intensities: Vec<Cell<f32>>,
    
    // Animation parameters
    light_radius: f32,
    light_height: f32,
    primary_freq: f32,
    secondary_freq: f32,
    tertiary_freq: f32,
    
    // Timing
    start_time: Instant,
    maze_center: Vec3,
    
    // Dirty flag for GPU updates
    needs_gpu_update: Cell<bool>,
}

impl LightingAnimator {
    pub fn new(device: Arc<wgpu::Device>, queue: Arc<wgpu::Queue>) -> Self {
        let lighting_bind_group_layout = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("Lighting BGL"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: Some(
                                std::num::NonZeroU64::new(
                                    std::mem::size_of::<LightingUniforms>() as u64
                                ).unwrap()
                            ),
                        },
                        count: None,
                    },
                ],
            }
        );
        
        let lighting_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Lighting Uniforms"),
            contents: bytemuck::bytes_of(&LightingUniforms::default()),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        
        Self {
            device,
            queue,
            lighting_buffer,
            lighting_bind_group: None,
            lighting_bind_group_layout,
            uniforms: LightingUniforms::default(),
            current_state: AnimationState::Intro,
            tween_engine: TweenGroup::new(),
            light_intensities: (0..8).map(|_| Cell::new(1.0)).collect(),
            light_radius: 15.0,
            light_height: 8.0,
            primary_freq: 0.0015,
            secondary_freq: 0.0025,
            tertiary_freq: 0.001,
            start_time: Instant::now(),
            maze_center: Vec3::zero(),
            needs_gpu_update: Cell::new(true),
        }
    }
    
    /// Initialize lighting system
    pub fn initialize(&mut self, maze_center: Vec3) {
        self.maze_center = maze_center;
        self.setup_default_lights();
        self.create_bind_group();
        self.needs_gpu_update.set(true);
    }
    
    fn setup_default_lights(&mut self) {
        self.uniforms.num_spotlights = 4;
        
        for i in 0..4 {
            let phase_offset = i as f32 * std::f32::consts::FRAC_PI_2;
            let (sin, cos) = phase_offset.sin_cos();
            
            self.uniforms.spotlights[i] = SpotLight {
                position: [
                    self.maze_center.x + cos * self.light_radius,
                    self.light_height,
                    self.maze_center.z + sin * self.light_radius,
                ],
                direction: [0.0, -1.0, 0.0],
                color: [1.0, 0.95, 0.9],
                intensity: 1.5,
                inner_cone_angle: 0.3,
                outer_cone_angle: 0.5,
                range: 30.0,
                ..Default::default()
            };
            
            self.light_intensities[i].set(1.5);
        }
    }
    
    fn create_bind_group(&mut self) {
        self.lighting_bind_group = Some(
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Lighting Bind Group"),
                layout: &self.lighting_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.lighting_buffer.as_entire_binding(),
                    },
                ],
            })
        );
    }
    
    /// Update lighting animation
    pub fn update(&mut self, dt: Duration) -> Result<()> {
        // Update tweens
        self.tween_engine.update(dt);
        
        // Update time
        let current_time = self.start_time.elapsed().as_secs_f32();
        self.uniforms.time = current_time;
        self.uniforms.animation_state = self.current_state as u32;
        
        // Update light intensities from tweens
        for i in 0..self.uniforms.num_spotlights as usize {
            let tween_id = format!("light_{}_intensity", i);
            if let Some(intensity) = self.tween_engine.get_f32(&tween_id) {
                self.light_intensities[i].set(intensity);
                self.needs_gpu_update.set(true);
            }
        }
        
        // Update lighting based on state
        match self.current_state {
            AnimationState::Intro => self.update_intro_lighting(current_time),
            AnimationState::Solving => self.update_solving_lighting(current_time),
            AnimationState::Solved => self.update_solved_lighting(current_time),
        }
        
        // Write to GPU if needed
        if self.needs_gpu_update.get() {
            self.queue.write_buffer(
                &self.lighting_buffer,
                0,
                bytemuck::bytes_of(&self.uniforms),
            );
            self.needs_gpu_update.set(false);
        }
        
        Ok(())
    }
    
    fn update_intro_lighting(&mut self, time: f32) {
        let intro_multiplier = 2.0;
        
        for i in 0..self.uniforms.num_spotlights as usize {
            let phase_offset = i as f32 * std::f32::consts::FRAC_PI_2;
            
            let primary_angle = time * self.primary_freq * intro_multiplier + phase_offset;
            let secondary_angle = time * self.secondary_freq * intro_multiplier + phase_offset;
            let tertiary_angle = time * self.tertiary_freq * intro_multiplier + phase_offset;
            
            // Use sin_cos for efficiency
            let (sp, cp) = primary_angle.sin_cos();
            let (ss, cs) = secondary_angle.sin_cos();
            let (st, _) = tertiary_angle.sin_cos();
            
            let x = cp * self.light_radius + cs * (self.light_radius * 0.3);
            let z = sp * self.light_radius + ss * (self.light_radius * 0.3);
            let y = self.light_height + st * (self.light_height * 0.2);
            
            self.uniforms.spotlights[i].position = [
                self.maze_center.x + x,
                y,
                self.maze_center.z + z,
            ];
            
            // Safe direction calculation with epsilon
            let len_sq = x * x + z * z;
            let (dir_x, dir_z) = if len_sq > 1e-6 {
                let inv_len = 1.0 / len_sq.sqrt();
                (-x * inv_len, -z * inv_len)
            } else {
                (0.0, -1.0)
            };
            
            self.uniforms.spotlights[i].direction = [dir_x, -0.5, dir_z];
            
            // Apply tweened intensity
            self.uniforms.spotlights[i].intensity = self.light_intensities[i].get();
            
            // Pulsing effect
            let pulse = 0.5 + 0.5 * (time * 2.0 + phase_offset).sin();
            self.uniforms.spotlights[i].intensity *= (1.0 + pulse * 0.5);
        }
        
        self.needs_gpu_update.set(true);
    }
    
    fn update_solving_lighting(&mut self, time: f32) {
        for i in 0..self.uniforms.num_spotlights as usize {
            let phase_offset = i as f32 * std::f32::consts::FRAC_PI_2;
            
            let primary_angle = time * self.primary_freq + phase_offset;
            let secondary_angle = time * self.secondary_freq + phase_offset;
            let tertiary_angle = time * self.tertiary_freq + phase_offset;
            
            let (sp, cp) = primary_angle.sin_cos();
            let (ss, cs) = secondary_angle.sin_cos();
            let (st, _) = tertiary_angle.sin_cos();
            
            let x = cp * self.light_radius + cs * (self.light_radius * 0.3);
            let z = sp * self.light_radius + ss * (self.light_radius * 0.3);
            let y = self.light_height + st * (self.light_height * 0.2);
            
            self.uniforms.spotlights[i].position = [
                self.maze_center.x + x,
                y,
                self.maze_center.z + z,
            ];
            
            let len_sq = x * x + z * z;
            if len_sq > 1e-6 {
                let inv_len = 1.0 / len_sq.sqrt();
                self.uniforms.spotlights[i].direction = [-x * inv_len, -0.5, -z * inv_len];
            }
            
            self.uniforms.spotlights[i].intensity = self.light_intensities[i].get();
        }
        
        self.needs_gpu_update.set(true);
    }
    
    fn update_solved_lighting(&mut self, time: f32) {
        let solved_multiplier = 0.5;
        
        for i in 0..self.uniforms.num_spotlights as usize {
            let phase_offset = i as f32 * std::f32::consts::FRAC_PI_2;
            
            let primary_angle = time * self.primary_freq * solved_multiplier + phase_offset;
            let secondary_angle = time * self.secondary_freq * solved_multiplier + phase_offset;
            let tertiary_angle = time * self.tertiary_freq * solved_multiplier + phase_offset;
            
            let (sp, cp) = primary_angle.sin_cos();
            let (ss, cs) = secondary_angle.sin_cos();
            let (st, _) = tertiary_angle.sin_cos();
            
            let x = cp * self.light_radius + cs * (self.light_radius * 0.3);
            let z = sp * self.light_radius + ss * (self.light_radius * 0.3);
            let y = self.light_height + st * (self.light_height * 0.2);
            
            self.uniforms.spotlights[i].position = [
                self.maze_center.x + x,
                y,
                self.maze_center.z + z,
            ];
            
            let len_sq = x * x + z * z;
            if len_sq > 1e-6 {
                let inv_len = 1.0 / len_sq.sqrt();
                self.uniforms.spotlights[i].direction = [-x * inv_len, -0.3, -z * inv_len];
            }
            
            // Golden glow
            self.uniforms.spotlights[i].color = [1.0, 0.9, 0.7];
            self.uniforms.spotlights[i].intensity = self.light_intensities[i].get() * 1.3;
        }
        
        self.needs_gpu_update.set(true);
    }
    
    /// Start solving lighting with smooth transition
    pub fn start_solving_lighting(&mut self) -> Result<()> {
        self.current_state = AnimationState::Solving;
        
        // Smooth intensity transitions
        for i in 0..self.uniforms.num_spotlights as usize {
            let current = self.light_intensities[i].get();
            let tween_id = format!("light_{}_intensity", i);
            
            self.tween_engine.add_f32(&tween_id, current, 1.5, Duration::from_millis(800))?
                .with_easing(Easing::CubicOut);
        }
        
        Ok(())
    }
    
    pub fn start_intro_lighting(&mut self) {
        self.current_state = AnimationState::Intro;
    }
    
    pub fn stop_intro_lighting(&mut self) {
        self.tween_engine.clear();
    }
    
    pub fn start_solved_lighting(&mut self) -> Result<()> {
        self.current_state = AnimationState::Solved;
        
        // Transition to golden glow
        for i in 0..self.uniforms.num_spotlights as usize {
            let current = self.light_intensities[i].get();
            let tween_id = format!("light_{}_intensity", i);
            
            self.tween_engine.add_f32(&tween_id, current, 2.0, Duration::from_millis(1000))?
                .with_easing(Easing::CubicInOut);
        }
        
        Ok(())
    }
    
    pub fn get_bind_group_layout(&self) -> &wgpu::BindGroupLayout {
        &self.lighting_bind_group_layout
    }
    
    pub fn get_bind_group(&self) -> Option<&wgpu::BindGroup> {
        self.lighting_bind_group.as_ref()
    }
    
    pub fn get_uniforms(&self) -> &LightingUniforms {
        &self.uniforms
    }
}