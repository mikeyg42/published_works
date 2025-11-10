// animation/mod.rs - High-performance animation system for WGPU path tracer

pub mod tween;
pub mod lighting_animator;
pub mod camera_animator;
pub mod path_animator;
pub mod orchestrator;

pub use tween::*;
pub use lighting_animator::*;
pub use camera_animator::*;
pub use path_animator::*;
pub use orchestrator::*;

use serde::{Serialize, Deserialize};
use std::time::Duration;

// ============================================================================
// ANIMATION STATE MANAGEMENT
// ============================================================================

/// Animation state matching Three.js patterns
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AnimationState {
    Intro,
    Solving,
    Solved,
}

/// Animation playback control
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackState {
    Playing,
    Paused,
    Stopped,
    Finished,
}

// ============================================================================
// CORE MATH TYPES
// ============================================================================

/// 3D vector with SIMD-ready alignment
#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    _padding: f32, // For SIMD alignment
}

impl Vec3 {
    #[inline]
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z, _padding: 0.0 }
    }

    #[inline]
    pub const fn zero() -> Self {
        Self::new(0.0, 0.0, 0.0)
    }
    
    #[inline]
    pub const fn one() -> Self {
        Self::new(1.0, 1.0, 1.0)
    }

    #[inline]
    pub fn lerp(self, other: Vec3, t: f32) -> Vec3 {
        // Clamp t to [0, 1] for safety
        let t = t.clamp(0.0, 1.0);
        Vec3::new(
            self.x + (other.x - self.x) * t,
            self.y + (other.y - self.y) * t,
            self.z + (other.z - self.z) * t,
        )
    }
    
    #[inline]
    pub fn slerp(self, other: Vec3, t: f32) -> Vec3 {
        // Spherical linear interpolation for rotations
        let dot = self.dot(other).clamp(-1.0, 1.0);
        let theta = dot.acos();
        let sin_theta = theta.sin();
        
        if sin_theta.abs() < 0.001 {
            return self.lerp(other, t);
        }
        
        let a = ((1.0 - t) * theta).sin() / sin_theta;
        let b = (t * theta).sin() / sin_theta;
        
        self * a + other * b
    }

    #[inline]
    pub fn length(self) -> f32 {
        self.length_squared().sqrt()
    }
    
    #[inline]
    pub fn length_squared(self) -> f32 {
        self.x * self.x + self.y * self.y + self.z * self.z
    }

    #[inline]
    pub fn normalize(self) -> Vec3 {
        let len_sq = self.length_squared();
        if len_sq > 1e-20 {
            let inv_len = 1.0 / len_sq.sqrt();
            Vec3::new(
                self.x * inv_len,
                self.y * inv_len,
                self.z * inv_len,
            )
        } else {
            Vec3::zero()
        }
    }
    
    #[inline]
    pub fn dot(self, other: Vec3) -> f32 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }
    
    #[inline]
    pub fn cross(self, other: Vec3) -> Vec3 {
        Vec3::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }
}

// Implement operators for Vec3
impl std::ops::Add for Vec3 {
    type Output = Vec3;
    #[inline]
    fn add(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }
}

impl std::ops::Sub for Vec3 {
    type Output = Vec3;
    #[inline]
    fn sub(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }
}

impl std::ops::Mul<f32> for Vec3 {
    type Output = Vec3;
    #[inline]
    fn mul(self, scalar: f32) -> Vec3 {
        Vec3::new(self.x * scalar, self.y * scalar, self.z * scalar)
    }
}

impl std::ops::Div<f32> for Vec3 {
    type Output = Vec3;
    #[inline]
    fn div(self, scalar: f32) -> Vec3 {
        let inv = 1.0 / scalar;
        Vec3::new(self.x * inv, self.y * inv, self.z * inv)
    }
}

impl From<[f32; 3]> for Vec3 {
    #[inline]
    fn from(arr: [f32; 3]) -> Self {
        Vec3::new(arr[0], arr[1], arr[2])
    }
}

impl From<Vec3> for [f32; 3] {
    #[inline]
    fn from(v: Vec3) -> [f32; 3] {
        [v.x, v.y, v.z]
    }
}

// ============================================================================
// COLOR TYPE
// ============================================================================

/// RGBA color with proper interpolation
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    #[inline]
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }
    
    #[inline]
    pub const fn rgb(r: f32, g: f32, b: f32) -> Self {
        Self::new(r, g, b, 1.0)
    }
    
    #[inline]
    pub fn lerp(self, other: Color, t: f32) -> Color {
        let t = t.clamp(0.0, 1.0);
        Color::new(
            self.r + (other.r - self.r) * t,
            self.g + (other.g - self.g) * t,
            self.b + (other.b - self.b) * t,
            self.a + (other.a - self.a) * t,
        )
    }
    
    /// Convert to linear space from sRGB
    #[inline]
    pub fn to_linear(self) -> Color {
        Color::new(
            srgb_to_linear(self.r),
            srgb_to_linear(self.g),
            srgb_to_linear(self.b),
            self.a,
        )
    }
    
    /// Convert from linear to sRGB
    #[inline]
    pub fn to_srgb(self) -> Color {
        Color::new(
            linear_to_srgb(self.r),
            linear_to_srgb(self.g),
            linear_to_srgb(self.b),
            self.a,
        )
    }
}

impl From<[f32; 4]> for Color {
    #[inline]
    fn from(arr: [f32; 4]) -> Self {
        Color::new(arr[0], arr[1], arr[2], arr[3])
    }
}

impl From<Color> for [f32; 4] {
    #[inline]
    fn from(c: Color) -> [f32; 4] {
        [c.r, c.g, c.b, c.a]
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/// Linear interpolation
#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

/// Smooth step interpolation
#[inline]
pub fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// sRGB to linear conversion
#[inline]
fn srgb_to_linear(x: f32) -> f32 {
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear to sRGB conversion
#[inline]
fn linear_to_srgb(x: f32) -> f32 {
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/// Animation system errors
#[derive(Debug, thiserror::Error)]
pub enum AnimationError {
    #[error("Animation callback failed: {0}")]
    CallbackError(String),
    
    #[error("Invalid animation parameters: {0}")]
    InvalidParameters(String),
    
    #[error("Animation system not initialized")]
    NotInitialized,
    
    #[error("Animation already exists with id: {0}")]
    DuplicateId(String),
    
    #[error("Animation not found with id: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, AnimationError>;