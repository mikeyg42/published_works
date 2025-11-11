// material_loader.rs - PBR texture loading system for WGPU
// Rust equivalent of the Three.js loadingTextures.ts system

use anyhow::{Context, Result};
use image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use wgpu::util::DeviceExt;

/// Single PBR texture handle for WGPU
#[derive(Debug)]
pub struct PbrTexture {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub sampler: Arc<wgpu::Sampler>,
    pub dimensions: (u32, u32),
}

/// Complete PBR texture set matching Three.js TextureSet interface
#[derive(Debug)]
pub struct TextureSet {
    pub albedo: Option<PbrTexture>,
    pub normal: Option<PbrTexture>,
    pub metallic: Option<PbrTexture>,
    pub roughness: Option<PbrTexture>,
    pub ao: Option<PbrTexture>,
    pub height: Option<PbrTexture>,
    pub loaded: bool,
    pub material_params: MaterialParams,
}

/// Material parameters for PBR rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialParams {
    pub metalness: f32,        // Override value (0.0-1.0)
    pub roughness: f32,        // Override value (0.0-1.0)
    pub displacement_scale: f32, // Height map displacement strength
    pub emissive_strength: f32,  // Self-emission multiplier
}

impl Default for MaterialParams {
    fn default() -> Self {
        Self {
            metalness: 0.5,
            roughness: 0.5,
            displacement_scale: 0.05, // Matches Three.js default
            emissive_strength: 0.0,
        }
    }
}

/// File naming patterns for texture maps
#[derive(Debug, Clone)]
pub struct TextureFileNames {
    pub albedo: String,
    pub normal: String,
    pub metallic: String,
    pub roughness: String,
    pub ao: String,
    pub height: String,
}

impl TextureFileNames {
    /// Create default naming pattern based on material name
    /// Matches Three.js naming conventions exactly
    pub fn from_material_name(material_name: &str) -> Self {
        Self {
            albedo: format!("{}_albedo.png", material_name),
            normal: format!("{}_normal-ogl.png", material_name), // OpenGL normal format
            metallic: format!("{}_metallic.png", material_name),
            roughness: format!("{}_roughness.png", material_name),
            ao: format!("{}_ao.png", material_name),
            height: format!("{}_height.png", material_name),
        }
    }

    /// Custom naming pattern
    pub fn custom(
        albedo: &str, normal: &str, metallic: &str,
        roughness: &str, ao: &str, height: &str
    ) -> Self {
        Self {
            albedo: albedo.to_string(),
            normal: normal.to_string(),
            metallic: metallic.to_string(),
            roughness: roughness.to_string(),
            ao: ao.to_string(),
            height: height.to_string(),
        }
    }
}

/// PBR Material Registry - equivalent to Three.js materials record
pub struct MaterialRegistry {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    materials: HashMap<String, TextureSet>,
    default_sampler: Arc<wgpu::Sampler>,
}

impl MaterialRegistry {
    /// Create new material registry with WGPU device
    pub fn new(device: Arc<wgpu::Device>, queue: Arc<wgpu::Queue>) -> Self {
        // Create default sampler for PBR textures
        let default_sampler = Arc::new(device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("PBR Default Sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            lod_min_clamp: 0.0,
            lod_max_clamp: 32.0,
            compare: None,
            anisotropy_clamp: 16, // High quality anisotropic filtering
            border_color: None,
        }));

