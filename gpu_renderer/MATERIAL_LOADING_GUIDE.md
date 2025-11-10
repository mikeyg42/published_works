# PBR Material Loading System - Rust/WGPU Migration Guide

This guide explains how to use the new Rust/WGPU PBR material loading system that replaces the Three.js `loadingTextures.ts` functionality.

## Overview

The material loading system provides a complete PBR (Physically Based Rendering) texture management solution for WGPU, supporting:

- **Albedo/Diffuse** textures (sRGB color space)
- **Normal** maps (linear, OpenGL format)
- **Metallic** maps (linear data)
- **Roughness** maps (linear data)
- **Ambient Occlusion** (AO) maps (linear data)
- **Height/Displacement** maps (linear data)

## Three.js Migration

### Before (Three.js):
```typescript
import { loadTextureSet, createMaterial } from './loadingTextures';

// Load material asynchronously
const textureSet = await loadTextureSet('bronze', '/textures/bronze/');
const material = createMaterial('bronze', { metalness: 0.9, roughness: 0.3 });
```

### After (Rust/WGPU):
```rust
use maze_gpu_renderer::material_loader::{MaterialRegistry, MaterialParams};

// Create registry
let mut registry = MaterialRegistry::new(device, queue);

// Load material with parameters
let params = MaterialParams {
    metalness: 0.9,
    roughness: 0.3,
    displacement_scale: 0.02,
    emissive_strength: 0.0,
};

let texture_set = registry.load_texture_set(
    "bronze",
    Path::new("material_textures/bronze"),
    None, // Use default naming
    Some(params),
).await?;
```

## Directory Structure

Organize your textures like this:

```
material_textures/
├── bronze/
│   ├── bronze_albedo.png
│   ├── bronze_normal-ogl.png
│   ├── bronze_metallic.png
│   ├── bronze_roughness.png
│   ├── bronze_ao.png
│   └── bronze_height.png
├── carbon-fiber/
│   ├── carbon-fiber_albedo.png
│   ├── carbon-fiber_normal-ogl.png
│   ├── carbon-fiber_metallic.png
│   ├── carbon-fiber_roughness.png
│   ├── carbon-fiber_ao.png
│   └── carbon-fiber_height.png
└── loadingTextures.ts (old Three.js file - can be deleted)
```

## Usage Examples

### 1. Load Single Material

```rust
use maze_gpu_renderer::material_loader::{MaterialRegistry, MaterialParams};

let mut registry = MaterialRegistry::new(device, queue);

// Load with default naming convention
let texture_set = registry.load_texture_set(
    "bronze",
    Path::new("material_textures/bronze"),
    None,
    None,
).await?;

println!("Material loaded: {}", texture_set.loaded);
```

### 2. Load All Materials from Directory

```rust
// Automatically discover and load all material directories
let materials = registry.load_all_from_directory(
    Path::new("material_textures")
).await?;

println!("Loaded {} materials: {:?}", materials.len(), materials);
```

### 3. Custom File Naming

```rust
use maze_gpu_renderer::material_loader::TextureFileNames;

// If your files don't follow the default naming convention
let custom_names = TextureFileNames::custom(
    "my_color.png",      // albedo
    "my_normals.png",    // normal
    "my_metal.png",      // metallic
    "my_rough.png",      // roughness
    "my_ao.png",         // ambient occlusion
    "my_height.png",     // height/displacement
);

let texture_set = registry.load_texture_set(
    "custom_material",
    Path::new("textures/custom/"),
    Some(custom_names),
    None,
).await?;
```

### 4. Create WGPU Bind Groups

```rust
// Create bind group layout for PBR materials
let layout = registry.create_pbr_bind_group_layout();

// Create bind group for specific material
let bind_group = registry.create_material_bind_group("bronze", &layout)?;

// Use in render pass
render_pass.set_bind_group(1, &bind_group, &[]);
```

### 5. Export/Import Material Configuration

```rust
// Export material settings to JSON
let config = registry.export_material_config("bronze")?;
std::fs::write("bronze_config.json", config)?;

// Import settings from JSON
let json_config = std::fs::read_to_string("bronze_config.json")?;
registry.import_material_params("bronze", &json_config)?;
```

## CLI Usage

Test the material loading system:

```bash
# Test material loading
cargo run --bin maze-gpu-renderer -- --test-materials

# Use materials with animated renderer
cargo run --bin maze-gpu-renderer -- --animated --samples 128

# Run example demo
cargo run --example material_loader_demo
```

## Shader Integration

The material system creates bind groups compatible with WGSL shaders:

```wgsl
// Bind group 1: PBR Material textures
@group(1) @binding(0) var albedo_texture: texture_2d<f32>;
@group(1) @binding(1) var albedo_sampler: sampler;
@group(1) @binding(2) var normal_texture: texture_2d<f32>;
@group(1) @binding(3) var normal_sampler: sampler;
@group(1) @binding(4) var metallic_texture: texture_2d<f32>;
@group(1) @binding(5) var metallic_sampler: sampler;
@group(1) @binding(6) var ao_texture: texture_2d<f32>;
@group(1) @binding(7) var ao_sampler: sampler;
@group(1) @binding(8) var height_texture: texture_2d<f32>;
@group(1) @binding(9) var height_sampler: sampler;

// Sample textures in fragment shader
let albedo = textureSample(albedo_texture, albedo_sampler, uv);
let normal = textureSample(normal_texture, normal_sampler, uv);
let metallic = textureSample(metallic_texture, metallic_sampler, uv).r;
let roughness = textureSample(metallic_texture, metallic_sampler, uv).g; // Packed
let ao = textureSample(ao_texture, ao_sampler, uv).r;
```

## Key Improvements over Three.js

1. **Type Safety**: Rust's type system prevents runtime texture errors
2. **Memory Safety**: Automatic cleanup, no memory leaks
3. **Performance**: Direct WGPU integration, no JavaScript overhead
4. **Async/Await**: Native async support, no callback complexity
5. **Error Handling**: Comprehensive error reporting with context
6. **Fallback Handling**: Automatic white texture for missing maps
7. **Thread Safety**: Safe to use across threads

## Migration Checklist

- [ ] Copy texture directories to `material_textures/`
- [ ] Replace Three.js `loadTextureSet()` calls with Rust equivalent
- [ ] Update shader bindings to match new layout
- [ ] Remove old `loadingTextures.ts` file
- [ ] Test materials with `--test-materials` flag
- [ ] Integrate with animated renderer using `--animated` flag

## Troubleshooting

**Q: Material not loading?**
- Check file paths and naming conventions
- Ensure PNG files are valid and readable
- Check console logs for specific error messages

**Q: Textures appear wrong in shader?**
- Verify bind group layout matches shader expectations
- Check if sRGB/linear color spaces are correct
- Ensure texture sampling coordinates are valid

**Q: Missing texture maps?**
- System automatically provides white fallback textures
- Check exported JSON config to see which maps loaded successfully

**Q: Performance issues?**
- Consider generating mipmaps for large textures
- Use appropriate texture formats (sRGB for albedo, linear for data)
- Batch material loading for better efficiency