// error_handling.rs - Robust error handling and resource managemen

use thiserror::Error;
use std::sync::Arc;

#[derive(Error, Debug)]
pub enum RendererError {
    #[error("WebGPU adapter creation failed")]
    AdapterCreationFailed,

    #[error("WebGPU device creation failed: {0}")]
    DeviceCreationFailed(#[from] wgpu::RequestDeviceError),

    #[error("Buffer operation failed: {message}")]
    BufferError { message: String },

    #[error("Lock acquisition failed")]
    LockError,

    #[error("Texture format {format:?} missing required features: {missing}")]
    FormatFeaturesMissing {
        format: wgpu::TextureFormat,
        missing: String,
    },

    #[error("Shader compilation failed: {0}")]
    ShaderError(String),

    #[error("Image processing failed: {0}")]
    ImageError(#[from] image::ImageError),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Buffer mapping timeout after {elapsed:?}")]
    MappingTimeout {
        elapsed: std::time::Duration,
    },

    #[error("Invalid maze data: {reason}")]
    InvalidMazeData { reason: String },

    #[error("Queue closed")]
    QueueClosed,

    #[error("Pipeline creation failed: {0}")]
    PipelineError(String),

    #[error("Row pitch alignment error: width {width} requires pitch {required} but got {actual}")]
    RowPitchAlignment {
        width: u32,
        required: u32,
        actual: u32,
    },
}

pub type Result<T> = std::result::Result<T, RendererError>;

/// Compute aligned bytes per row for texture copies (must be multiple of 256)
pub fn padded_bytes_per_row(width: u32, bytes_per_pixel: u32) -> u32 {
    let unpadded = width * bytes_per_pixel;
    ((unpadded + 255) / 256) * 256
}

/// Remove row padding from texture data
pub fn unpad_rows(
    padded_data: &[u8],
    width: u32,
    height: u32,
    bytes_per_pixel: u32,
) -> Vec<u8> {
    let unpadded_bpr = width * bytes_per_pixel;
    let padded_bpr = padded_bytes_per_row(width, bytes_per_pixel);
    
    if unpadded_bpr == padded_bpr {
        return padded_data.to_vec();
    }
    
    let mut unpadded = Vec::with_capacity((unpadded_bpr * height) as usize);
    for y in 0..height {
        let start = (y * padded_bpr) as usize;
        let end = start + unpadded_bpr as usize;
        unpadded.extend_from_slice(&padded_data[start..end]);
    }
    unpadded
}

/// Managed buffer with automatic resizing and data preservation
/// Uses Arc to avoid unnecessary cloning of buffer handles
pub struct ManagedBuffer {
    // Store the buffer in an Arc for shared ownership
    buffer: Arc<std::sync::RwLock<BufferState>>,
    label: String,
}

struct BufferState {
    buffer: Arc<wgpu::Buffer>,  // Changed to Arc to avoid cloning
    size: u64,
    usage: wgpu::BufferUsages,
}

impl ManagedBuffer {
    pub fn new(
        device: &wgpu::Device,
        size: u64,
        usage: wgpu::BufferUsages,
        label: impl Into<String>,
    ) -> Self {
        let label = label.into();
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&label),
            size,
            usage: usage | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            buffer: Arc::new(std::sync::RwLock::new(BufferState {
                buffer: Arc::new(buffer),  // Wrap in Arc
                size,
                usage,
            })),
            label,
        }
    }

    /// Returns a shared reference to the buffer without cloning
    pub fn buffer(&self) -> Result<Arc<wgpu::Buffer>> {
        let buffer = self.buffer.read().map_err(|_| RendererError::LockError)?;
        Ok(buffer.buffer.clone())  // Only clones the Arc, not the buffer
    }

    pub fn size(&self) -> Result<u64> {
        let buffer = self.buffer.read().map_err(|_| RendererError::LockError)?;
        Ok(buffer.size)
    }

