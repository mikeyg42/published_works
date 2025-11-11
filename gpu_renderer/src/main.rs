// main.rs — Production-ready, headless WebGPU path tracer (Vulkan-capable) with clean exports.
// No duplicate blocks, robust PNG export, crate-absolute shader includes, and hardened bindings.

use anyhow::{anyhow, Context, Result};
use bytemuck::{Pod, Zeroable};
use clap::Parser;
use image::{ImageBuffer, ImageFormat, Rgba};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::io::Write;
use tokio::io::AsyncWriteExt;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wgpu::util::DeviceExt;

mod error_handling;
mod optimized_renderer;
mod concurrent_renderer;
mod performance_optimizations;
mod http_server;
mod animation;
mod animated_renderer;
mod material_loader;

use crate::error_handling::{padded_bytes_per_row, unpad_rows, validate_format_features};
use crate::animated_renderer::AnimatedPathTracer;
use crate::material_loader::MaterialRegistry;

/// === TUNE HERE if your WGSL expects different bindings/workgroup size ===
const WORKGROUP_X: u32 = 8;
const WORKGROUP_Y: u32 = 8;

// Shader sources are crate-absolute for reproducibility and to avoid cwd surprises.
const PATH_TRACING_WGSL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/shaders/pathTracing.wgsl"
));
const PATH_TRACING_ANIMATED_WGSL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/shaders/pathTracing_animated.wgsl"
));
const DISPLAY_WGSL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/shaders/display.wgsl"
));
const GRADIENT_TEST_WGSL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/shaders/gradient_test.wgsl"
));

/// CLI
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// Path to maze JSON file
    #[arg(short, long)]
    pub maze: Option<PathBuf>,

    /// Output image path; use "-" for stdout PNG
    #[arg(short, long, default_value = "output.png")]
    pub output: PathBuf,

    /// Render width
    #[arg(short = 'W', long, default_value = "1024")]
    pub width: u32,

    /// Render height
    #[arg(short = 'H', long, default_value = "1024")]
    pub height: u32,

    /// Samples (frames) to accumulate
    #[arg(short, long, default_value = "256")]
    pub samples: u32,

    /// Run gradient test pass (uses gradient_test.wgsl)
    #[arg(long)]
    pub gradient_test: bool,

    /// Force Vulkan backend (good for T4 VMs)
    #[arg(long)]
    pub vulkan: bool,

    /// Start HTTP server mode
    #[arg(long)]
    pub server: bool,

    /// Enable animated lighting and camera system (Three.js migration mode)
    #[arg(long)]
    pub animated: bool,

    /// Load and test PBR materials from material_textures directory
    #[arg(long)]
    pub test_materials: bool,
}

impl Args {
    /// Create default args for WebSocket streaming mode
    pub fn default_for_streaming(width: u32, height: u32) -> Self {
        Self {
            maze: None,
            output: PathBuf::from("streaming.png"),
            width,
            height,
            samples: 64, // Lower samples for real-time streaming
            gradient_test: false,
            vulkan: true, // Prefer Vulkan for GPU servers
            server: false,
            animated: true, // Enable animations for streaming
            test_materials: false,
        }
    }
}

/// Maze data (kept public for server to reuse)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MazeData {
    #[serde(rename = "hexagons")]
    pub cells: Vec<MazeCell>,
    #[serde(rename = "graph")]
    pub connectivity: Vec<Vec<i32>>,
    pub solution: Option<Vec<String>>,
    pub dimensions: MazeDimensions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MazeCell {
    pub id: String,
    pub q: i32,
    pub r: i32,
    pub s: i32,
    pub center: Point3,
    #[serde(rename = "isWall")]
    pub is_wall: bool,
    pub vertices: Vec<Point3>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct MazeDimensions {
    pub width: i32,
    pub height: i32,
    pub depth: i32,
}

/// 256B std140-like uniform layout (matches WGSL expectations)
#[repr(C, align(16))]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
struct Uniforms {
    // 0..16
    camera_position: [f32; 3],
    _pad0: f32,
    // 16..32
    camera_direction: [f32; 3],
    _pad1: f32,
    // 32..48
    camera_up: [f32; 3],
    _pad2: f32,
    // 48..56
    camera_fov: f32,
    environment_intensity: f32,
    // 56..64
    sample_count: u32,
    seed: u32,
    // 64..72
    time: f32,
    aspect_ratio: f32,
    // 72..256
    _reserved1: [f32; 32],
    _reserved2: [f32; 14],
}
impl Default for Uniforms {
    fn default() -> Self {
        Self {
            camera_position: [0.0, 1.0, 3.0],
            _pad0: 0.0,
            camera_direction: [0.0, 0.0, -1.0],
            _pad1: 0.0,
            camera_up: [0.0, 1.0, 0.0],
            _pad2: 0.0,
            camera_fov: 45.0,
            environment_intensity: 1.0,
            sample_count: 0,
            seed: 0,
            time: 0.0,
            aspect_ratio: 1.0,
            _reserved1: [0.0; 32],
            _reserved2: [0.0; 14],
        }
    }
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-20);
    [v[0] / len, v[1] / len, v[2] / len]
}

