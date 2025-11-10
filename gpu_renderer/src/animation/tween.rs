// animation/tween.rs - High-performance tween engine without excessive boxing

use std::time::Duration;
use std::collections::HashMap;
use super::{Vec3, Color, lerp, smoothstep, PlaybackState, Result, AnimationError};

// ============================================================================
// EASING FUNCTIONS
// ============================================================================

/// Easing functions matching TWEEN.js
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Easing {
    Linear,
    QuadIn,
    QuadOut,
    QuadInOut,
    CubicIn,
    CubicOut,
    CubicInOut,
    QuartIn,
    QuartOut,
    QuartInOut,
    QuintIn,
    QuintOut,
    QuintInOut,
    SineIn,
    SineOut,
    SineInOut,
    ExpoIn,
    ExpoOut,
    ExpoInOut,
    CircIn,
    CircOut,
    CircInOut,
    ElasticIn,
    ElasticOut,
    ElasticInOut,
    BackIn,
    BackOut,
    BackInOut,
    BounceIn,
    BounceOut,
    BounceInOut,
}

impl Easing {
    /// Apply easing function to normalized time value
    #[inline]
    pub fn apply(self, mut t: f32) -> f32 {
        t = t.clamp(0.0, 1.0);
        
        match self {
            Easing::Linear => t,
            
            // Quadratic
            Easing::QuadIn => t * t,
            Easing::QuadOut => t * (2.0 - t),
            Easing::QuadInOut => {
                if t < 0.5 { 2.0 * t * t } else { -1.0 + (4.0 - 2.0 * t) * t }
            },
            
            // Cubic
            Easing::CubicIn => t * t * t,
            Easing::CubicOut => {
                let t = t - 1.0;
                t * t * t + 1.0
            },
            Easing::CubicInOut => {
                if t < 0.5 { 4.0 * t * t * t } else {
                    let t = 2.0 * t - 2.0;
                    1.0 + t * t * t / 2.0
                }
            },
            
            // Quartic
            Easing::QuartIn => t * t * t * t,
            Easing::QuartOut => {
                let t = t - 1.0;
                1.0 - t * t * t * t
            },
            Easing::QuartInOut => {
                if t < 0.5 { 8.0 * t * t * t * t } else {
                    let t = t - 1.0;
                    1.0 - 8.0 * t * t * t * t
                }
            },
            
            // Quintic
            Easing::QuintIn => t * t * t * t * t,
            Easing::QuintOut => {
                let t = t - 1.0;
                t * t * t * t * t + 1.0
            },
            Easing::QuintInOut => {
                if t < 0.5 { 16.0 * t * t * t * t * t } else {
                    let t = 2.0 * t - 2.0;
                    1.0 + t * t * t * t * t / 2.0
                }
            },
            
            // Sine
            Easing::SineIn => 1.0 - (t * std::f32::consts::FRAC_PI_2).cos(),
            Easing::SineOut => (t * std::f32::consts::FRAC_PI_2).sin(),
            Easing::SineInOut => -(((std::f32::consts::PI * t).cos() - 1.0) / 2.0),
            
            // Exponential
            Easing::ExpoIn => if t == 0.0 { 0.0 } else { 2.0_f32.powf(10.0 * t - 10.0) },
            Easing::ExpoOut => if t == 1.0 { 1.0 } else { 1.0 - 2.0_f32.powf(-10.0 * t) },
            Easing::ExpoInOut => {
                if t == 0.0 { 0.0 }
                else if t == 1.0 { 1.0 }
                else if t < 0.5 { 2.0_f32.powf(20.0 * t - 10.0) / 2.0 }
                else { (2.0 - 2.0_f32.powf(-20.0 * t + 10.0)) / 2.0 }
            },
            
            // Circular
            Easing::CircIn => 1.0 - (1.0 - t * t).sqrt(),
            Easing::CircOut => ((2.0 - t) * t).sqrt(),
            Easing::CircInOut => {
                if t < 0.5 {
                    (1.0 - (1.0 - 4.0 * t * t).sqrt()) / 2.0
                } else {
                    ((-(2.0 * t - 3.0) * (2.0 * t - 1.0)).sqrt() + 1.0) / 2.0
                }
            },
            
            // Elastic
            Easing::ElasticIn => {
                if t == 0.0 || t == 1.0 { t }
                else {
                    let p = 0.3;
                    let s = p / 4.0;
                    -(2.0_f32.powf(10.0 * (t - 1.0)) * 
                      ((t - 1.0 - s) * 2.0 * std::f32::consts::PI / p).sin())
                }
            },
            Easing::ElasticOut => {
                if t == 0.0 || t == 1.0 { t }
                else {
                    let p = 0.3;
                    let s = p / 4.0;
                    2.0_f32.powf(-10.0 * t) * 
                    ((t - s) * 2.0 * std::f32::consts::PI / p).sin() + 1.0
                }
            },
            Easing::ElasticInOut => {
                if t == 0.0 || t == 1.0 { t }
                else {
                    let p = 0.45;
                    let s = p / 4.0;
                    if t < 0.5 {
                        let t = 2.0 * t;
                        -0.5 * 2.0_f32.powf(10.0 * (t - 1.0)) * 
                        ((t - 1.0 - s) * 2.0 * std::f32::consts::PI / p).sin()
                    } else {
                        let t = 2.0 * t - 1.0;
                        2.0_f32.powf(-10.0 * t) * 
                        ((t - s) * 2.0 * std::f32::consts::PI / p).sin() * 0.5 + 1.0
                    }
                }
            },
            
            // Back
            Easing::BackIn => {
                let c = 1.70158;
                (c + 1.0) * t * t * t - c * t * t
            },
            Easing::BackOut => {
                let c = 1.70158;
                let t = t - 1.0;
                (c + 1.0) * t * t * t + c * t * t + 1.0
            },
            Easing::BackInOut => {
                let c = 1.70158 * 1.525;
                if t < 0.5 {
                    4.0 * t * t * ((c + 1.0) * 2.0 * t - c) / 2.0
                } else {
                    let t = 2.0 * t - 2.0;
                    (t * t * ((c + 1.0) * t + c) + 2.0) / 2.0
                }
            },
            
            // Bounce
            Easing::BounceOut => {
                if t < 1.0 / 2.75 {
                    7.5625 * t * t
                } else if t < 2.0 / 2.75 {
                    let t = t - 1.5 / 2.75;
                    7.5625 * t * t + 0.75
                } else if t < 2.5 / 2.75 {
                    let t = t - 2.25 / 2.75;
                    7.5625 * t * t + 0.9375
                } else {
                    let t = t - 2.625 / 2.75;
                    7.5625 * t * t + 0.984375
                }
            },
            Easing::BounceIn => 1.0 - Easing::BounceOut.apply(1.0 - t),
            Easing::BounceInOut => {
                if t < 0.5 {
                    Easing::BounceIn.apply(t * 2.0) * 0.5
                } else {
                    Easing::BounceOut.apply(t * 2.0 - 1.0) * 0.5 + 0.5
                }
            },
        }
    }
}

