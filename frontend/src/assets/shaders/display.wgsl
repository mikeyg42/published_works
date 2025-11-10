// Vertex shader output
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
};

// Vertex shader - generates a fullscreen triangle
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // These positions generate a triangle that covers the entire screen
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  
  // Corresponding texture coordinates
  var texCoords = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.texCoord = texCoords[vertexIndex];
  return output;
}

// Texture bindings
@group(0) @binding(0) var outputTexture: texture_2d<f32>;
@group(0) @binding(1) var textureSampler: sampler;

// Fragment shader - displays the rendered image
@fragment
fn fragmentMain(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  return textureSample(outputTexture, textureSampler, texCoord);
}