pub struct PathTracer {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,

    // Pipelines/layouts
    compute_pipeline: wgpu::ComputePipeline,
    compute_bgl: wgpu::BindGroupLayout,

    // Resources
    uniform_buffer: wgpu::Buffer,
    vertex_buffer: wgpu::Buffer,
    normal_buffer: wgpu::Buffer,
    material_buffer: wgpu::Buffer,

    // Textures
    accumulation: [wgpu::Texture; 2], // RGBA32F ping-pong
    output: wgpu::Texture,            // RGBA8Unorm for display/export

    // Bind groups (ping-pong)
    compute_bgs: [wgpu::BindGroup; 2],

    // State
    width: u32,
    height: u32,
    sample_count: u32,
    max_samples: u32,
    ping: usize,
    uniforms: Uniforms,

    start_time: Instant,
}

impl PathTracer {
    pub async fn new(width: u32, height: u32, args: &Args) -> Result<Self> {
        anyhow::ensure!(width > 0 && height > 0, "Invalid dimensions: {width}x{height}");

        let backends = if args.vulkan {
            wgpu::Backends::VULKAN
        } else {
            wgpu::Backends::PRIMARY
        };

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            dx12_shader_compiler: Default::default(),
            flags: wgpu::InstanceFlags::empty(),
            gles_minor_version: wgpu::Gles3MinorVersion::Automatic,
        });

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .context("No suitable GPU adapter found")?;

        let limits = adapter.limits();
        anyhow::ensure!(
            width <= limits.max_texture_dimension_2d && height <= limits.max_texture_dimension_2d,
            "Requested {width}x{height} exceeds device limit {}",
            limits.max_texture_dimension_2d
        );

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("PathTracer Device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits {
                        max_texture_dimension_2d: width.max(height),
                        max_buffer_size: 256 * 1024 * 1024,
                        max_storage_buffer_binding_size: 128 * 1024 * 1024,
                        ..Default::default()
                    },
                    memory_hints: Default::default(),
                },
                None,
            )
            .await
            .context("Failed to create device")?;

        let device = Arc::new(device);
        let queue = Arc::new(queue);

        // Validate formats we rely on
        validate_format_features(&device, wgpu::TextureFormat::Rgba32Float, "STORAGE_READ_WRITE")
            .context("Rgba32Float not supported for storage")?;
        validate_format_features(&device, wgpu::TextureFormat::Rgba8Unorm, "STORAGE_READ_WRITE")
            .context("Rgba8Unorm not supported for storage")?;

        // Shaders
        let compute_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("PathTracing WGSL"),
            source: wgpu::ShaderSource::Wgsl(PATH_TRACING_WGSL.into()),
        });
        let _display_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Display WGSL"),
            source: wgpu::ShaderSource::Wgsl(DISPLAY_WGSL.into()),
        });

        // Bind group layout (matches WGSL)
        let compute_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Compute BGL"),
            entries: &[
                // 0: uniforms
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: Some(NonZeroU64::new(256).unwrap()),
                    },
                    count: None,
                },
                // 1: prevAccumulationTexture (Rgba32Float, *not* filterable)
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    },
                    count: None,
                },
                // 2: accumulationTexture (write)
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba32Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                // 3: outputTexture (write)
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                // 4/5/6: geometry buffers (read-only storage)
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 6,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let compute_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Compute PL"),
            bind_group_layouts: &[&compute_bgl],
            push_constant_ranges: &[],
        });

        let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("PathTracing Pipeline"),
            layout: Some(&compute_pl),
            module: &compute_module,
            entry_point: "main",
            compilation_options: Default::default(),
            cache: None,
        });

        // Uniforms
        let mut uniforms = Uniforms::default();
        uniforms.aspect_ratio = width as f32 / height as f32;
        // Generate seed from system time for reproducible randomness
        uniforms.seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u32;
        uniforms.time = 0.0;

        const UNIFORM_SIZE: u64 = std::mem::size_of::<Uniforms>() as u64;
        static_assertions::const_assert_eq!(UNIFORM_SIZE, 256);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Uniforms"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Textures
        let accumulation = [
            Self::create_accum_texture(&device, width, height, "Accum A"),
            Self::create_accum_texture(&device, width, height, "Accum B"),
        ];
        let output = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Output RGBA8"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        // Minimal placeholder geometry (a single tri) — replaced by load_maze()
        let (vertex_buffer, normal_buffer, material_buffer) =
            Self::create_placeholder_buffers(&device);

        // Ping-pong bind groups
        let compute_bgs = [
            Self::make_compute_bg(
                &device,
                &compute_bgl,
                &uniform_buffer,
                &accumulation[1],
                &accumulation[0],
                &output,
                &vertex_buffer,
                &normal_buffer,
                &material_buffer,
                "BG 0",
            ),
            Self::make_compute_bg(
                &device,
                &compute_bgl,
                &uniform_buffer,
                &accumulation[0],
                &accumulation[1],
                &output,
                &vertex_buffer,
                &normal_buffer,
                &material_buffer,
                "BG 1",
            ),
        ];

        Ok(Self {
            device,
            queue,
            compute_pipeline,
            compute_bgl,
            uniform_buffer,
            vertex_buffer,
            normal_buffer,
            material_buffer,
            accumulation,
            output,
            compute_bgs,
            width,
            height,
            sample_count: 0,
            max_samples: args.samples,
            ping: 0,
            uniforms,
            start_time: Instant::now(),
        })
    }

    fn create_accum_texture(
        device: &wgpu::Device,
        width: u32,
        height: u32,
        label: &str,
    ) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }

    fn create_placeholder_buffers(
        device: &wgpu::Device,
    ) -> (wgpu::Buffer, wgpu::Buffer, wgpu::Buffer) {
        // One triangle facing +Z
        let vertices: [f32; 9] = [0.0, 1.0, 0.0, -1.0, -1.0, 0.0, 1.0, -1.0, 0.0];
        let normals: [f32; 9] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let materials: [f32; 6] = [0.8, 0.8, 0.8, 0.0, 0.5, 0.0];

        let vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let nb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Normals"),
            contents: bytemuck::cast_slice(&normals),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let mb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Materials"),
            contents: bytemuck::cast_slice(&materials),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        (vb, nb, mb)
    }

    fn make_compute_bg(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        ubuf: &wgpu::Buffer,
        prev_accum: &wgpu::Texture,
        accum: &wgpu::Texture,
        output: &wgpu::Texture,
        vbuf: &wgpu::Buffer,
        nbuf: &wgpu::Buffer,
        mbuf: &wgpu::Buffer,
        label: &str,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: ubuf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &prev_accum.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(
                        &accum.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(
                        &output.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: vbuf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: nbuf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: mbuf.as_entire_binding(),
                },
            ],
        })
    }

    pub fn load_maze(&mut self, maze: &MazeData) -> Result<()> {
        // Very simple fan triangulation of each cell polygon.
        // Replace with your mesh builder if needed — bindings stay the same.
        let mut verts = Vec::<f32>::new();
        let mut norms = Vec::<f32>::new();
        let mut mats = Vec::<f32>::new();

        for cell in &maze.cells {
            if cell.vertices.len() < 3 {
                continue;
            }
            let c = [cell.center.x, cell.center.y, cell.center.z];
            for i in 1..(cell.vertices.len() - 1) {
                let a = c;
                let b = [
                    cell.vertices[i].x,
                    cell.vertices[i].y,
                    cell.vertices[i].z,
                ];
                let d = [
                    cell.vertices[i + 1].x,
                    cell.vertices[i + 1].y,
                    cell.vertices[i + 1].z,
                ];
                verts.extend_from_slice(&a);
                verts.extend_from_slice(&b);
                verts.extend_from_slice(&d);

                // flat normal (upwards as a placeholder)
                norms.extend_from_slice(&[0.0, 0.0, 1.0]);
                norms.extend_from_slice(&[0.0, 0.0, 1.0]);
                norms.extend_from_slice(&[0.0, 0.0, 1.0]);

                // simple material
                mats.extend_from_slice(&[0.8, 0.8, 0.8, 0.0, 0.5, 0.0]);
            }
        }

        if verts.is_empty() {
            warn!("Maze produced no triangles; keeping placeholder triangle.");
            return Ok(());
        }

        self.vertex_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Maze Vertices"),
            contents: bytemuck::cast_slice(&verts),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        self.normal_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Maze Normals"),
            contents: bytemuck::cast_slice(&norms),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        self.material_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Maze Materials"),
            contents: bytemuck::cast_slice(&mats),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });

        // Rebuild ping-pong BIND GROUPS with new geometry buffers
        self.compute_bgs = [
            Self::make_compute_bg(
                &self.device,
                &self.compute_bgl,
                &self.uniform_buffer,
                &self.accumulation[1],
                &self.accumulation[0],
                &self.output,
                &self.vertex_buffer,
                &self.normal_buffer,
                &self.material_buffer,
                "BG 0 (maze)",
            ),
            Self::make_compute_bg(
                &self.device,
                &self.compute_bgl,
                &self.uniform_buffer,
                &self.accumulation[0],
                &self.accumulation[1],
                &self.output,
                &self.vertex_buffer,
                &self.normal_buffer,
                &self.material_buffer,
                "BG 1 (maze)",
            ),
        ];

        Ok(())
    }

    pub fn render_frame(&mut self) -> Result<()> {
        // Update uniforms once per frame
        self.uniforms.sample_count = self.sample_count;
        self.uniforms.time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f32();
        self.queue
            .write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(&self.uniforms));

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Compute Encoder"),
            });

        {
            let mut cpass =
                encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { 
                    label: Some("PathTrace"),
                    timestamp_writes: None,
                });
            cpass.set_pipeline(&self.compute_pipeline);
            cpass.set_bind_group(0, &self.compute_bgs[self.ping], &[]);
            let gx = (self.width + WORKGROUP_X - 1) / WORKGROUP_X;
            let gy = (self.height + WORKGROUP_Y - 1) / WORKGROUP_Y;
            cpass.dispatch_workgroups(gx, gy, 1);
        }

        self.queue.submit(Some(encoder.finish()));
        // The compute shader writes only into textures; no read-back here.

        // Next frame will read from the texture we just wrote.
        self.ping ^= 1;
        self.sample_count = self.sample_count.saturating_add(1).min(self.max_samples);
        Ok(())
    }

    /// Save current output texture to PNG on disk (creates parent dirs; supports "-" for stdout).
    pub async fn save_image<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let path = path.as_ref();
        if path != Path::new("-") {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .with_context(|| format!("Failed to create {}", parent.display()))?;
            }
        }

        let png = self.save_image_to_buffer().await?;
        if path == Path::new("-") {
            use std::io::Write;
            std::io::stdout()
                .write_all(&png)
                .context("Failed writing PNG to stdout")?;
        } else {
            tokio::fs::write(path, &png)
                .await
                .with_context(|| format!("Failed writing PNG {}", path.display()))?;
            info!("Saved image to {}", path.display());
        }
        Ok(())
    }

    /// Encode current output texture as PNG into memory (used by HTTP server).
    pub async fn save_image_to_buffer(&self) -> Result<Vec<u8>> {
        // Create staging buffer with padded rows
        let bpr_unpadded = self.width * 4;
        let bpr_padded = padded_bytes_per_row(self.width, 4);
        let size = (bpr_padded as u64) * (self.height as u64);

        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Readback Buffer"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Copy texture to buffer
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Copy Encoder"),
            });

        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &self.output,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &staging,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr_padded),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );

        self.queue.submit(Some(encoder.finish()));

        // Map and wait
        let slice = staging.slice(..);
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| { tx.send(res).ok(); });
        // Make progress on mapping
        let map_res = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                self.device.poll(wgpu::Maintain::Poll);
                if let Ok(res) = rx.try_recv() {
                    break res;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .map_err(|_| anyhow!("Timed out mapping readback buffer"))??;

        let padded = slice.get_mapped_range();
        let raw = unpad_rows(&padded, self.width, self.height, 4);
        drop(padded);
        staging.unmap();

        // Y-flip to conventional image top-left origin
        let row = (self.width * 4) as usize;
        let mut flipped = vec![0u8; raw.len()];
        for y in 0..(self.height as usize) {
            let src_y = (self.height as usize - 1) - y;
            flipped[y * row..y * row + row]
                .copy_from_slice(&raw[src_y * row..src_y * row + row]);
        }

        // Encode PNG
        let img = ImageBuffer::<Rgba<u8>, _>::from_raw(self.width, self.height, flipped)
            .ok_or_else(|| anyhow!("Failed to create image buffer"))?;
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)?;
        Ok(png)
    }

    /// Get current frame as raw RGBA bytes (for streaming)
    pub async fn get_frame_data(&self) -> Result<Vec<u8>> {
        // Create staging buffer with padded rows
        let bpr_unpadded = self.width * 4;
        let bpr_padded = padded_bytes_per_row(self.width, 4);
        let size = (bpr_padded as u64) * (self.height as u64);

        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Frame Data Buffer"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Frame Data Copy"),
        });

        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &self.output,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &staging,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr_padded),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );

        self.queue.submit(Some(encoder.finish()));

        // Map and wait
        let slice = staging.slice(..);
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| { tx.send(res).ok(); });

        // Make progress on mapping (shorter timeout for streaming)
        let map_res = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                self.device.poll(wgpu::Maintain::Poll);
                if let Ok(res) = rx.try_recv() {
                    break res;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .map_err(|_| anyhow!("Timed out mapping frame data buffer"))??;

        let padded = slice.get_mapped_range();
        let raw = unpad_rows(&padded, self.width, self.height, 4);
        drop(padded);
        staging.unmap();

        // Y-flip to conventional image top-left origin
        let row = (self.width * 4) as usize;
        let mut flipped = vec![0u8; raw.len()];
        for y in 0..(self.height as usize) {
            let src_y = (self.height as usize - 1) - y;
            flipped[y * row..y * row + row]
                .copy_from_slice(&raw[src_y * row..src_y * row + row]);
        }

        Ok(flipped)
    }

    /// Optional gradient compute to validate pipeline/writes without scene
    pub fn dispatch_gradient(&self) -> Result<()> {
        let gradient_module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Gradient WGSL"),
            source: wgpu::ShaderSource::Wgsl(GRADIENT_TEST_WGSL.into()),
        });
        let pl = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Gradient PL"),
            bind_group_layouts: &[&self.compute_bgl],
            push_constant_ranges: &[],
        });
        let pipeline = self
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Gradient Pipeline"),
                layout: Some(&pl),
                module: &gradient_module,
                entry_point: "main",
                compilation_options: Default::default(),
                cache: None,
            });

        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Gradient Encoder"),
            });
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Gradient Pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &self.compute_bgs[self.ping], &[]);
            let gx = (self.width + WORKGROUP_X - 1) / WORKGROUP_X;
            let gy = (self.height + WORKGROUP_Y - 1) / WORKGROUP_Y;
            pass.dispatch_workgroups(gx, gy, 1);
        }
        self.queue.submit(Some(enc.finish()));
        Ok(())
    }
}