// ============================================================================
// INTERPOLATABLE TRAIT
// ============================================================================

/// Trait for types that can be interpolated
pub trait Interpolate: Clone + Send + Sync + 'static {
    fn interpolate(&self, other: &Self, t: f32) -> Self;
}

impl Interpolate for f32 {
    #[inline]
    fn interpolate(&self, other: &Self, t: f32) -> Self {
        lerp(*self, *other, t)
    }
}

impl Interpolate for Vec3 {
    #[inline]
    fn interpolate(&self, other: &Self, t: f32) -> Self {
        self.lerp(*other, t)
    }
}

impl Interpolate for Color {
    #[inline]
    fn interpolate(&self, other: &Self, t: f32) -> Self {
        self.lerp(*other, t)
    }
}

// ============================================================================
// TWEEN IMPLEMENTATION
// ============================================================================

/// Generic tween for any interpolatable type
pub struct Tween<T: Interpolate> {
    id: Option<String>,
    start: T,
    end: T,
    current: T,
    duration: Duration,
    elapsed: Duration,
    delay: Duration,
    delay_elapsed: Duration,
    easing: Easing,
    state: PlaybackState,
    repeat: u32,  // 0 = no repeat, u32::MAX = infinite
    repeat_count: u32,
    yoyo: bool,
    reversed: bool,
}

impl<T: Interpolate> Tween<T> {
    /// Create new tween
    pub fn new(start: T, end: T, duration: Duration) -> Self {
        Self {
            id: None,
            start: start.clone(),
            end: end.clone(),
            current: start,
            duration,
            elapsed: Duration::ZERO,
            delay: Duration::ZERO,
            delay_elapsed: Duration::ZERO,
            easing: Easing::Linear,
            state: PlaybackState::Playing,
            repeat: 0,
            repeat_count: 0,
            yoyo: false,
            reversed: false,
        }
    }
    
    /// Set unique identifier
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
    
