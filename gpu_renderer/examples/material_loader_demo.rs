// examples/material_loader_demo.rs - Demonstration of PBR material loading system
// Shows how to use the Rust/WGPU equivalent of Three.js texture loading

use anyhow::Result;
use maze_gpu_renderer::material_loader::{MaterialRegistry, TextureFileNames, MaterialParams};
use std::path::Path;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    println!("PBR Material Loading Demo - Rust/WGPU Migration from Three.js");
    println!("==============================================================");

    // Initialize WGPU (minimal setup for texture loading)
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
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
        .expect("Failed to find suitable adapter");

    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("Material Demo Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: Default::default(),
            },
            None,
        )
        .await
        .expect("Failed to create device");

    let device = Arc::new(device);
    let queue = Arc::new(queue);

    // Create material registry (equivalent to Three.js materials record)
    let mut registry = MaterialRegistry::new(device, queue);

    println!("\n1. Loading individual material with custom parameters...");

    // Example 1: Load bronze material with custom parameters
    let bronze_params = MaterialParams {
        metalness: 0.9,        // Very metallic
        roughness: 0.3,        // Quite smooth
        displacement_scale: 0.02, // Subtle displacement
        emissive_strength: 0.0,
    };

    let bronze_path = Path::new("material_textures/bronze");
    if bronze_path.exists() {
        match registry.load_texture_set(
            "bronze",
            bronze_path,
            None, // Use default naming convention
            Some(bronze_params),
        ).await {
            Ok(texture_set) => {
                println!("✓ Bronze material loaded successfully");
                println!("  - Albedo: {}", texture_set.albedo.is_some());
                println!("  - Normal: {}", texture_set.normal.is_some());
                println!("  - Metallic: {}", texture_set.metallic.is_some());
                println!("  - Roughness: {}", texture_set.roughness.is_some());
                println!("  - AO: {}", texture_set.ao.is_some());
                println!("  - Height: {}", texture_set.height.is_some());
            }
            Err(e) => println!("✗ Failed to load bronze: {}", e),
        }
    } else {
        println!("⚠ Bronze material directory not found at: {:?}", bronze_path);
    }

    println!("\n2. Loading all materials from directory...");

    // Example 2: Load all materials from material_textures directory
    let materials_dir = Path::new("material_textures");
    if materials_dir.exists() {
        match registry.load_all_from_directory(materials_dir).await {
            Ok(materials) => {
                println!("✓ Loaded {} materials:", materials.len());
                for material in &materials {
                    println!("  - {}", material);
                }

                // Example 3: Create bind groups for loaded materials
                println!("\n3. Creating WGPU bind groups...");
                let layout = registry.create_pbr_bind_group_layout();

                for material in &materials {
                    match registry.create_material_bind_group(material, &layout) {
                        Ok(_) => println!("  ✓ {} - bind group created", material),
                        Err(e) => println!("  ✗ {} - failed: {}", material, e),
                    }
                }

                // Example 4: Export material configurations
                println!("\n4. Exporting material configurations...");
                for material in &materials {
                    if let Ok(config) = registry.export_material_config(material) {
                        let filename = format!("{}_material_config.json", material);
                        std::fs::write(&filename, config)?;
                        println!("  ✓ Exported {} configuration to {}", material, filename);
                    }
                }

            }
            Err(e) => println!("✗ Failed to load materials: {}", e),
        }
    } else {
        println!("⚠ Materials directory not found: {:?}", materials_dir);
        println!("  Create this directory and add PBR texture sets to test loading");
    }

    println!("\n5. Material registry summary:");
    let loaded_materials = registry.list_materials();
    println!("  Total materials loaded: {}", loaded_materials.len());
    for material in loaded_materials {
        let is_loaded = registry.is_loaded(material);
        println!("  - {}: {}", material, if is_loaded { "✓" } else { "✗" });
    }

    println!("\n6. Custom naming convention example:");

    // Example 5: Load with custom file names (if you have non-standard naming)
    let custom_names = TextureFileNames::custom(
        "custom_color.png",      // albedo
        "custom_normal.png",     // normal
        "custom_metal.png",      // metallic
        "custom_rough.png",      // roughness
        "custom_occlusion.png",  // ao
        "custom_displacement.png" // height
    );

    println!("  Custom naming pattern created:");
    println!("    Albedo: {}", custom_names.albedo);
    println!("    Normal: {}", custom_names.normal);
    println!("    Metallic: {}", custom_names.metallic);
    println!("    Roughness: {}", custom_names.roughness);
    println!("    AO: {}", custom_names.ao);
    println!("    Height: {}", custom_names.height);

    println!("\nDemo completed! This system replaces the Three.js loadingTextures.ts functionality.");
    println!("Key benefits over Three.js version:");
    println!("  - Native async/await support (no callback hell)");
    println!("  - Strong typing with Rust's type system");
    println!("  - Memory safety and thread safety");
    println!("  - Direct WGPU integration for high performance");
    println!("  - Built-in fallback texture handling");

    Ok(())
}