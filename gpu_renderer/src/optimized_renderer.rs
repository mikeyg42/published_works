// optimized_renderer.rs - Fixed version with proper shader bindings and no broken Default

use std::sync::Arc;
use wgpu::util::DeviceExt;
use serde::{Deserialize, Serialize};

// Re-export types from main for consistency
pub use crate::{MazeData, MazeCell, Point3, MazeDimensions};

/// Solution data from maze solver
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SolutionData {
    pub session_id: String,
    pub path: Vec<String>,
}

/// Vertex format for maze rendering
#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    pub position: [f32; 3],
    pub color: [f32; 3],
}

impl Vertex {
    pub fn desc() -> wgpu::VertexBufferLayout<'static> {
        const ATTRIBUTES: &[wgpu::VertexAttribute] = &wgpu::vertex_attr_array![
            0 => Float32x3,  // position
            1 => Float32x3,  // color
        ];
        
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: ATTRIBUTES,
        }
    }
}

/// Display uniforms for 2D visualization
#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DisplayUniforms {
    view_proj: [[f32; 4]; 4],
    time: f32,
    _padding: [f32; 3],
}

impl DisplayUniforms {
    pub fn orthographic(width: u32, height: u32, time: f32) -> Self {
        // Orthographic projection matrix for 2D rendering
        let w = width as f32;
        let h = height as f32;
        
        Self {
            view_proj: [
                [2.0 / w, 0.0, 0.0, 0.0],
                [0.0, -2.0 / h, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [-1.0, 1.0, 0.0, 1.0],
            ],
            time,
            _padding: [0.0; 3],
        }
    }
}

/// Geometry builder with efficient batching
pub struct GeometryBuilder {
    vertices: Vec<Vertex>,
    indices: Vec<u32>,
    current_vertex_offset: u32,
}

impl GeometryBuilder {
    pub fn new() -> Self {
        Self {
            vertices: Vec::with_capacity(1024),
            indices: Vec::with_capacity(2048),
            current_vertex_offset: 0,
        }
    }
    
    pub fn reserve(&mut self, vertex_count: usize, index_count: usize) {
        self.vertices.reserve(vertex_count);
        self.indices.reserve(index_count);
    }
    
    pub fn add_hexagon(&mut self, center: [f32; 2], radius: f32, color: [f32; 3]) {
        let base_offset = self.current_vertex_offset;
        
        // Center vertex
        self.vertices.push(Vertex {
            position: [center[0], center[1], 0.0],
            color,
        });
        
        // Edge vertices (6 points)
        for i in 0..6 {
            let angle = std::f32::consts::TAU * (i as f32 / 6.0);
            let (sin, cos) = angle.sin_cos();
            self.vertices.push(Vertex {
                position: [
                    center[0] + radius * cos,
                    center[1] + radius * sin,
                    0.0
                ],
                color,
            });
        }
        
        // Generate triangles (6 triangles from center)
        for i in 0..6 {
            let next = if i == 5 { 1 } else { i + 2 };
            self.indices.extend_from_slice(&[
                base_offset,           // center
                base_offset + i + 1,   // current edge
                base_offset + next,    // next edge
            ]);
        }
        
        self.current_vertex_offset += 7;
    }
    
    pub fn add_maze_hexagons(&mut self, maze: &MazeData, solution: &SolutionData) {
        let solution_set: std::collections::HashSet<_> = solution.path.iter().cloned().collect();
        
        // Reserve space based on cell count
        let non_wall_count = maze.cells.iter().filter(|c| !c.is_wall).count();
        self.reserve(non_wall_count * 7, non_wall_count * 18);
        
        for cell in &maze.cells {
            if cell.is_wall {
                continue;
            }
            
            let color = if solution_set.contains(&cell.id) {
                [0.2, 0.9, 0.3]  // Green for solution
            } else {
                [0.6, 0.6, 0.7]  // Light gray for maze
            };
            
            // Use actual vertex positions from cell
            if cell.vertices.len() >= 6 {
                let base_offset = self.current_vertex_offset;
                
                // Add center
                self.vertices.push(Vertex {
                    position: [cell.center.x, cell.center.y, cell.center.z],
                    color,
                });
                
                // Add vertices
                for v in &cell.vertices[..6] {
                    self.vertices.push(Vertex {
                        position: [v.x, v.y, v.z],
                        color,
                    });
                }
                
                // Add indices
                for i in 0..6 {
                    let next = if i == 5 { 1 } else { i + 2 };
                    self.indices.extend_from_slice(&[
                        base_offset,
                        base_offset + i + 1,
                        base_offset + next,
                    ]);
                }
                
                self.current_vertex_offset += 7;
            }
        }
    }
    