    /// Set easing function
    pub fn with_easing(mut self, easing: Easing) -> Self {
        self.easing = easing;
        self
    }
    
    /// Set initial delay
    pub fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
    
    /// Set repeat count (u32::MAX for infinite)
    pub fn with_repeat(mut self, count: u32) -> Self {
        self.repeat = count;
        self
    }
    
    /// Enable yoyo mode (reverse on repeat)
    pub fn with_yoyo(mut self, yoyo: bool) -> Self {
        self.yoyo = yoyo;
        self
    }
    
    /// Get current interpolated value
    pub fn current(&self) -> &T {
        &self.current
    }
    
    /// Get playback state
    pub fn state(&self) -> PlaybackState {
        self.state
    }
    
    /// Pause playback
    pub fn pause(&mut self) {
        if self.state == PlaybackState::Playing {
            self.state = PlaybackState::Paused;
        }
    }
    
    /// Resume playback
    pub fn resume(&mut self) {
        if self.state == PlaybackState::Paused {
            self.state = PlaybackState::Playing;
        }
    }
    
    /// Stop and reset
    pub fn stop(&mut self) {
        self.state = PlaybackState::Stopped;
        self.elapsed = Duration::ZERO;
        self.delay_elapsed = Duration::ZERO;
        self.repeat_count = 0;
        self.reversed = false;
        self.current = self.start.clone();
    }
    
    /// Reverse direction
    pub fn reverse(&mut self) {
        self.reversed = !self.reversed;
    }
    
    /// Update tween and return true if still active
    pub fn update(&mut self, dt: Duration) -> bool {
        if self.state != PlaybackState::Playing {
            return self.state != PlaybackState::Finished;
        }
        
        // Handle delay
        if self.delay_elapsed < self.delay {
            self.delay_elapsed += dt;
            return true;
        }
        
        // Update elapsed time
        self.elapsed += dt;
        
        // Calculate progress
        let mut t = (self.elapsed.as_secs_f32() / self.duration.as_secs_f32()).min(1.0);
        
        // Apply easing
        t = self.easing.apply(t);
        
        // Apply reverse if needed
        if self.reversed {
            t = 1.0 - t;
        }
        
        // Interpolate value
        self.current = self.start.interpolate(&self.end, t);
        
        // Check completion
        if self.elapsed >= self.duration {
            // Handle repeat
            if self.repeat_count < self.repeat {
                self.repeat_count += 1;
                self.elapsed = Duration::ZERO;
                
                // Handle yoyo
                if self.yoyo {
                    self.reversed = !self.reversed;
                }
                
                return true;
            }
            
            // Tween finished
            self.state = PlaybackState::Finished;
            return false;
        }
        
        true
    }
}

// ============================================================================
// TWEEN GROUP (replaces TweenEngine)
// ============================================================================

/// Group of tweens with shared update
pub struct TweenGroup {
    tweens_f32: HashMap<String, Tween<f32>>,
    tweens_vec3: HashMap<String, Tween<Vec3>>,
    tweens_color: HashMap<String, Tween<Color>>,
    update_callbacks: HashMap<String, Box<dyn FnMut(&str, f32) + Send>>,
    complete_callbacks: HashMap<String, Box<dyn FnOnce() + Send>>,
}

impl TweenGroup {
    pub fn new() -> Self {
        Self {
            tweens_f32: HashMap::new(),
            tweens_vec3: HashMap::new(),
            tweens_color: HashMap::new(),
            update_callbacks: HashMap::new(),
            complete_callbacks: HashMap::new(),
        }
    }
    
    /// Add float tween
    pub fn add_f32(
        &mut self,
        id: impl Into<String>,
        start: f32,
        end: f32,
        duration: Duration,
    ) -> Result<&mut Tween<f32>> {
        let id = id.into();
        if self.tweens_f32.contains_key(&id) {
            return Err(AnimationError::DuplicateId(id));
        }
        
        let tween = Tween::new(start, end, duration).with_id(id.clone());
        self.tweens_f32.insert(id.clone(), tween);
        Ok(self.tweens_f32.get_mut(&id).unwrap())
    }
    
    /// Add Vec3 tween
    pub fn add_vec3(
        &mut self,
        id: impl Into<String>,
        start: Vec3,
        end: Vec3,
        duration: Duration,
    ) -> Result<&mut Tween<Vec3>> {
        let id = id.into();
        if self.tweens_vec3.contains_key(&id) {
            return Err(AnimationError::DuplicateId(id));
        }
        
        let tween = Tween::new(start, end, duration).with_id(id.clone());
        self.tweens_vec3.insert(id.clone(), tween);
        Ok(self.tweens_vec3.get_mut(&id).unwrap())
    }
    