    /// Resize buffer if needed, preserving existing data
    pub fn ensure_capacity(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        required_size: u64,
    ) -> Result<bool> {
        let mut state = self.buffer.write().map_err(|_| RendererError::LockError)?;
        
        if state.size >= required_size {
            return Ok(false);
        }

        // Align to 64KB pages for fewer reallocations
        let new_size = ((required_size + 65535) / 65536) * 65536;
        
        log::debug!(
            "Resizing buffer '{}' from {} to {} bytes",
            self.label, state.size, new_size
        );

        // Create new buffer
        let new_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&self.label),
            size: new_size,
            usage: state.usage | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Copy old data to new buffer
        encoder.copy_buffer_to_buffer(
            &state.buffer,
            0,
            &new_buffer,
            0,
            state.size,
        );

        state.buffer = Arc::new(new_buffer);  // Wrap in Arc
        state.size = new_size;
        Ok(true)
    }

    /// Get a reference that can be used with wgpu APIs
    /// This avoids lifetime issues while preventing unnecessary clones
    pub fn with_buffer<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&wgpu::Buffer) -> R,
    {
        let guard = self.buffer.read().map_err(|_| RendererError::LockError)?;
        Ok(f(&guard.buffer))
    }
}

/// Alternative buffer wrapper using just Arc without RwLock for simpler cases
pub struct SharedBuffer {
    buffer: Arc<wgpu::Buffer>,
    size: u64,
    usage: wgpu::BufferUsages,
    label: String,
}

impl SharedBuffer {
    pub fn new(
        device: &wgpu::Device,
        size: u64,
        usage: wgpu::BufferUsages,
        label: impl Into<String>,
    ) -> Self {
        let label = label.into();
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&label),
            size,
            usage,
            mapped_at_creation: false,
        });

        Self {
            buffer: Arc::new(buffer),
            size,
            usage,
            label,
        }
    }

    /// Returns the Arc-wrapped buffer - cheap to clone
    pub fn buffer(&self) -> Arc<wgpu::Buffer> {
        self.buffer.clone()
    }

    /// Get a reference for use with wgpu APIs
    pub fn as_ref(&self) -> &wgpu::Buffer {
        &self.buffer
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    /// Create a new larger buffer and return it (does not preserve data)
    pub fn resize(
        &mut self,
        device: &wgpu::Device,
        new_size: u64,
    ) -> Arc<wgpu::Buffer> {
        let aligned_size = ((new_size + 65535) / 65536) * 65536;
        
        log::debug!(
            "Creating new buffer '{}' with size {} bytes (was {})",
            self.label, aligned_size, self.size
        );

        let new_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&self.label),
            size: aligned_size,
            usage: self.usage,
            mapped_at_creation: false,
        });

        self.buffer = Arc::new(new_buffer);
        self.size = aligned_size;
        self.buffer.clone()
    }
}

/// Resource tracker for debugging and leak detection
pub struct ResourceTracker {
    inner: Arc<TrackerInner>,
}

struct TrackerInner {
    active_buffers: std::sync::atomic::AtomicU64,
    active_textures: std::sync::atomic::AtomicU64,
    active_pipelines: std::sync::atomic::AtomicU64,
}

impl ResourceTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(TrackerInner {
                active_buffers: std::sync::atomic::AtomicU64::new(0),
                active_textures: std::sync::atomic::AtomicU64::new(0),
                active_pipelines: std::sync::atomic::AtomicU64::new(0),
            }),
        })
    }

    pub fn track_buffer(self: &Arc<Self>) -> TrackedResource {
        self.inner.active_buffers.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        TrackedResource {
            tracker: Arc::downgrade(&self.inner),
            resource_type: ResourceType::Buffer,
        }
    }

    pub fn track_texture(self: &Arc<Self>) -> TrackedResource {
        self.inner.active_textures.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        TrackedResource {
            tracker: Arc::downgrade(&self.inner),
            resource_type: ResourceType::Texture,
        }
    }

    pub fn track_pipeline(self: &Arc<Self>) -> TrackedResource {
        self.inner.active_pipelines.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        TrackedResource {
            tracker: Arc::downgrade(&self.inner),
            resource_type: ResourceType::Pipeline,
        }
    }

    pub fn active_resources(&self) -> (u64, u64, u64) {
        (
            self.inner.active_buffers.load(std::sync::atomic::Ordering::Acquire),
            self.inner.active_textures.load(std::sync::atomic::Ordering::Acquire),
            self.inner.active_pipelines.load(std::sync::atomic::Ordering::Acquire),
        )
    }
}

