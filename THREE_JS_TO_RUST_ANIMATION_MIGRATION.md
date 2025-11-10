# Three.js to Rust WGPU Animation Migration Documentation

## Overview

This document contains the complete analysis and implementation specifications for migrating sophisticated Three.js animation systems to Rust WGPU/Vulkan, preserving all mathematical algorithms, artistic timing, and choreography insights before deletion of the Three.js frontend code.

## Critical Animation Systems Analysis

### 1. Dynamic Lighting Animation System

**Source**: `frontend/src/app/hex-maze/services/lighting-animator.ts`

#### Key Mathematical Algorithms:

**Multi-Frequency Orbital Motion (Lines 114-126)**:
```typescript
const primary_freq = 0.0015;
const secondary_freq = 0.0025;
const tertiary_freq = 0.001;

const primary_angle = time * primary_freq;
const secondary_angle = time * secondary_freq;
const tertiary_angle = time * tertiary_freq;

const x = Math.cos(primary_angle) * this.lightRadius + Math.cos(secondary_angle) * (this.lightRadius * 0.3);
const z = Math.sin(primary_angle) * this.lightRadius + Math.sin(secondary_angle) * (this.lightRadius * 0.3);
const y = this.lightHeight + Math.sin(tertiary_angle) * (this.lightHeight * 0.2);
```

**Shadow Mapping Integration**:
- Dynamic shadow map updates per spotlight
- Transition system for light intensity based on maze states
- Artistic lighting coordination during path animations

#### Missing from Rust Implementation:
- All dynamic lighting animation (static lighting only in pathTracing.wgsl)
- Multi-spotlight orbital mathematics
- Shadow mapping animation systems
- State-based lighting transitions

### 2. Camera Animation System

**Source**: `frontend/src/app/hex-maze/services/camera-animator.ts`

#### Key Mathematical Algorithms:

**Spiral Path Generation (Lines 44-54)**:
```typescript
generateSpiralPath(center: Vector3, startRadius: number, endRadius: number,
                   startHeight: number, endHeight: number, revolutions: number = 1.5): Vector3[] {
    const points: Vector3[] = [];
    const numPoints = 60;

    for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        const angle = t * revolutions * 2 * Math.PI;
        const radius = THREE.MathUtils.lerp(startRadius, endRadius, t);
        const height = THREE.MathUtils.lerp(startHeight, endHeight, t);

        const x = center.x + Math.cos(angle) * radius;
        const z = center.z + Math.sin(angle) * radius;
        const y = center.y + height;

        points.push(new Vector3(x, y, z));
    }

    return points;
}
```

**Look-Ahead Targeting System (Lines 69-76)**:
```typescript
private calculateLookAheadTarget(currentIndex: number): Vector3 {
    if (!this.currentPath || this.currentPath.length === 0) {
        return this.currentTarget;
    }

    const lookAheadDistance = Math.min(3, this.currentPath.length - currentIndex - 1);
    const targetIndex = Math.min(currentIndex + lookAheadDistance, this.currentPath.length - 1);

    const currentPos = this.currentPath[currentIndex];
    const targetPos = this.currentPath[targetIndex];

    return currentPos.clone().lerp(targetPos, 0.2);
}
```

#### Missing from Rust Implementation:
- Entire camera animation system absent
- Spiral path generation algorithms
- Look-ahead targeting mathematics
- TWEEN.js integration for smooth transitions

### 3. Path Animation Sequencing

**Source**: `frontend/src/app/hex-maze/services/path-animator.ts`

#### Key Animation Logic:

**Sequential Path Queue (Lines 89-110)**:
```typescript
private animatePathSequentially(pathData: PathData[], delay: number = 500): Promise<void> {
    return new Promise((resolve) => {
        if (pathData.length === 0) {
            resolve();
            return;
        }

        let currentIndex = 0;

        const animateNext = () => {
            if (currentIndex >= pathData.length) {
                resolve();
                return;
            }

            const path = pathData[currentIndex];
            this.animateSinglePath(path).then(() => {
                currentIndex++;
                if (currentIndex < pathData.length) {
                    setTimeout(animateNext, delay);
                } else {
                    resolve();
                }
            });
        };

        animateNext();
    });
}
```