        Self {
            device,
            queue,
            materials: HashMap::new(),
            default_sampler,
        }
    }

    /// Load complete texture set from directory - equivalent to Three.js loadTextureSet()
    pub async fn load_texture_set(
        &mut self,
        material_name: &str,
        base_path: &Path,
        file_names: Option<TextureFileNames>,
        material_params: Option<MaterialParams>,
    ) -> Result<&TextureSet> {
        let names = file_names.unwrap_or_else(|| TextureFileNames::from_material_name(material_name));
        let params = material_params.unwrap_or_default();

        log::info!("Loading PBR texture set '{}' from {:?}", material_name, base_path);

        // Initialize texture set
        let mut texture_set = TextureSet {
            albedo: None,
            normal: None,
            metallic: None,
            roughness: None,
            ao: None,
            height: None,
            loaded: false,
            material_params: params,
        };

        // Load each texture type
        let texture_types = [
            ("albedo", &names.albedo, true),    // sRGB color space
            ("normal", &names.normal, false),   // Linear for normal maps
            ("metallic", &names.metallic, false), // Linear for data
            ("roughness", &names.roughness, false), // Linear for data
            ("ao", &names.ao, false),          // Linear for data
            ("height", &names.height, false),  // Linear for data
        ];

        for (tex_type, filename, is_srgb) in texture_types.iter() {
            let texture_path = base_path.join(filename);

            match self.load_single_texture(&texture_path, *is_srgb).await {
                Ok(texture) => {
                    log::debug!("Loaded {} texture: {}", tex_type, filename);
                    match *tex_type {
                        "albedo" => texture_set.albedo = Some(texture),
                        "normal" => texture_set.normal = Some(texture),
                        "metallic" => texture_set.metallic = Some(texture),
                        "roughness" => texture_set.roughness = Some(texture),
                        "ao" => texture_set.ao = Some(texture),
                        "height" => texture_set.height = Some(texture),
                        _ => unreachable!(),
                    }
                }
                Err(e) => {
                    log::warn!("Failed to load {} texture '{}': {}", tex_type, filename, e);
                    // Continue loading other textures even if one fails
                }
            }
        }

        texture_set.loaded = true;
        log::info!("PBR texture set '{}' loaded successfully", material_name);

        self.materials.insert(material_name.to_string(), texture_set);
        Ok(self.materials.get(material_name).unwrap())
    }

    /// Load single texture from file path
    async fn load_single_texture(&self, path: &Path, is_srgb: bool) -> Result<PbrTexture> {
        // Read image file
        let image_bytes = tokio::fs::read(path).await
            .with_context(|| format!("Failed to read texture file: {}", path.display()))?;

        // Decode image
        let image = image::load_from_memory(&image_bytes)
            .with_context(|| format!("Failed to decode texture: {}", path.display()))?;

        let rgba = image.to_rgba8();
        let dimensions = (rgba.width(), rgba.height());

        // Choose appropriate texture format
        let format = if is_srgb {
            wgpu::TextureFormat::Rgba8UnormSrgb  // sRGB for color textures
        } else {
            wgpu::TextureFormat::Rgba8Unorm      // Linear for data textures
        };

        // Create WGPU texture
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&format!("PBR Texture: {}", path.file_name().unwrap_or_default().to_string_lossy())),
            size: wgpu::Extent3d {
                width: dimensions.0,
                height: dimensions.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1, // TODO: Generate mipmaps for better quality
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        // Upload texture data
        self.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &rgba,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(4 * dimensions.0),
                rows_per_image: Some(dimensions.1),
            },
            wgpu::Extent3d {
                width: dimensions.0,
                height: dimensions.1,
                depth_or_array_layers: 1,
            },
        );

        // Create texture view and sampler
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Use shared sampler for efficiency
        let sampler = Arc::clone(&self.default_sampler);

        Ok(PbrTexture {
            texture,
            view,
            sampler,
            dimensions,
        })
    }

    /// Get texture set by name - equivalent to Three.js getTextureSet()
    pub fn get_texture_set(&self, material_name: &str) -> Option<&TextureSet> {
        self.materials.get(material_name)
    }

    /// Get mutable texture set for parameter updates
    pub fn get_texture_set_mut(&mut self, material_name: &str) -> Option<&mut TextureSet> {
        self.materials.get_mut(material_name)
    }

    /// Update material parameters for existing texture set
    pub fn update_material_params(&mut self, material_name: &str, params: MaterialParams) -> Result<()> {
        let texture_set = self.materials.get_mut(material_name)
            .with_context(|| format!("Material '{}' not found", material_name))?;

        texture_set.material_params = params;
        log::info!("Updated material parameters for '{}'", material_name);
        Ok(())
    }

    /// List all loaded materials
    pub fn list_materials(&self) -> Vec<&str> {
        self.materials.keys().map(|s| s.as_str()).collect()
    }

    /// Check if material is loaded
    pub fn is_loaded(&self, material_name: &str) -> bool {
        self.materials.get(material_name)
            .map(|ts| ts.loaded)
            .unwrap_or(false)
    }

    /// Load all materials from a base directory
    /// Scans for subdirectories and loads each as a material set
    pub async fn load_all_from_directory(&mut self, base_dir: &Path) -> Result<Vec<String>> {
        let mut loaded_materials = Vec::new();

        let mut dir_entries = tokio::fs::read_dir(base_dir).await
            .with_context(|| format!("Failed to read directory: {}", base_dir.display()))?;

        while let Some(entry) = dir_entries.next_entry().await? {
            let entry_path = entry.path();

            if entry_path.is_dir() {
                let material_name = entry_path.file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| anyhow::anyhow!("Invalid directory name"))?;

                log::info!("Attempting to load material: {}", material_name);

                match self.load_texture_set(
                    material_name,
                    &entry_path,
                    None, // Use default naming
                    None, // Use default parameters
                ).await {
                    Ok(_) => {
                        loaded_materials.push(material_name.to_string());
                        log::info!("Successfully loaded material: {}", material_name);
                    }
                    Err(e) => {
                        log::error!("Failed to load material '{}': {}", material_name, e);
                    }
                }
            }
        }

        log::info!("Loaded {} materials from {:?}", loaded_materials.len(), base_dir);
        Ok(loaded_materials)
    }

    /// Create bind group layout for PBR textures
    /// Returns layout compatible with PBR shader expectations
    pub fn create_pbr_bind_group_layout(&self) -> wgpu::BindGroupLayout {
        self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("PBR Material Bind Group Layout"),
            entries: &[
                // Albedo texture
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                // Albedo sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Normal texture
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                // Normal sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Metallic-Roughness texture (packed)
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                // Metallic-Roughness sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // AO texture
                wgpu::BindGroupLayoutEntry {
                    binding: 6,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                // AO sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 7,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Height/Displacement texture
                wgpu::BindGroupLayoutEntry {
                    binding: 8,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                // Height sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 9,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        })
    }

    /// Create bind group for specific material
    pub fn create_material_bind_group(
        &self,
        material_name: &str,
        layout: &wgpu::BindGroupLayout
    ) -> Result<wgpu::BindGroup> {
        let texture_set = self.get_texture_set(material_name)
            .with_context(|| format!("Material '{}' not found", material_name))?;

        if !texture_set.loaded {
            return Err(anyhow::anyhow!("Material '{}' not fully loaded", material_name));
        }

        // Create fallback white texture for missing maps
        let fallback_texture = self.create_fallback_texture();
        let fallback_view = fallback_texture.create_view(&Default::default());

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("PBR Material Bind Group: {}", material_name)),
            layout,
            entries: &[
                // Albedo
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        texture_set.albedo.as_ref().map(|t| &t.view).unwrap_or(&fallback_view)
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(
                        texture_set.albedo.as_ref().map(|t| &t.sampler).unwrap_or(&self.default_sampler)
                    ),
                },
                // Normal
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(
                        texture_set.normal.as_ref().map(|t| &t.view).unwrap_or(&fallback_view)
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(
                        texture_set.normal.as_ref().map(|t| &t.sampler).unwrap_or(&self.default_sampler)
                    ),
                },
                // Metallic (using metallic texture, roughness in separate texture for now)
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(
                        texture_set.metallic.as_ref().map(|t| &t.view).unwrap_or(&fallback_view)
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Sampler(
                        texture_set.metallic.as_ref().map(|t| &t.sampler).unwrap_or(&self.default_sampler)
                    ),
                },
                // AO
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(
                        texture_set.ao.as_ref().map(|t| &t.view).unwrap_or(&fallback_view)
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(
                        texture_set.ao.as_ref().map(|t| &t.sampler).unwrap_or(&self.default_sampler)
                    ),
                },
                // Height
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: wgpu::BindingResource::TextureView(
                        texture_set.height.as_ref().map(|t| &t.view).unwrap_or(&fallback_view)
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: wgpu::BindingResource::Sampler(
                        texture_set.height.as_ref().map(|t| &t.sampler).unwrap_or(&self.default_sampler)
                    ),
                },
            ],
        });

        Ok(bind_group)
    }

    /// Create fallback white texture for missing texture maps
    fn create_fallback_texture(&self) -> wgpu::Texture {
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Fallback White Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        // Upload white pixel
        self.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255, 255, 255, 255], // White RGBA
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );

        texture
    }
}