#[derive(Debug)]
enum ResourceType {
    Buffer,
    Texture,
    Pipeline,
}

pub struct TrackedResource {
    tracker: std::sync::Weak<TrackerInner>,
    resource_type: ResourceType,
}

impl Drop for TrackedResource {
    fn drop(&mut self) {
        if let Some(tracker) = self.tracker.upgrade() {
            match self.resource_type {
                ResourceType::Buffer => {
                    tracker.active_buffers.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                }
                ResourceType::Texture => {
                    tracker.active_textures.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                }
                ResourceType::Pipeline => {
                    tracker.active_pipelines.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                }
            }
        }
    }
}

/// Validate texture format features - simplified for wgpu 22.x compatibility
pub fn validate_format_features(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    required_features: &str,
) -> Result<()> {
    // In wgpu 22.x, most common formats support the features we need
    // For now, we'll validate against known supported formats
    match format {
        wgpu::TextureFormat::Rgba8Unorm
        | wgpu::TextureFormat::Bgra8Unorm
        | wgpu::TextureFormat::Rgba16Float
        | wgpu::TextureFormat::Rgba32Float => {
            // These formats are widely supported
            Ok(())
        }
        _ => {
            // For other formats, we'll assume they're supported and let wgpu handle validation
            log::warn!("Using untested texture format {:?} with features: {}", format, required_features);
            Ok(())
        }
    }
}

/// Helper for wgpu buffer mapping with timeout
pub async fn map_buffer_async(
    buffer: &wgpu::Buffer,
    mode: wgpu::MapMode,
    timeout: std::time::Duration,
) -> Result<()> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    
    buffer.slice(..).map_async(mode, move |result| {
        let _ = sender.send(result);
    });
    
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(e))) => Err(RendererError::BufferError { 
            message: format!("Buffer mapping failed: {:?}", e) 
        }),
        Ok(Err(_)) => Err(RendererError::BufferError { 
            message: "Buffer mapping callback dropped".into() 
        }),
        Err(_) => Err(RendererError::MappingTimeout { elapsed: timeout }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_padded_bytes_per_row() {
        assert_eq!(padded_bytes_per_row(256, 4), 1024);
        assert_eq!(padded_bytes_per_row(257, 4), 1280); // 257*4 = 1028, rounds to 1280
        assert_eq!(padded_bytes_per_row(64, 4), 256);
    }

    #[test]
    fn test_unpad_rows() {
        let width = 65;
        let height = 2;
        let bpp = 4;
        let padded_bpr = padded_bytes_per_row(width, bpp);
        
        // Create padded data
        let mut padded = vec![0u8; (padded_bpr * height) as usize];
        for y in 0..height {
            for x in 0..width {
                let idx = (y * padded_bpr + x * bpp) as usize;
                padded[idx] = (x % 256) as u8;
            }
        }
        
        let unpadded = unpad_rows(&padded, width, height, bpp);
        assert_eq!(unpadded.len(), (width * height * bpp) as usize);
        
        // Verify data preserved
        for y in 0..height {
            for x in 0..width {
                let idx = (y * width * bpp + x * bpp) as usize;
                assert_eq!(unpadded[idx], (x % 256) as u8);
            }
        }
    }
}