**Elastic Elevation Effects**:
```typescript
// 1.5 unit elevation with elastic easing
const elevationTween = new TWEEN.Tween({ y: startY })
    .to({ y: startY + 1.5 }, 800)
    .easing(TWEEN.Easing.Elastic.Out);
```

#### Missing from Rust Implementation:
- Sequential animation queue system
- Artistic timing delays (500ms between paths)
- Elastic elevation effects
- Promise-based animation coordination

### 4. Orchestration and Choreography

**Source**: `frontend/src/app/hex-maze/services/maze-scene-manager.ts`

#### Critical Orchestration Methods:

**Intro Animation Sequence (Lines 1040-1064)**:
```typescript
finishIntroAnimation(): Promise<void> {
    return new Promise((resolve) => {
        this.lightingAnimator.stopIntroLighting();
        this.cameraAnimator.transitionToOverview().then(() => {
            this.lightingAnimator.startSolvingLighting();
            resolve();
        });
    });
}
```

**Component Validation and Animation (Lines 1069-1105)**:
```typescript
private validateAndRaiseSolvedComponents(solution: MazeSolution): Promise<void> {
    return new Promise((resolve) => {
        // Complex validation logic with artistic delays
        const validationDelay = 200;
        const animationPromises: Promise<void>[] = [];

        solution.solved_components.forEach((component, index) => {
            const promise = new Promise<void>((componentResolve) => {
                setTimeout(() => {
                    this.pathAnimator.animateComponent(component).then(() => {
                        componentResolve();
                    });
                }, index * validationDelay);
            });
            animationPromises.push(promise);
        });

        Promise.all(animationPromises).then(() => {
            resolve();
        });
    });
}
```

### 5. Von-Grid Integration

**Source**: `frontend/src/app/hex-maze/services/von-grid.service.ts`

#### Key Constants and Integration:
```typescript
// Mathematical constants for hexagonal grids
const SQRT3 = Math.sqrt(3);
const DEG_TO_RAD = Math.PI / 180;

// Von-grid library integration for unique ID generation
// Minimal role - primarily used for coordinate validation
```

## Rust Implementation Specifications

### 1. Dynamic Lighting System for WGPU

#### Shader Uniform Structure:
```rust
#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct LightingUniforms {
    pub num_spotlights: u32,
    pub spotlights: [SpotLight; 8], // Support up to 8 dynamic spotlights
    pub time: f32,
    pub animation_state: u32, // 0=intro, 1=solving, 2=solved
    pub _padding: [u32; 2],
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SpotLight {
    pub position: [f32; 3],
    pub direction: [f32; 3],
    pub color: [f32; 3],
    pub intensity: f32,
    pub inner_cone_angle: f32,
    pub outer_cone_angle: f32,
    pub range: f32,
    pub _padding: f32,
}
```

#### Animation Update System:
```rust
impl LightingAnimator {
    pub fn update(&mut self, time: f32, state: AnimationState) {
        match state {
            AnimationState::Intro => self.update_intro_lighting(time),
            AnimationState::Solving => self.update_solving_lighting(time),
            AnimationState::Solved => self.update_solved_lighting(time),
        }
    }

    fn update_solving_lighting(&mut self, time: f32) {
        const PRIMARY_FREQ: f32 = 0.0015;
        const SECONDARY_FREQ: f32 = 0.0025;
        const TERTIARY_FREQ: f32 = 0.001;

        let primary_angle = time * PRIMARY_FREQ;
        let secondary_angle = time * SECONDARY_FREQ;
        let tertiary_angle = time * TERTIARY_FREQ;

        for (i, light) in self.spotlights.iter_mut().enumerate() {
            let phase_offset = i as f32 * std::f32::consts::PI / 2.0;

            let x = (primary_angle + phase_offset).cos() * self.light_radius
                  + (secondary_angle + phase_offset).cos() * (self.light_radius * 0.3);
            let z = (primary_angle + phase_offset).sin() * self.light_radius
                  + (secondary_angle + phase_offset).sin() * (self.light_radius * 0.3);
            let y = self.light_height + (tertiary_angle + phase_offset).sin() * (self.light_height * 0.2);

            light.position = [x, y, z];

            // Calculate direction to maze center
            let dir_x = -x / (x * x + z * z).sqrt();
            let dir_z = -z / (x * x + z * z).sqrt();
            let dir_y = -0.5; // Slight downward angle

            light.direction = [dir_x, dir_y, dir_z];
        }
    }
}
```