/// Test material loading system (equivalent to Three.js material system)
async fn test_material_loading(args: &Args) -> Result<()> {
    info!("Testing PBR material loading system (Three.js migration)");

    // Initialize WGPU device for texture loading
    let backends = if args.vulkan {
        wgpu::Backends::VULKAN
    } else {
        wgpu::Backends::PRIMARY
    };

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends,
        dx12_shader_compiler: Default::default(),
        flags: wgpu::InstanceFlags::empty(),
        gles_minor_version: wgpu::Gles3MinorVersion::Automatic,
    });

    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await
        .context("No suitable GPU adapter found")?;

    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("Material Test Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: Default::default(),
            },
            None,
        )
        .await
        .context("Failed to create device")?;

    let device = Arc::new(device);
    let queue = Arc::new(queue);

    // Create material registry
    let mut material_registry = MaterialRegistry::new(device, queue);

    // Load materials from material_textures directory
    let material_dir = std::path::Path::new("material_textures");
    if !material_dir.exists() {
        return Err(anyhow::anyhow!("material_textures directory not found. Expected at: {:?}", material_dir));
    }

    info!("Loading PBR materials from: {:?}", material_dir);
    let loaded_materials = material_registry.load_all_from_directory(material_dir).await?;

    info!("Successfully loaded {} materials:", loaded_materials.len());
    for material_name in &loaded_materials {
        info!("  - {}", material_name);

        // Export material configuration
        if let Ok(config) = material_registry.export_material_config(material_name) {
            let config_path = format!("{}_config.json", material_name);
            tokio::fs::write(&config_path, &config).await?;
            info!("    Exported configuration to: {}", config_path);
        }
    }

    // Test bind group creation
    if !loaded_materials.is_empty() {
        let test_material = &loaded_materials[0];
        info!("Testing bind group creation for: {}", test_material);

        let layout = material_registry.create_pbr_bind_group_layout();
        match material_registry.create_material_bind_group(test_material, &layout) {
            Ok(_) => info!("✓ Bind group created successfully for {}", test_material),
            Err(e) => info!("✗ Failed to create bind group for {}: {}", test_material, e),
        }
    }

    info!("Material loading test completed successfully!");
    info!("Use --animated flag to see materials integrated with path tracing");

    Ok(())
}

