// animation/orchestrator.rs - Animation orchestration layer
// Ports Three.js maze-scene-manager.ts coordination functionality to Rust

use std::time::Duration;
use super::{
    AnimationState, Vec3, AnimationError,
    LightingAnimator, CameraAnimator, PathAnimator,
    PathData, PathPoint,
};

/// Component data matching Three.js solved component structure
#[derive(Debug, Clone)]
pub struct SolvedComponent {
    pub component_id: String,
    pub paths: Vec<PathData>,
    pub is_solution: bool,
}

/// Maze solution structure matching Three.js MazeSolution
#[derive(Debug, Clone)]
pub struct MazeSolution {
    pub solved_components: Vec<SolvedComponent>,
    pub total_paths: usize,
    pub solution_path_ids: Vec<String>,
}

/// Main orchestrator - coordinates all animation systems
/// Ports the coordination logic from Three.js maze-scene-manager.ts
pub struct AnimationOrchestrator {
    // Animation systems
    lighting_animator: LightingAnimator,
    camera_animator: CameraAnimator,
    path_animator: PathAnimator,

    // State management
    current_state: AnimationState,
    maze_center: Vec3,
    maze_radius: f32,
    is_initialized: bool,

    // Animation timing - EXACT values from Three.js
    intro_duration_ms: u64,          // Duration of intro sequence
    transition_duration_ms: u64,     // Duration of state transitions
    validation_delay_ms: u64,        // 200ms delay between component validations
}

impl AnimationOrchestrator {
    pub fn new(
        lighting_animator: LightingAnimator,
        camera_animator: CameraAnimator,
        path_animator: PathAnimator,
    ) -> Self {
        Self {
            lighting_animator,
            camera_animator,
            path_animator,
            current_state: AnimationState::Intro,
            maze_center: Vec3::zero(),
            maze_radius: 10.0,
            is_initialized: false,

            // EXACT timing values from Three.js
            intro_duration_ms: 5000,        // 5 second intro
            transition_duration_ms: 2000,   // 2 second transitions
            validation_delay_ms: 200,       // 200ms between validations
        }
    }

    /// Initialize orchestrator with maze geometry
    pub fn initialize(&mut self, maze_center: Vec3, maze_radius: f32) -> Result<(), AnimationError> {
        if self.is_initialized {
            return Err(AnimationError::InvalidParameters("Already initialized".to_string()));
        }

        self.maze_center = maze_center;
        self.maze_radius = maze_radius;

        // Initialize all animation systems
        self.lighting_animator.initialize(maze_center);
        self.camera_animator.initialize(maze_center, maze_radius);

        // Set elevation callback for path animator
        self.path_animator.set_elevation_callback({
            move |point_id: &str, height: f32| {
                // In a real implementation, this would update the GPU buffer
                // For now, we just log the elevation change
                log::debug!("Elevating point {} to height {}", point_id, height);
            }
        });

        self.is_initialized = true;
        Ok(())
    }

    /// Update all animation systems - call every frame
    pub fn update(&mut self, dt: Duration) {
        if !self.is_initialized {
            return;
        }

        // Update all animation systems
        self.lighting_animator.update(dt);
        self.camera_animator.update(dt);
        self.path_animator.update(dt);
    }

    /// Start intro animation sequence - EXACT port of Three.js intro sequence
    pub fn start_intro_sequence(&mut self) -> Result<(), AnimationError> {
        if !self.is_initialized {
            return Err(AnimationError::NotInitialized);
        }

        self.current_state = AnimationState::Intro;

        // Start intro lighting
        self.lighting_animator.start_intro_lighting();

        // Start intro camera sequence
        self.camera_animator.start_intro_sequence(self.maze_center, self.maze_radius);

        Ok(())
    }

    /// Finish intro animation and transition to solving - ports finishIntroAnimation()
    pub async fn finish_intro_animation(&mut self) -> Result<(), AnimationError> {
        if self.current_state != AnimationState::Intro {
            return Err(AnimationError::InvalidParameters("Not in intro state".to_string()));
        }

        // Stop intro lighting
        self.lighting_animator.stop_intro_lighting();

        // Transition camera to overview - matches Three.js transitionToOverview()
        self.camera_animator
            .transition_to_overview(Duration::from_millis(self.transition_duration_ms))
            .await?;

        // Start solving lighting
        self.lighting_animator.start_solving_lighting();

        self.current_state = AnimationState::Solving;

        Ok(())
    }

    /// Validate and animate solved components - ports validateAndRaiseSolvedComponents()
    pub async fn validate_and_raise_solved_components(
        &mut self,
        solution: MazeSolution
    ) -> Result<(), AnimationError> {
        if self.current_state != AnimationState::Solving {
            return Err(AnimationError::InvalidParameters("Not in solving state".to_string()));
        }

        // Create animation promises for all components - matches Three.js logic
        let mut animation_futures = Vec::new();

        for (index, component) in solution.solved_components.iter().enumerate() {
            // Calculate delay for this component - EXACT timing from Three.js
            let delay_ms = index as u64 * self.validation_delay_ms;

            // Clone component data for async task
            let component_paths = component.paths.clone();

            // Create delayed animation task
            let future = async move {
                // Wait for the scheduled delay
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;

                // This would be handled by path_animator in the actual integration
                // For now, we simulate the animation completion
                tokio::time::sleep(Duration::from_millis(800)).await; // Elevation duration

                Ok(())
            };

            animation_futures.push(future);
        }

        // Wait for all component animations to complete - matches Promise.all() in Three.js
        let results: Result<Vec<_>, _> = futures::future::try_join_all(animation_futures).await;
        results.map_err(|_: ()| AnimationError::CallbackError(
            "Component validation animation failed".to_string()
        ))?;

        // Transition to solved state
        self.current_state = AnimationState::Solved;
        self.lighting_animator.start_solved_lighting();

        Ok(())
    }