### 2. Camera Animation System

#### Spiral Path Generation:
```rust
impl CameraAnimator {
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
            let angle = t * revolutions * 2.0 * std::f32::consts::PI;
            let radius = lerp(start_radius, end_radius, t);
            let height = lerp(start_height, end_height, t);

            let x = center.x + angle.cos() * radius;
            let z = center.z + angle.sin() * radius;
            let y = center.y + height;

            points.push(Vec3::new(x, y, z));
        }

        points
    }

    pub fn calculate_look_ahead_target(&self, current_index: usize) -> Vec3 {
        if let Some(path) = &self.current_path {
            let look_ahead_distance = (3).min(path.len() - current_index - 1);
            let target_index = (current_index + look_ahead_distance).min(path.len() - 1);

            let current_pos = path[current_index];
            let target_pos = path[target_index];

            current_pos.lerp(target_pos, 0.2)
        } else {
            self.current_target
        }
    }
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

impl Vec3 {
    fn lerp(self, other: Vec3, t: f32) -> Vec3 {
        Vec3 {
            x: lerp(self.x, other.x, t),
            y: lerp(self.y, other.y, t),
            z: lerp(self.z, other.z, t),
        }
    }
}
```

### 3. Animation Tween System

#### Custom Tween Implementation:
```rust
use std::time::Duration;

pub struct TweenEngine {
    active_tweens: Vec<Box<dyn Tween>>,
}

pub trait Tween {
    fn update(&mut self, dt: Duration) -> bool; // Returns false when complete
    fn is_complete(&self) -> bool;
}

pub struct FloatTween {
    start_value: f32,
    end_value: f32,
    current_value: f32,
    duration: Duration,
    elapsed: Duration,
    easing: EasingFunction,
    callback: Option<Box<dyn FnMut(f32)>>,
}

pub enum EasingFunction {
    Linear,
    CubicOut,
    ElasticOut,
    ElasticIn,
}

impl FloatTween {
    pub fn new(
        start: f32,
        end: f32,
        duration: Duration,
        easing: EasingFunction,
    ) -> Self {
        Self {
            start_value: start,
            end_value: end,
            current_value: start,
            duration,
            elapsed: Duration::ZERO,
            easing,
            callback: None,
        }
    }

    pub fn with_callback<F>(mut self, callback: F) -> Self
    where
        F: FnMut(f32) + 'static,
    {
        self.callback = Some(Box::new(callback));
        self
    }
}

impl Tween for FloatTween {
    fn update(&mut self, dt: Duration) -> bool {
        if self.is_complete() {
            return false;
        }

        self.elapsed += dt;
        let t = (self.elapsed.as_secs_f32() / self.duration.as_secs_f32()).min(1.0);

        let eased_t = match self.easing {
            EasingFunction::Linear => t,
            EasingFunction::CubicOut => 1.0 - (1.0 - t).powi(3),
            EasingFunction::ElasticOut => {
                if t == 0.0 || t == 1.0 {
                    t
                } else {
                    let p = 0.3;
                    let a = 1.0;
                    let s = p / 4.0;
                    a * (2.0_f32.powf(-10.0 * t) * ((t - s) * (2.0 * std::f32::consts::PI) / p).sin() + 1.0)
                }
            },
            EasingFunction::ElasticIn => {
                if t == 0.0 || t == 1.0 {
                    t
                } else {
                    let p = 0.3;
                    let a = 1.0;
                    let s = p / 4.0;
                    -(a * (2.0_f32.powf(10.0 * (t - 1.0)) * (((t - 1.0) - s) * (2.0 * std::f32::consts::PI) / p).sin()))
                }
            },
        };

        self.current_value = self.start_value + (self.end_value - self.start_value) * eased_t;

        if let Some(ref mut callback) = self.callback {
            callback(self.current_value);
        }

        !self.is_complete()
    }

    fn is_complete(&self) -> bool {
        self.elapsed >= self.duration
    }
}

impl TweenEngine {
    pub fn new() -> Self {
        Self {
            active_tweens: Vec::new(),
        }
    }

    pub fn add_tween(&mut self, tween: Box<dyn Tween>) {
        self.active_tweens.push(tween);
    }

    pub fn update(&mut self, dt: Duration) {
        self.active_tweens.retain_mut(|tween| tween.update(dt));
    }

    // Tween chain support for sequential animations
    pub fn chain(&mut self, tweens: Vec<Box<dyn Tween>>, delay: Duration) {
        let mut chain_tween = TweenChain::new(tweens, delay);
        self.active_tweens.push(Box::new(chain_tween));
    }
}

pub struct TweenChain {
    tweens: Vec<Box<dyn Tween>>,
    current_index: usize,
    delay: Duration,
    delay_elapsed: Duration,
    waiting_for_delay: bool,
}

impl TweenChain {
    pub fn new(tweens: Vec<Box<dyn Tween>>, delay: Duration) -> Self {
        Self {
            tweens,
            current_index: 0,
            delay,
            delay_elapsed: Duration::ZERO,
            waiting_for_delay: false,
        }
    }
}

impl Tween for TweenChain {
    fn update(&mut self, dt: Duration) -> bool {
        if self.current_index >= self.tweens.len() {
            return false;
        }

        if self.waiting_for_delay {
            self.delay_elapsed += dt;
            if self.delay_elapsed >= self.delay {
                self.waiting_for_delay = false;
                self.delay_elapsed = Duration::ZERO;
            } else {
                return true; // Still waiting
            }
        }

        if let Some(current_tween) = self.tweens.get_mut(self.current_index) {
            if !current_tween.update(dt) {
                // Current tween finished, move to next
                self.current_index += 1;
                if self.current_index < self.tweens.len() {
                    self.waiting_for_delay = true;
                }
            }
        }

        self.current_index < self.tweens.len()
    }

    fn is_complete(&self) -> bool {
        self.current_index >= self.tweens.len()
    }
}
```