/// Utility functions for material management
impl MaterialRegistry {
    /// Export material configuration to JSON
    pub fn export_material_config(&self, material_name: &str) -> Result<String> {
        let texture_set = self.get_texture_set(material_name)
            .with_context(|| format!("Material '{}' not found", material_name))?;

        let config = serde_json::json!({
            "name": material_name,
            "loaded": texture_set.loaded,
            "has_albedo": texture_set.albedo.is_some(),
            "has_normal": texture_set.normal.is_some(),
            "has_metallic": texture_set.metallic.is_some(),
            "has_roughness": texture_set.roughness.is_some(),
            "has_ao": texture_set.ao.is_some(),
            "has_height": texture_set.height.is_some(),
            "parameters": texture_set.material_params
        });

        Ok(serde_json::to_string_pretty(&config)?)
    }

    /// Import material parameters from JSON
    pub fn import_material_params(&mut self, material_name: &str, json_config: &str) -> Result<()> {
        let config: serde_json::Value = serde_json::from_str(json_config)?;

        let params = MaterialParams {
            metalness: config["parameters"]["metalness"].as_f64().unwrap_or(0.5) as f32,
            roughness: config["parameters"]["roughness"].as_f64().unwrap_or(0.5) as f32,
            displacement_scale: config["parameters"]["displacement_scale"].as_f64().unwrap_or(0.05) as f32,
            emissive_strength: config["parameters"]["emissive_strength"].as_f64().unwrap_or(0.0) as f32,
        };

        self.update_material_params(material_name, params)
    }
}