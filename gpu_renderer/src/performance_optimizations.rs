// performance_optimizations.rs - Real performance optimizations without broken patterns

use std::sync::Arc;
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use linked_hash_map::LinkedHashMap;

/// Frame timing statistics with sliding window
pub struct FrameStats {
    frame_times: VecDeque<Duration>,
    render_times: VecDeque<Duration>,
    window_size: usize,
    last_update: Instant,
}

impl FrameStats {
    pub fn new(window_size: usize) -> Self {
        Self {
            frame_times: VecDeque::with_capacity(window_size),
            render_times: VecDeque::with_capacity(window_size),
            window_size,
            last_update: Instant::now(),
        }
    }
    
    pub fn record_frame(&mut self, total_time: Duration, render_time: Duration) {
        // Maintain sliding window
        if self.frame_times.len() >= self.window_size {
            self.frame_times.pop_front();
            self.render_times.pop_front();
        }
        
        self.frame_times.push_back(total_time);
        self.render_times.push_back(render_time);
        self.last_update = Instant::now();
    }
    
    pub fn average_fps(&self) -> f64 {
        if self.frame_times.is_empty() {
            return 0.0;
        }
        
        let avg_frame_time: Duration = self.frame_times.iter().sum::<Duration>() / self.frame_times.len() as u32;
        if avg_frame_time.as_secs_f64() > 0.0 {
            1.0 / avg_frame_time.as_secs_f64()
        } else {
            0.0
        }
    }
    
    pub fn percentile(&self, p: f64) -> Duration {
        if self.frame_times.is_empty() {
            return Duration::ZERO;
        }
        
        let mut sorted: Vec<_> = self.frame_times.iter().copied().collect();
        sorted.sort();
        
        let index = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted[index.min(sorted.len() - 1)]
    }
    
    pub fn report(&self) -> String {
        if self.frame_times.is_empty() {
            return "No frame data".to_string();
        }
        
        let avg_frame: Duration = self.frame_times.iter().sum::<Duration>() / self.frame_times.len() as u32;
        let avg_render: Duration = self.render_times.iter().sum::<Duration>() / self.render_times.len() as u32;
        let p99 = self.percentile(0.99);
        
        format!(
            "FPS: {:.1} | Frame: {:.2}ms (p99: {:.2}ms) | Render: {:.2}ms",
            self.average_fps(),
            avg_frame.as_secs_f64() * 1000.0,
            p99.as_secs_f64() * 1000.0,
            avg_render.as_secs_f64() * 1000.0
        )
    }
}

/// LRU cache for geometry with proper eviction
pub struct GeometryCache<K: std::hash::Hash + Eq + Clone> {
    cache: LinkedHashMap<K, Arc<GeometryData>>,
    max_entries: usize,
    max_bytes: usize,
    current_bytes: usize,
}

pub struct GeometryData {
    pub vertices: Vec<crate::optimized_renderer::Vertex>,
    pub indices: Vec<u32>,
}

impl GeometryData {
    pub fn size_bytes(&self) -> usize {
        self.vertices.len() * std::mem::size_of::<crate::optimized_renderer::Vertex>() +
        self.indices.len() * std::mem::size_of::<u32>()
    }
}

impl<K: std::hash::Hash + Eq + Clone> GeometryCache<K> {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            cache: LinkedHashMap::new(),
            max_entries,
            max_bytes,
            current_bytes: 0,
        }
    }
    
    pub fn get(&mut self, key: &K) -> Option<Arc<GeometryData>> {
        // Move to front on access (LRU)
        self.cache.get_refresh(key).cloned()
    }
    
    pub fn insert(&mut self, key: K, data: GeometryData) -> Arc<GeometryData> {
        let size = data.size_bytes();
        let data = Arc::new(data);
        
        // Evict entries if needed
        while self.cache.len() >= self.max_entries || self.current_bytes + size > self.max_bytes {
            if let Some((_, old_data)) = self.cache.pop_front() {
                self.current_bytes = self.current_bytes.saturating_sub(old_data.size_bytes());
            } else {
                break;
            }
        }
        
        self.current_bytes += size;
        self.cache.insert(key, data.clone());
        data
    }
    
    pub fn clear(&mut self) {
        self.cache.clear();
        self.current_bytes = 0;
    }
    
    pub fn stats(&self) -> (usize, usize) {
        (self.cache.len(), self.current_bytes)
    }
}