### 4. Path Animation System

#### Sequential Path Animation:
```rust
pub struct PathAnimator {
    tween_engine: TweenEngine,
    active_animations: Vec<PathAnimation>,
}

pub struct PathAnimation {
    path_data: Vec<PathPoint>,
    current_index: usize,
    elevation_height: f32,
}

impl PathAnimator {
    pub async fn animate_paths_sequentially(
        &mut self,
        paths: Vec<Vec<PathPoint>>,
        delay_ms: u64,
    ) -> Result<(), AnimationError> {
        for (i, path) in paths.iter().enumerate() {
            self.animate_single_path(path.clone()).await?;
            if i < paths.len() - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
            }
        }
        Ok(())
    }

    pub async fn animate_single_path(
        &mut self,
        path: Vec<PathPoint>,
    ) -> Result<(), AnimationError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut tx = Some(tx);

        // Create elevation tween with elastic easing
        let elevation_tween = FloatTween::new(
            0.0,
            1.5, // 1.5 unit elevation to match Three.js
            Duration::from_millis(800),
            EasingFunction::ElasticOut,
        ).with_callback(move |height| {
            // Update vertex buffer with new height
            // This would trigger a GPU buffer update
        });

        self.tween_engine.add_tween(Box::new(elevation_tween));

        // Wait for animation completion
        rx.await.map_err(|_| AnimationError::CallbackError)?;

        Ok(())
    }
}
```

### 5. Shader Integration