    pub fn build(self) -> (Vec<Vertex>, Vec<u32>) {
        (self.vertices, self.indices)
    }
}

/// GPU resources container
struct GpuResources {
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    uniform_buffer: wgpu::Buffer,
    render_texture: wgpu::Texture,
    render_texture_view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    pipeline: wgpu::RenderPipeline,
    vertex_count: u32,
    index_count: u32,
}

/// Optimized maze renderer with proper resource management
pub struct OptimizedMazeRenderer {
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    resources: Option<GpuResources>,
    width: u32,
    height: u32,
    frame_count: u64,
}

// REMOVED Default implementation - it was broken and not needed
// The renderer must be created through new() for proper initialization

impl OptimizedMazeRenderer {
    pub async fn new(width: u32, height: u32) -> crate::error_handling::Result<Self> {
        // Validate dimensions
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err(crate::error_handling::RendererError::InvalidMazeData {
                reason: format!("Invalid dimensions: {}x{}", width, height),
            });
        }
        
        // Prefer Vulkan for headless T4 service
        let backends = if std::env::var("WGPU_BACKEND").as_deref() == Ok("vulkan") {
            wgpu::Backends::VULKAN
        } else {
            wgpu::Backends::PRIMARY
        };

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            flags: wgpu::InstanceFlags::empty(),
            dx12_shader_compiler: Default::default(),
            gles_minor_version: wgpu::Gles3MinorVersion::Automatic,
        });
        
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or(crate::error_handling::RendererError::AdapterCreationFailed)?;
        
        log::info!("Using GPU: {}", adapter.get_info().name);
        
        // Check texture dimension limits
        let limits = adapter.limits();
        if width > limits.max_texture_dimension_2d || height > limits.max_texture_dimension_2d {
            return Err(crate::error_handling::RendererError::InvalidMazeData {
                reason: format!("Size exceeds GPU limit of {}", limits.max_texture_dimension_2d),
            });
        }
        
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("Optimized Renderer"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits {
                        max_texture_dimension_2d: width.max(height),
                        ..Default::default()
                    },
                    memory_hints: Default::default(),
                },
                None,
            )
            .await?;
        
        Ok(Self {
            device: Arc::new(device),
            queue: Arc::new(queue),
            resources: None,
            width,
            height,
            frame_count: 0,
        })
    }
    
    fn create_pipeline(&self) -> crate::error_handling::Result<(wgpu::RenderPipeline, wgpu::BindGroupLayout)> {
        // Create shader module
        let shader_src = include_str!("shaders/display.wgsl");
        let shader = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Display Shader"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });
        
        // Create bind group layout to match display.wgsl expectations:
        // @binding(0) = texture_2d<f32>, @binding(1) = sampler
        let bind_group_layout = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Display Bind Group Layout"),
            entries: &[
                // @binding(0) = outputTexture: texture_2d<f32>
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    },
                    count: None,
                },
                // @binding(1) = textureSampler: sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                }
            ],
        });
        
        let pipeline_layout = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Display Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        
        // FIXED: Use the geometry rendering entry points (vs_main/fs_main)
        // which match the uniforms binding
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Geometry Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",  // Use geometry vertex shader
                buffers: &[Vertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",  // Use geometry fragment shader
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        
        Ok((pipeline, bind_group_layout))
    }
    
    pub fn load_maze_data(&mut self, maze: &MazeData, solution: &SolutionData) -> crate::error_handling::Result<()> {
        // Build geometry
        let mut builder = GeometryBuilder::new();
        builder.add_maze_hexagons(maze, solution);
        let (vertices, indices) = builder.build();
        
        if vertices.is_empty() {
            return Err(crate::error_handling::RendererError::InvalidMazeData {
                reason: "No geometry generated from maze".into(),
            });
        }
        
        log::info!("Generated {} vertices, {} indices", vertices.len(), indices.len());
        
        // Create GPU resources
        let vertex_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
        
        let index_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        
        // Create uniforms
        let uniforms = DisplayUniforms::orthographic(self.width, self.height, 0.0);
        let uniform_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Uniform Buffer"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        
        // Create render texture
        let render_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Render Texture"),
            size: wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        
        let render_texture_view = render_texture.create_view(&Default::default());
        
        // Create pipeline and bind group
        let (pipeline, bind_group_layout) = self.create_pipeline()?;
        
        // Create bind group matching the geometry path expectations
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Geometry Bind Group"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                }
            ],
        });
        
        self.resources = Some(GpuResources {
            vertex_buffer,
            index_buffer,
            uniform_buffer,
            render_texture,
            render_texture_view,
            bind_group,
            pipeline,
            vertex_count: vertices.len() as u32,
            index_count: indices.len() as u32,
        });
        
        Ok(())
    }
    
    pub async fn render_frame(&mut self, time: f32) -> crate::error_handling::Result<()> {
        let resources = self.resources.as_ref()
            .ok_or(crate::error_handling::RendererError::InvalidMazeData {
                reason: "No maze data loaded".into(),
            })?;
        
        // Update uniforms
        let uniforms = DisplayUniforms::orthographic(self.width, self.height, time);
        self.queue.write_buffer(&resources.uniform_buffer, 0, bytemuck::bytes_of(&uniforms));
        
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        });
        
        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &resources.render_texture_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.1,
                            g: 0.1,
                            b: 0.15,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            
            render_pass.set_pipeline(&resources.pipeline);
            render_pass.set_bind_group(0, &resources.bind_group, &[]);
            render_pass.set_vertex_buffer(0, resources.vertex_buffer.slice(..));
            render_pass.set_index_buffer(resources.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..resources.index_count, 0, 0..1);
        }
        
        self.queue.submit(std::iter::once(encoder.finish()));
        self.frame_count += 1;
        
        Ok(())
    }
    
    pub async fn save_frame_as_png(&self, path: &str) -> crate::error_handling::Result<()> {
        let resources = self.resources.as_ref()
            .ok_or(crate::error_handling::RendererError::InvalidMazeData {
                reason: "No rendered frame available".into(),
            })?;
        
        // Use proper row pitch alignment
        let padded_bpr = crate::error_handling::padded_bytes_per_row(self.width, 4);
        let buffer_size = padded_bpr as u64 * self.height as u64;
        
        let staging_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Screenshot Buffer"),
            size: buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Screenshot Encoder"),
        });
        
        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &resources.render_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &staging_buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bpr),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        
        self.queue.submit(std::iter::once(encoder.finish()));
        
        // Map buffer async with timeout
        let buffer_slice = staging_buffer.slice(..);
        crate::error_handling::map_buffer_async(
            &staging_buffer, 
            wgpu::MapMode::Read,
            std::time::Duration::from_secs(5)
        ).await?;
        
        // Read and unpad data
        let padded_data = buffer_slice.get_mapped_range();
        let unpadded_data = crate::error_handling::unpad_rows(
            &padded_data, 
            self.width, 
            self.height, 
            4
        );
        drop(padded_data);
        staging_buffer.unmap();
        
        // Save image
        let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
            self.width,
            self.height,
            unpadded_data,
        ).ok_or(crate::error_handling::RendererError::ImageError(
            image::ImageError::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Failed to create image buffer"
            ))
        ))?;
        
        img.save(path)?;
        log::info!("Saved frame {} to {}", self.frame_count, path);
        
        Ok(())
    }
}
