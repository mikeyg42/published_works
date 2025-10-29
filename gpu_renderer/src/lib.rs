// lib.rs - Library exports for maze-gpu-renderer
// Provides public API for external use of the renderer components

pub mod material_loader;
pub mod animation;
pub mod error_handling;

// Re-export commonly used types
pub use material_loader::{MaterialRegistry, TextureSet, MaterialParams, TextureFileNames, PbrTexture};
pub use animation::{AnimationState, Vec3 as AnimVec3, TweenEngine, EasingFunction};