#### Updated WGSL Shader (pathTracing.wgsl):
```wgsl
struct LightingUniforms {
    num_spotlights: u32,
    spotlights: array<SpotLight, 8>,
    time: f32,
    animation_state: u32,
}

struct SpotLight {
    position: vec3<f32>,
    direction: vec3<f32>,
    color: vec3<f32>,
    intensity: f32,
    inner_cone_angle: f32,
    outer_cone_angle: f32,
    range: f32,
}

@group(2) @binding(0) var<uniform> lighting: LightingUniforms;

fn calculate_spotlight_contribution(
    light: SpotLight,
    world_pos: vec3<f32>,
    normal: vec3<f32>
) -> vec3<f32> {
    let light_dir = normalize(light.position - world_pos);
    let distance = length(light.position - world_pos);

    // Spotlight cone calculation
    let spot_dir = normalize(-light.direction);
    let spot_angle = dot(light_dir, spot_dir);
    let inner_cos = cos(light.inner_cone_angle);
    let outer_cos = cos(light.outer_cone_angle);

    let spot_intensity = smoothstep(outer_cos, inner_cos, spot_angle);

    // Distance attenuation
    let attenuation = 1.0 / (1.0 + distance * distance / (light.range * light.range));

    // Basic Lambertian lighting
    let ndotl = max(dot(normal, light_dir), 0.0);

    return light.color * light.intensity * spot_intensity * attenuation * ndotl;
}

// In main fragment function:
var total_light = vec3<f32>(0.0, 0.0, 0.0);
for (var i = 0u; i < lighting.num_spotlights; i++) {
    total_light += calculate_spotlight_contribution(lighting.spotlights[i], world_pos, normal);
}
```

## Implementation Timing and Artistic Values

### Critical Timing Constants:
- **Path Animation Delay**: 500ms between sequential path animations
- **Component Validation Delay**: 200ms between component validations
- **Elevation Animation Duration**: 800ms with ElasticOut easing
- **Elevation Height**: 1.5 units
- **Camera Spiral Points**: 60 points over 1.5 revolutions
- **Camera Look-Ahead Factor**: 0.2 interpolation
- **Light Frequencies**: Primary 0.0015, Secondary 0.0025, Tertiary 0.001
- **Light Radius Variation**: 30% secondary amplitude
- **Light Height Variation**: 20% tertiary amplitude

### Easing Functions Priority:
1. **ElasticOut**: Path elevation animations (creates dramatic reveal effect)
2. **CubicOut**: Camera transitions (smooth deceleration)
3. **Linear**: Basic property animations

## Missing Features Summary

### Currently Absent from Rust Implementation:
1. **Dynamic Lighting System**: No orbital animations, static lighting only
2. **Camera Animation**: No spiral paths, no look-ahead targeting
3. **Path Sequencing**: No sequential animation queue with delays
4. **Artistic Timing**: No choreographed animation coordination
5. **Tween System**: No easing functions or smooth transitions
6. **State-Based Transitions**: No intro/solving/solved animation states

### Implementation Priority:
1. **Phase 1**: Implement custom tween system with essential easing functions
2. **Phase 2**: Port dynamic lighting mathematics to WGPU shaders
3. **Phase 3**: Implement camera animation spiral path generation
4. **Phase 4**: Create sequential path animation queue system
5. **Phase 5**: Add orchestration layer for coordinated animations
6. **Phase 6**: Verify all artistic timing values match Three.js implementation

## File Deletion Schedule

**After Rust Implementation Completion**:
- `frontend/src/app/hex-maze/services/lighting-animator.ts` ✗
- `frontend/src/app/hex-maze/services/camera-animator.ts` ✗
- `frontend/src/app/hex-maze/services/path-animator.ts` ✗
- `frontend/src/app/hex-maze/services/maze-scene-manager.ts` ✗
- `frontend/src/app/hex-maze/services/von-grid.service.ts` ✗
- **Entire Three.js frontend** ✗

**Verification Requirements**:
- [ ] All mathematical algorithms exactly reproduced in Rust
- [ ] All timing constants preserved (500ms, 800ms, 200ms, etc.)
- [ ] All easing functions (ElasticOut, CubicOut) mathematically equivalent
- [ ] All artistic choreography maintained
- [ ] Performance equivalent or superior to Three.js version

## Conclusion

This document captures the complete mathematical and artistic essence of the Three.js animation systems. Every algorithm, timing constant, and artistic choice has been documented for faithful reproduction in the Rust WGPU implementation. The goal is pixel-perfect animation equivalence before complete Three.js deletion.