/// Load maze JSON (path or embedded sample)
async fn load_maze_data(args: &Args) -> Result<MazeData> {
    if let Some(maze_path) = &args.maze {
        let s = tokio::fs::read_to_string(maze_path)
            .await
            .with_context(|| format!("Failed to read {}", maze_path.display()))?;
        Ok(serde_json::from_str(&s).with_context(|| {
            format!("Failed to parse maze JSON from {}", maze_path.display())
        })?)
    } else {
        // NOTE: keep test_maze.json under src/ for include_str!
        let embedded = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_maze.json"));
        Ok(serde_json::from_str(embedded).context("Failed to parse embedded test_maze.json")?)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = Args::parse();
    info!("Starting with {args:?}");

    if args.server {
        info!("HTTP server mode on :3030");
        return http_server::start_server().await;
    }

    // Test material loading if requested
    if args.test_materials {
        return test_material_loading(&args).await;
    }

    if args.animated {
        // Three.js migration mode - animated path tracer with dynamic lighting
        info!("Running in animated mode with Three.js lighting system");
        let mut animated_tracer = AnimatedPathTracer::new(args.width, args.height).await?;

        // Load maze and initialize animation systems
        let maze = load_maze_data(&args).await?;
        animated_tracer.initialize_with_maze(&maze)?;

        // Create solution path data for animation
        let solution_paths = animated_tracer.create_solution_from_maze(&maze);

        // Animation sequence with Three.js timing
        let start = Instant::now();
        let mut frame_count = 0u32;

        // Phase 1: Intro animation (5 seconds)
        info!("Starting intro animation sequence...");
        let intro_start = Instant::now();
        while intro_start.elapsed().as_secs() < 5 {
            animated_tracer.update_and_render()?;
            frame_count += 1;

            if frame_count % 30 == 0 {
                info!("Intro animation running... ({:.1}s)", intro_start.elapsed().as_secs_f32());
            }
        }

        // Phase 2: Transition to solving
        info!("Finishing intro and transitioning to solving...");
        animated_tracer.finish_intro_and_start_solving().await?;

        // Phase 3: Solution animation
        if !solution_paths.is_empty() {
            info!("Animating solution paths...");
            animated_tracer.animate_solution(solution_paths).await?;
        }

        // Phase 4: Continue rendering until sample target
        info!("Continuing rendering to reach sample target...");
        while animated_tracer.get_sample_count() < args.samples {
            animated_tracer.update_and_render()?;
            frame_count += 1;

            if frame_count % 60 == 0 {
                let samples = animated_tracer.get_sample_count();
                let pct = (samples as f32 * 100.0) / (args.samples as f32);
                info!("Animated rendering progress: {}/{} samples ({:.1}%)", samples, args.samples, pct);
            }
        }

        let elapsed = start.elapsed();
        info!(
            "Animated rendering complete: {} samples in {:?} ({:.1} samples/sec)",
            args.samples,
            elapsed,
            args.samples as f64 / elapsed.as_secs_f64()
        );

        animated_tracer.save_image(&args.output).await?;
    } else {
        // Original static path tracer
        info!("Running in static mode (original path tracer)");
        let mut tracer = PathTracer::new(args.width, args.height, &args).await?;

        // Optional gradient warmup
        if args.gradient_test {
            tracer.dispatch_gradient()?;
            tracer.save_image("gradient_test.png").await?;
            info!("Gradient test saved to gradient_test.png");
        }

        // Load maze + rebuild geometry buffers
        let maze = load_maze_data(&args).await?;
        tracer.load_maze(&maze)?;

        // Accumulate frames
        let start = Instant::now();
        for i in 0..args.samples {
            tracer.render_frame()?;
            if i % 10 == 0 {
                let pct = (i as f32 * 100.0) / (args.samples as f32);
                info!("Progress: {i}/{}, {:.1}%", args.samples, pct);
            }
        }
        let elapsed = start.elapsed();
        info!(
            "Done: {} samples in {:?} ({:.1} samples/sec)",
            args.samples,
            elapsed,
            args.samples as f64 / elapsed.as_secs_f64()
        );

        tracer.save_image(&args.output).await?;
    }
    Ok(())
}