    /// Add Color tween
    pub fn add_color(
        &mut self,
        id: impl Into<String>,
        start: Color,
        end: Color,
        duration: Duration,
    ) -> Result<&mut Tween<Color>> {
        let id = id.into();
        if self.tweens_color.contains_key(&id) {
            return Err(AnimationError::DuplicateId(id));
        }
        
        let tween = Tween::new(start, end, duration).with_id(id.clone());
        self.tweens_color.insert(id.clone(), tween);
        Ok(self.tweens_color.get_mut(&id).unwrap())
    }
    
    /// Set update callback for tween
    pub fn on_update<F>(&mut self, id: impl Into<String>, callback: F)
    where
        F: FnMut(&str, f32) + Send + 'static
    {
        self.update_callbacks.insert(id.into(), Box::new(callback));
    }
    
    /// Set completion callback
    pub fn on_complete<F>(&mut self, id: impl Into<String>, callback: F)
    where
        F: FnOnce() + Send + 'static
    {
        self.complete_callbacks.insert(id.into(), Box::new(callback));
    }
    
    /// Update all tweens
    pub fn update(&mut self, dt: Duration) {
        // Update f32 tweens
        let mut completed = Vec::new();
        for (id, tween) in &mut self.tweens_f32 {
            if !tween.update(dt) {
                completed.push(id.clone());
            }
            
            // Call update callback
            if let Some(callback) = self.update_callbacks.get_mut(id) {
                let progress = tween.elapsed.as_secs_f32() / tween.duration.as_secs_f32();
                callback(id, progress.min(1.0));
            }
        }
        
        // Handle completed tweens
        for id in completed {
            self.tweens_f32.remove(&id);
            if let Some(callback) = self.complete_callbacks.remove(&id) {
                callback();
            }
        }
        
        // Update Vec3 tweens
        let mut completed = Vec::new();
        for (id, tween) in &mut self.tweens_vec3 {
            if !tween.update(dt) {
                completed.push(id.clone());
            }
            
            if let Some(callback) = self.update_callbacks.get_mut(id) {
                let progress = tween.elapsed.as_secs_f32() / tween.duration.as_secs_f32();
                callback(id, progress.min(1.0));
            }
        }
        
        for id in completed {
            self.tweens_vec3.remove(&id);
            if let Some(callback) = self.complete_callbacks.remove(&id) {
                callback();
            }
        }
        
        // Update Color tweens
        let mut completed = Vec::new();
        for (id, tween) in &mut self.tweens_color {
            if !tween.update(dt) {
                completed.push(id.clone());
            }
            
            if let Some(callback) = self.update_callbacks.get_mut(id) {
                let progress = tween.elapsed.as_secs_f32() / tween.duration.as_secs_f32();
                callback(id, progress.min(1.0));
            }
        }
        
        for id in completed {
            self.tweens_color.remove(&id);
            if let Some(callback) = self.complete_callbacks.remove(&id) {
                callback();
            }
        }
    }
    
    /// Get current value of f32 tween
    pub fn get_f32(&self, id: &str) -> Option<f32> {
        self.tweens_f32.get(id).map(|t| *t.current())
    }
    
    /// Get current value of Vec3 tween
    pub fn get_vec3(&self, id: &str) -> Option<Vec3> {
        self.tweens_vec3.get(id).map(|t| *t.current())
    }
    
    /// Get current value of Color tween
    pub fn get_color(&self, id: &str) -> Option<Color> {
        self.tweens_color.get(id).map(|t| *t.current())
    }
    
    /// Pause tween by id
    pub fn pause(&mut self, id: &str) -> Result<()> {
        if let Some(tween) = self.tweens_f32.get_mut(id) {
            tween.pause();
            return Ok(());
        }
        if let Some(tween) = self.tweens_vec3.get_mut(id) {
            tween.pause();
            return Ok(());
        }
        if let Some(tween) = self.tweens_color.get_mut(id) {
            tween.pause();
            return Ok(());
        }
        Err(AnimationError::NotFound(id.to_string()))
    }
    
    /// Resume tween by id
    pub fn resume(&mut self, id: &str) -> Result<()> {
        if let Some(tween) = self.tweens_f32.get_mut(id) {
            tween.resume();
            return Ok(());
        }
        if let Some(tween) = self.tweens_vec3.get_mut(id) {
            tween.resume();
            return Ok(());
        }
        if let Some(tween) = self.tweens_color.get_mut(id) {
            tween.resume();
            return Ok(());
        }
        Err(AnimationError::NotFound(id.to_string()))
    }
    
