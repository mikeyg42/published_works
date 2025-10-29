// display.wgsl
// Dual-purpose display shader for both texture presentation and geometry rendering
// Supports fullscreen texture display and direct geometry rasterization

// ============================================================================
// UNIFORM STRUCTURES
// ============================================================================

// Transformation uniforms for geometry rendering
struct DisplayUniforms {
    view_proj: mat4x4<f32>,  // Combined view-projection matrix
    time: f32,                // Animation time in seconds
    _padding: vec3<f32>,      // Alignment to 16 bytes
}

// ============================================================================
// VERTEX STRUCTURES
// ============================================================================

// Input layout for geometry vertices
struct VertexInput {
    @location(0) position: vec3<f32>,  // Object space position
    @location(1) color: vec3<f32>,     // Vertex color (linear RGB)
}

// Output from texture display vertex shader
struct VertexOutput {
    @builtin(position) position: vec4<f32>,  // Clip space position
    @location(0) texCoord: vec2<f32>,        // UV coordinates
}

// Output from geometry vertex shader
struct GeometryOutput {
    @builtin(position) position: vec4<f32>,  // Clip space position
    @location(0) color: vec3<f32>,           // Interpolated color
}

// ============================================================================
// RESOURCE BINDINGS
// ============================================================================

// Texture display path bindings
@group(0) @binding(0) var outputTexture: texture_2d<f32>;
@group(0) @binding(1) var textureSampler: sampler;

// Geometry rendering path bindings (reuses binding 0 for uniforms)
@group(0) @binding(0) var<uniform> uniforms: DisplayUniforms;

// ============================================================================
// TEXTURE DISPLAY PATH
// ============================================================================
// Used for presenting path tracer output to screen

@vertex
fn vertexMain(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    // Generate fullscreen triangle using vertex index
    // This technique requires only 3 vertices to cover entire viewport
    // More efficient than traditional quad (6 vertices)
    
    let x = f32((vertex_index << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(vertex_index & 2u) * 2.0 - 1.0;
    
    var output: VertexOutput;
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    
    // Calculate texture coordinates with Y-flip for correct orientation
    output.texCoord = vec2<f32>(
        (x + 1.0) * 0.5,
        1.0 - (y + 1.0) * 0.5
    );
    
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Sample and return the texture
    // Texture is expected to be already tone-mapped and gamma-corrected
    return textureSample(outputTexture, textureSampler, input.texCoord);
}

// ============================================================================
// GEOMETRY RENDERING PATH
// ============================================================================
// Used by optimized_renderer for direct hexagon visualization

@vertex
fn vs_main(input: VertexInput) -> GeometryOutput {
    var output: GeometryOutput;
    
    // Transform vertex position to clip space
    output.position = uniforms.view_proj * vec4<f32>(input.position, 1.0);
    
    // Pass through vertex color for interpolation
    output.color = input.color;
    
    return output;
}

@fragment
fn fs_main(input: GeometryOutput) -> @location(0) vec4<f32> {
    // Output interpolated color with full opacity
    // Colors are expected to be in sRGB space
    return vec4<f32>(input.color, 1.0);
}