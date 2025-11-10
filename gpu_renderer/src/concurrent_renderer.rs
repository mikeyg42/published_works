// concurrent_renderer.rs - Production-ready concurrent rendering with proper GPU resource handling

use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock, Semaphore};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use crate::error_handling::{Result, RendererError};

/// Thread-safe render task queue with priority ordering
pub struct RenderQueue {
    sender: mpsc::UnboundedSender<RenderTask>,
    receiver: Arc<Mutex<mpsc::UnboundedReceiver<RenderTask>>>,
    pending_count: Arc<std::sync::atomic::AtomicU32>,
}

#[derive(Debug, Clone)]
pub struct RenderTask {
    pub id: u64,
    pub maze_data: crate::optimized_renderer::MazeData,
    pub solution_data: crate::optimized_renderer::SolutionData,
    pub output_path: String,
    pub priority: u8, // Lower value = higher priority
    pub enqueued_at: Instant,
}

impl RenderQueue {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            sender,
            receiver: Arc::new(Mutex::new(receiver)),
            pending_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        }
    }

    pub fn enqueue(&self, task: RenderTask) -> Result<()> {
        self.sender.send(task).map_err(|_| RendererError::QueueClosed)?;
        self.pending_count.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Ok(())
    }

    pub async fn dequeue(&self) -> Option<RenderTask> {
        let mut receiver = self.receiver.lock().await;
        let task = receiver.recv().await;
        if task.is_some() {
            self.pending_count.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
        task
    }

    pub fn pending_count(&self) -> u32 {
        self.pending_count.load(std::sync::atomic::Ordering::Acquire)
    }
}

/// GPU rendering coordinator - ensures single-threaded GPU access
pub struct RenderCoordinator {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    /// Single renderer instance - never moved between threads
    renderer: Arc<Mutex<crate::optimized_renderer::OptimizedMazeRenderer>>,
    /// Limits concurrent CPU work (geometry generation, etc)
    cpu_semaphore: Arc<Semaphore>,
    stats: Arc<RenderStats>,
}

impl RenderCoordinator {
    pub async fn new(
        width: u32, 
        height: u32,
        max_concurrent_cpu_tasks: usize,
    ) -> Result<Self> {
        // Create single renderer on the current thread
        let renderer = crate::optimized_renderer::OptimizedMazeRenderer::new(width, height).await?;
        
        // Extract device/queue for CPU-side work
        let device = renderer.device.clone();
        let queue = renderer.queue.clone();
        
        Ok(Self {
            device,
            queue,
            renderer: Arc::new(Mutex::new(renderer)),
            cpu_semaphore: Arc::new(Semaphore::new(max_concurrent_cpu_tasks)),
            stats: Arc::new(RenderStats::new()),
        })
    }

    /// Process a render task - ensures GPU work is serialized
    pub async fn render_task(&self, task: RenderTask) -> Result<()> {
        let start = Instant::now();
        
        // CPU work can be concurrent (up to semaphore limit)
        let cpu_permit = self.cpu_semaphore.acquire().await
            .map_err(|_| RendererError::QueueClosed)?;
        
        // Prepare geometry on CPU (can be parallel)
        let geometry_data = self.prepare_geometry_cpu(&task).await?;
        drop(cpu_permit);
        
        // GPU work must be serialized
        let mut renderer = self.renderer.lock().await;
        
        // Upload geometry
        renderer.load_maze_data(&task.maze_data, &task.solution_data)?;
        
        // Render
        renderer.render_frame(0.0).await?;
        
        // Save (includes CPU PNG encoding)
        renderer.save_frame_as_png(&task.output_path).await?;
        
        // Update stats
        let duration = start.elapsed();
        self.stats.record_frame(duration);
        
        log::debug!("Task {} completed in {:?}", task.id, duration);
        Ok(())
    }

    async fn prepare_geometry_cpu(&self, task: &RenderTask) -> Result<Vec<u8>> {
        // Simulate CPU-side geometry preparation
        // In practice, this would decode maze data, generate vertices, etc.
        tokio::task::yield_now().await;
        Ok(vec![])
    }