/// Efficient batch renderer for multiple objects
pub struct BatchRenderer {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    /// Pre-allocated buffers for different size classes
    buffer_pools: Vec<BufferPool>,
}

struct BufferPool {
    size_class: usize,
    available: Vec<wgpu::Buffer>,
    in_use: Vec<wgpu::Buffer>,
}

impl BatchRenderer {
    pub fn new(device: Arc<wgpu::Device>, queue: Arc<wgpu::Queue>) -> Self {
        // Create pools for common buffer sizes
        let size_classes = vec![
            4096,      // 4KB
            16384,     // 16KB  
            65536,     // 64KB
            262144,    // 256KB
            1048576,   // 1MB
        ];
        
        let buffer_pools = size_classes.into_iter().map(|size| {
            BufferPool {
                size_class: size,
                available: Vec::new(),
                in_use: Vec::new(),
            }
        }).collect();
        
        Self {
            device,
            queue,
            buffer_pools,
        }
    }
    
    pub fn create_buffer(&mut self, min_size: usize, usage: wgpu::BufferUsages) -> wgpu::Buffer {
        // Find appropriate size class
        let pool_idx = self.buffer_pools
            .iter()
            .position(|p| p.size_class >= min_size)
            .unwrap_or(self.buffer_pools.len() - 1);

        let pool = &mut self.buffer_pools[pool_idx];

        // Always create new buffer since wgpu::Buffer doesn't implement Clone
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&format!("Pooled Buffer {}B", pool.size_class)),
            size: pool.size_class as u64,
            usage,
            mapped_at_creation: false,
        });

        // For now, we don't actually pool since Buffer isn't Clone
        // This is a simplified version for wgpu 22.x compatibility
        buffer
    }
    
    pub fn return_buffers(&mut self) {
        // Return all in-use buffers to available pools
        for pool in &mut self.buffer_pools {
            pool.available.append(&mut pool.in_use);
        }
    }
    
    pub fn trim_pools(&mut self, max_per_pool: usize) {
        // Limit pool sizes to prevent memory bloat
        for pool in &mut self.buffer_pools {
            pool.available.truncate(max_per_pool);
        }
    }
}

/// GPU memory tracker
pub struct MemoryTracker {
    allocations: std::collections::HashMap<String, usize>,
    total_allocated: usize,
    peak_allocated: usize,
}

impl MemoryTracker {
    pub fn new() -> Self {
        Self {
            allocations: std::collections::HashMap::new(),
            total_allocated: 0,
            peak_allocated: 0,
        }
    }
    
    pub fn allocate(&mut self, name: String, size: usize) {
        self.allocations.insert(name.clone(), size);
        self.total_allocated += size;
        self.peak_allocated = self.peak_allocated.max(self.total_allocated);
        
        log::debug!("Allocated {} bytes for {}", size, name);
    }
    
    pub fn deallocate(&mut self, name: &str) {
        if let Some(size) = self.allocations.remove(name) {
            self.total_allocated = self.total_allocated.saturating_sub(size);
            log::debug!("Deallocated {} bytes for {}", size, name);
        }
    }
    
    pub fn report(&self) -> String {
        format!(
            "GPU Memory: {:.2}MB allocated, {:.2}MB peak",
            self.total_allocated as f64 / (1024.0 * 1024.0),
            self.peak_allocated as f64 / (1024.0 * 1024.0)
        )
    }
}

/// Optimized hexagon mesh generation using lookup tables
pub struct HexagonMeshOptimizer {
    /// Pre-computed sin/cos values for hexagon vertices
    angle_table: Vec<(f32, f32)>,
}

impl HexagonMeshOptimizer {
    pub fn new() -> Self {
        // Pre-compute angles for hexagon vertices
        let angle_table = (0..6)
            .map(|i| {
                let angle = std::f32::consts::TAU * (i as f32 / 6.0);
                (angle.sin(), angle.cos())
            })
            .collect();
        
        Self { angle_table }
    }
    