    /// Clear all tweens
    pub fn clear(&mut self) {
        self.tweens_f32.clear();
        self.tweens_vec3.clear();
        self.tweens_color.clear();
        self.update_callbacks.clear();
        self.complete_callbacks.clear();
    }
    
    /// Get active tween count
    pub fn active_count(&self) -> usize {
        self.tweens_f32.len() + self.tweens_vec3.len() + self.tweens_color.len()
    }
}

impl Default for TweenGroup {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// CONVENIENCE BUILDERS
// ============================================================================

/// Quick tween builder matching Three.js API
pub struct TweenBuilder;

impl TweenBuilder {
    /// Create a float tween
    pub fn float(start: f32, end: f32) -> Tween<f32> {
        Tween::new(start, end, Duration::from_millis(1000))
    }
    
    /// Create a Vec3 tween
    pub fn vec3(start: Vec3, end: Vec3) -> Tween<Vec3> {
        Tween::new(start, end, Duration::from_millis(1000))
    }
    
    /// Create a color tween
    pub fn color(start: Color, end: Color) -> Tween<Color> {
        Tween::new(start, end, Duration::from_millis(1000))
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_easing_functions() {
        // Test boundary conditions
        for easing in [
            Easing::Linear,
            Easing::CubicOut,
            Easing::ElasticOut,
            Easing::BounceOut,
        ] {
            assert_eq!(easing.apply(0.0), 0.0);
            assert!((easing.apply(1.0) - 1.0).abs() < 0.001);
        }
    }
    
    #[test]
    fn test_tween_update() {
        let mut tween = Tween::new(0.0f32, 100.0, Duration::from_millis(100));
        
        // Update halfway
        assert!(tween.update(Duration::from_millis(50)));
        assert!((tween.current() - 50.0).abs() < 1.0);
        
        // Complete
        assert!(!tween.update(Duration::from_millis(50)));
        assert_eq!(tween.state(), PlaybackState::Finished);
        assert!((tween.current() - 100.0).abs() < 0.001);
    }
    
    #[test]
    fn test_tween_repeat() {
        let mut tween = Tween::new(0.0f32, 100.0, Duration::from_millis(50))
            .with_repeat(2);
        
        // First cycle
        assert!(tween.update(Duration::from_millis(50)));
        
        // Second cycle
        assert!(tween.update(Duration::from_millis(50)));
        
        // Third cycle
        assert!(tween.update(Duration::from_millis(50)));
        
        // Should be finished
        assert!(!tween.update(Duration::from_millis(1)));
        assert_eq!(tween.state(), PlaybackState::Finished);
    }
    
    #[test]
    fn test_tween_yoyo() {
        let mut tween = Tween::new(0.0f32, 100.0, Duration::from_millis(100))
            .with_repeat(1)
            .with_yoyo(true);
        
        // Forward
        tween.update(Duration::from_millis(100));
        assert!((tween.current() - 100.0).abs() < 0.001);
        
        // Reverse (yoyo)
        tween.update(Duration::from_millis(50));
        assert!((tween.current() - 50.0).abs() < 1.0);
    }
    
    #[test]
    fn test_vec3_interpolation() {
        let start = Vec3::new(0.0, 0.0, 0.0);
        let end = Vec3::new(10.0, 20.0, 30.0);
        let mut tween = Tween::new(start, end, Duration::from_millis(100));
        
        tween.update(Duration::from_millis(50));
        let current = *tween.current();
        assert!((current.x - 5.0).abs() < 0.1);
        assert!((current.y - 10.0).abs() < 0.1);
        assert!((current.z - 15.0).abs() < 0.1);
    }
    
    #[test]
    fn test_tween_group() {
        let mut group = TweenGroup::new();
        
        // Add tweens
        group.add_f32("test1", 0.0, 100.0, Duration::from_millis(100))
            .unwrap()
            .with_easing(Easing::CubicOut);
        
        group.add_vec3("test2", Vec3::zero(), Vec3::one(), Duration::from_millis(200))
            .unwrap();
        
        assert_eq!(group.active_count(), 2);
        
        // Update to completion
        group.update(Duration::from_millis(100));
        assert_eq!(group.active_count(), 1); // First tween finished
        
        group.update(Duration::from_millis(100));
        assert_eq!(group.active_count(), 0); // All finished
    }
}