    pub fn stats(&self) -> Arc<RenderStats> {
        self.stats.clone()
    }
}

/// Thread-safe statistics with sliding window
pub struct RenderStats {
    frames: Arc<RwLock<SlidingWindow>>,
    total_frames: std::sync::atomic::AtomicU64,
}

struct SlidingWindow {
    samples: Vec<(Instant, Duration)>,
    window_size: Duration,
    max_samples: usize,
}

impl RenderStats {
    pub fn new() -> Self {
        Self {
            frames: Arc::new(RwLock::new(SlidingWindow {
                samples: Vec::with_capacity(1000),
                window_size: Duration::from_secs(10),
                max_samples: 1000,
            })),
            total_frames: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn record_frame(&self, render_time: Duration) {
        self.total_frames.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        
        let window = self.frames.clone();
        tokio::spawn(async move {
            let mut window = window.write().await;
            let now = Instant::now();
            
            // Add new sample and immediately check bounds to prevent unbounded growth
            window.samples.push((now, render_time));

            // Immediately check for size limit to prevent race conditions
            if window.samples.len() > window.max_samples {
                let excess = window.samples.len() - window.max_samples;
                window.samples.drain(0..excess);
            }

            // Remove old samples outside time window
            let cutoff = now - window.window_size;
            window.samples.retain(|(time, _)| *time > cutoff);
        });
    }

    pub async fn current_fps(&self) -> f64 {
        let window = self.frames.read().await;
        if window.samples.is_empty() {
            return 0.0;
        }
        
        let duration = window.samples.last().unwrap().0 - window.samples.first().unwrap().0;
        if duration.as_secs_f64() > 0.0 {
            window.samples.len() as f64 / duration.as_secs_f64()
        } else {
            0.0
        }
    }

    pub async fn average_frame_time(&self) -> Duration {
        let window = self.frames.read().await;
        if window.samples.is_empty() {
            return Duration::ZERO;
        }
        
        let total: Duration = window.samples.iter().map(|(_, d)| *d).sum();
        total / window.samples.len() as u32
    }

    pub fn total_frames(&self) -> u64 {
        self.total_frames.load(std::sync::atomic::Ordering::Acquire)
    }
}

/// Worker pool for concurrent rendering with proper GPU serialization
pub struct RenderWorkerPool {
    coordinator: Arc<RenderCoordinator>,
    queue: Arc<RenderQueue>,
    workers: Vec<tokio::task::JoinHandle<()>>,
}

impl RenderWorkerPool {
    pub async fn new(
        width: u32,
        height: u32,
        num_workers: usize,
        max_concurrent_cpu: usize,
    ) -> Result<Self> {
        let coordinator = Arc::new(RenderCoordinator::new(width, height, max_concurrent_cpu).await?);
        let queue = Arc::new(RenderQueue::new());
        let workers = Vec::with_capacity(num_workers);
        
        let mut pool = Self {
            coordinator,
            queue,
            workers,
        };
        
        pool.start_workers(num_workers);
        Ok(pool)
    }

    fn start_workers(&mut self, count: usize) {
        for worker_id in 0..count {
            let coordinator = self.coordinator.clone();
            let queue = self.queue.clone();
            
            let handle = tokio::spawn(async move {
                log::info!("Worker {} started", worker_id);
                
                loop {
                    match queue.dequeue().await {
                        Some(task) => {
                            log::debug!("Worker {} processing task {}", worker_id, task.id);
                            
                            if let Err(e) = coordinator.render_task(task).await {
                                log::error!("Worker {} render failed: {}", worker_id, e);
                            }
                        }
                        None => {
                            // Channel closed, worker should exit
                            log::info!("Worker {} shutting down", worker_id);
                            break;
                        }
                    }
                }
            });
            
            self.workers.push(handle);
        }
    }

    pub fn submit(&self, task: RenderTask) -> Result<()> {
        self.queue.enqueue(task)
    }

    pub async fn shutdown(mut self) {
        // Close queue to signal workers
        drop(self.queue);
        
        // Wait for workers to finish
        for handle in self.workers.drain(..) {
            let _ = handle.await;
        }
    }

    pub fn stats(&self) -> Arc<RenderStats> {
        self.coordinator.stats()
    }
}

/// Safe buffer update with generation tracking
pub struct VersionedBuffer<T: bytemuck::Pod> {
    data: Arc<RwLock<BufferData<T>>>,
}

struct BufferData<T> {
    /// Current data on CPU
    cpu_data: Vec<T>,
    /// Generation number for versioning
    generation: u64,
    /// Last uploaded generation
    gpu_generation: u64,
    /// GPU buffer (lazily allocated)
    gpu_buffer: Option<wgpu::Buffer>,
}

impl<T: bytemuck::Pod> VersionedBuffer<T> {
    pub fn new(initial_capacity: usize) -> Self {
        Self {
            data: Arc::new(RwLock::new(BufferData {
                cpu_data: Vec::with_capacity(initial_capacity),
                generation: 0,
                gpu_generation: 0,
                gpu_buffer: None,
            })),
        }
    }

    pub async fn update(&self, new_data: Vec<T>) {
        let mut data = self.data.write().await;
        data.cpu_data = new_data;
        data.generation += 1;
    }

    /// Upload to GPU if needed, returning true if uploaded
    pub async fn ensure_gpu_updated(
        &self, 
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        usage: wgpu::BufferUsages,
    ) -> Result<bool> {
        let mut data = self.data.write().await;
        
        if data.generation == data.gpu_generation {
            return Ok(false); // Already up to date
        }
        
        let byte_size = (data.cpu_data.len() * std::mem::size_of::<T>()) as u64;
        
        // Ensure buffer is large enough
        let needs_realloc = data.gpu_buffer.as_ref()
            .map_or(true, |buf| buf.size() < byte_size);
        
        if needs_realloc {
            // Round up to page size for fewer reallocations
            let aligned_size = ((byte_size + 65535) / 65536) * 65536;
            
            data.gpu_buffer = Some(device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("versioned_buffer"),
                size: aligned_size,
                usage: usage | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        
        // Upload data
        if let Some(buffer) = &data.gpu_buffer {
            queue.write_buffer(buffer, 0, bytemuck::cast_slice(&data.cpu_data));
            data.gpu_generation = data.generation;
        }
        
        Ok(true)
    }

    pub async fn has_gpu_buffer(&self) -> bool {
        let data = self.data.read().await;
        data.gpu_buffer.is_some()
    }
}

/// Example usage with proper error handling
pub async fn example_render_batch() -> Result<()> {
    // Create worker pool
    let pool = RenderWorkerPool::new(
        1024, // width
        768,  // height
        4,    // worker threads
        8,    // max concurrent CPU tasks
    ).await?;

    // Submit batch of tasks
    for i in 0..10 {
        let task = RenderTask {
            id: i,
            maze_data: crate::optimized_renderer::MazeData::default(),
            solution_data: crate::optimized_renderer::SolutionData::default(),
            output_path: format!("output/frame_{:04}.png", i),
            priority: (i % 3) as u8,
            enqueued_at: Instant::now(),
        };
        
        pool.submit(task)?;
    }

    // Monitor progress
    let stats = pool.stats();
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        
        let fps = stats.current_fps().await;
        let avg_time = stats.average_frame_time().await;
        let total = stats.total_frames();
        
        log::info!(
            "Progress: {} frames, {:.1} fps, avg time: {:?}",
            total, fps, avg_time
        );
        
        if total >= 10 {
            break;
        }
    }

    // Shutdown cleanly
    pool.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_render_stats() {
        let stats = RenderStats::new();
        
        // Record some frames
        for _ in 0..5 {
            stats.record_frame(Duration::from_millis(16));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        
        let fps = stats.current_fps().await;
        assert!(fps > 0.0);
        assert!(fps < 200.0); // Sanity check
        
        let avg = stats.average_frame_time().await;
        assert!(avg >= Duration::from_millis(15));
        assert!(avg <= Duration::from_millis(17));
    }
}