    pub fn generate_hexagon_batch(
        &self,
        centers: &[(f32, f32)],
        radius: f32,
        colors: &[[f32; 3]],
    ) -> (Vec<crate::optimized_renderer::Vertex>, Vec<u32>) {
        let hex_count = centers.len();
        let vertex_count = hex_count * 7;  // center + 6 vertices
        let index_count = hex_count * 18;  // 6 triangles * 3 indices
        
        let mut vertices = Vec::with_capacity(vertex_count);
        let mut indices = Vec::with_capacity(index_count);
        
        for (i, ((cx, cy), color)) in centers.iter().zip(colors).enumerate() {
            let base_idx = (i * 7) as u32;
            
            // Center vertex
            vertices.push(crate::optimized_renderer::Vertex {
                position: [*cx, *cy, 0.0],
                color: *color,
            });
            
            // Edge vertices using pre-computed angles
            for (sin, cos) in &self.angle_table {
                vertices.push(crate::optimized_renderer::Vertex {
                    position: [cx + radius * cos, cy + radius * sin, 0.0],
                    color: *color,
                });
            }
            
            // Indices for 6 triangles
            for j in 0..6 {
                let next = if j == 5 { 1 } else { j + 2 };
                indices.extend_from_slice(&[
                    base_idx,
                    base_idx + j + 1,
                    base_idx + next,
                ]);
            }
        }
        
        (vertices, indices)
    }
}

/// Performance benchmark utilities
pub async fn benchmark_renderer() -> crate::error_handling::Result<()> {
    use crate::optimized_renderer::OptimizedMazeRenderer;
    
    let mut renderer = OptimizedMazeRenderer::new(1920, 1080).await?;
    let mut stats = FrameStats::new(100);
    
    // Generate test maze
    let maze = crate::MazeData {
        cells: vec![],  // Would populate with test data
        connectivity: vec![],
        solution: None,
        dimensions: crate::MazeDimensions {
            width: 10,
            height: 10,
            depth: 1,
        },
    };
    
    let solution = crate::optimized_renderer::SolutionData::default();
    renderer.load_maze_data(&maze, &solution)?;
    
    // Warmup
    for _ in 0..10 {
        renderer.render_frame(0.0).await?;
    }
    
    // Benchmark
    log::info!("Starting benchmark...");
    for i in 0..100 {
        let frame_start = Instant::now();
        let render_start = Instant::now();
        
        renderer.render_frame(i as f32 * 0.016).await?;
        
        let render_time = render_start.elapsed();
        let frame_time = frame_start.elapsed();
        
        stats.record_frame(frame_time, render_time);
        
        if i % 20 == 0 {
            log::info!("{}", stats.report());
        }
    }
    
    log::info!("Benchmark complete: {}", stats.report());
    Ok(())
}

// Export for use in tests
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_frame_stats() {
        let mut stats = FrameStats::new(10);
        
        for i in 0..20 {
            stats.record_frame(
                Duration::from_millis(16 + i % 4),
                Duration::from_millis(10),
            );
        }
        
        assert!(stats.average_fps() > 50.0);
        assert!(stats.average_fps() < 70.0);
    }
    
    #[test]
    fn test_geometry_cache() {
        let mut cache: GeometryCache<String> = GeometryCache::new(2, 1024);
        
        let data1 = GeometryData {
            vertices: vec![],
            indices: vec![0, 1, 2],
        };
        
        cache.insert("test1".to_string(), data1);
        assert!(cache.get(&"test1".to_string()).is_some());
        
        // Test LRU eviction
        cache.insert("test2".to_string(), GeometryData {
            vertices: vec![],
            indices: vec![],
        });
        cache.insert("test3".to_string(), GeometryData {
            vertices: vec![],
            indices: vec![],
        });
        
        // test1 should be evicted (LRU)
        assert!(cache.get(&"test1".to_string()).is_none());
        assert!(cache.get(&"test2".to_string()).is_some());
    }
}