    /// Animate single path component - matches animateComponent()
    pub async fn animate_component(&mut self, component_paths: Vec<PathData>) -> Result<(), AnimationError> {
        self.path_animator.animate_component_async(component_paths).await
    }

    /// Animate multiple path components sequentially - matches animatePathSequentially()
    pub async fn animate_paths_sequentially(&mut self, paths: Vec<PathData>) -> Result<(), AnimationError> {
        // Use EXACT delay from Three.js - 500ms between paths
        let delay_ms = 500;

        for path_data in paths {
            self.path_animator.animate_single_path_async(path_data).await?;

            // Delay before next path - matches Three.js setTimeout
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }

        Ok(())
    }

    /// Get current animation state
    pub fn get_current_state(&self) -> AnimationState {
        self.current_state
    }

    /// Check if any animations are active
    pub fn is_animating(&self) -> bool {
        self.camera_animator.is_animating() || self.path_animator.is_animating()
    }

    /// Get camera view components for rendering
    pub fn get_camera_view(&self) -> (Vec3, Vec3, Vec3) {
        self.camera_animator.get_view_components()
    }

    /// Get lighting bind group for rendering
    pub fn get_lighting_bind_group(&self) -> Option<&wgpu::BindGroup> {
        self.lighting_animator.get_bind_group()
    }

    /// Get lighting uniforms for debugging
    pub fn get_lighting_uniforms(&self) -> &super::LightingUniforms {
        self.lighting_animator.get_uniforms()
    }

    /// Force transition to specific state (for testing/debugging)
    pub fn force_state_transition(&mut self, new_state: AnimationState) {
        self.current_state = new_state;

        match new_state {
            AnimationState::Intro => {
                self.lighting_animator.start_intro_lighting();
            },
            AnimationState::Solving => {
                self.lighting_animator.start_solving_lighting();
            },
            AnimationState::Solved => {
                self.lighting_animator.start_solved_lighting();
            },
        }
    }

    /// Set custom timing parameters
    pub fn set_timing_parameters(
        &mut self,
        intro_duration_ms: u64,
        transition_duration_ms: u64,
        validation_delay_ms: u64,
    ) {
        self.intro_duration_ms = intro_duration_ms;
        self.transition_duration_ms = transition_duration_ms;
        self.validation_delay_ms = validation_delay_ms;
    }

    /// Create maze solution from path data (utility function)
    pub fn create_solution_from_paths(
        component_paths: Vec<(String, Vec<PathData>, bool)>  // (component_id, paths, is_solution)
    ) -> MazeSolution {
        let mut solved_components = Vec::new();
        let mut total_paths = 0;
        let mut solution_path_ids = Vec::new();

        for (component_id, paths, is_solution) in component_paths {
            total_paths += paths.len();

            if is_solution {
                for path in &paths {
                    for point in &path.points {
                        solution_path_ids.push(point.id.clone());
                    }
                }
            }

            solved_components.push(SolvedComponent {
                component_id,
                paths,
                is_solution,
            });
        }

        MazeSolution {
            solved_components,
            total_paths,
            solution_path_ids,
        }
    }

    /// Convert maze data to path points (utility function)
    pub fn maze_cells_to_path_points(cells: &[crate::MazeCell]) -> Vec<PathPoint> {
        cells.iter().map(|cell| {
            PathPoint::new(
                Vec3::new(cell.center.x, cell.center.y, cell.center.z),
                cell.id.clone()
            )
        }).collect()
    }
}

/// Builder pattern for orchestrator configuration
pub struct OrchestratorBuilder {
    intro_duration_ms: u64,
    transition_duration_ms: u64,
    validation_delay_ms: u64,
}

impl OrchestratorBuilder {
    pub fn new() -> Self {
        Self {
            intro_duration_ms: 5000,
            transition_duration_ms: 2000,
            validation_delay_ms: 200,
        }
    }

    pub fn intro_duration(mut self, duration_ms: u64) -> Self {
        self.intro_duration_ms = duration_ms;
        self
    }

    pub fn transition_duration(mut self, duration_ms: u64) -> Self {
        self.transition_duration_ms = duration_ms;
        self
    }

    pub fn validation_delay(mut self, delay_ms: u64) -> Self {
        self.validation_delay_ms = delay_ms;
        self
    }

    pub fn build(
        self,
        lighting_animator: LightingAnimator,
        camera_animator: CameraAnimator,
        path_animator: PathAnimator,
    ) -> AnimationOrchestrator {
        let mut orchestrator = AnimationOrchestrator::new(
            lighting_animator,
            camera_animator,
            path_animator,
        );

        orchestrator.set_timing_parameters(
            self.intro_duration_ms,
            self.transition_duration_ms,
            self.validation_delay_ms,
        );

        orchestrator
    }
}

impl Default for OrchestratorBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_solution_creation() {
        let component_data = vec![
            ("comp1".to_string(), vec![], true),
            ("comp2".to_string(), vec![], false),
        ];

        let solution = AnimationOrchestrator::create_solution_from_paths(component_data);
        assert_eq!(solution.solved_components.len(), 2);
        assert_eq!(solution.total_paths, 0);
    }

    #[test]
    fn test_orchestrator_builder() {
        let builder = OrchestratorBuilder::new()
            .intro_duration(3000)
            .validation_delay(150);

        // In a real test, we'd create actual animators
        // This is just testing the builder pattern
        assert_eq!(builder.intro_duration_ms, 3000);
        assert_eq!(builder.validation_delay_ms, 150);
    }
}