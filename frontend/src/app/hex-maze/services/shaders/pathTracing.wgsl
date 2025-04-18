// Uniforms
struct Uniforms {
  cameraPosition: vec3f,
  padding1: f32,
  cameraDirection: vec3f,
  padding2: f32,
  cameraUp: vec3f,
  padding3: f32,
  cameraFov: f32,
  environmentIntensity: f32,
  sampleCount: u32,
  seed: u32,
  time: f32,
  aspectRatio: f32,
};

// Bindings
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var accumulationTexture: texture_storage_2d<rgba32float, read_write>;
@group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read> vertices: array<f32>;
@group(0) @binding(4) var<storage, read> normals: array<f32>;
@group(0) @binding(5) var<storage, read> materials: array<f32>;

// Constants
const PI = 3.14159265359;
const EPSILON = 0.0001;
const MAX_BOUNCES = 3;

// Ray structure
struct Ray {
  origin: vec3f,
  direction: vec3f,
};

// Hit record
struct HitRecord {
  t: f32,
  position: vec3f,
  normal: vec3f,
  materialIndex: u32,
  hit: bool,
};

// Material properties
struct Material {
  albedo: vec3f,
  metalness: f32,
  roughness: f32,
  emissive: f32,
};

// Random number generation (PCG hash)
fn pcg(inout state: u32) -> u32 {
  state = state * 747796405u + 2891336453u;
  var word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand(seed: ptr<function, u32>) -> f32 {
  *seed = pcg(*seed);
  return f32(*seed) / 4294967295.0;
}

// Random vector in unit sphere
fn randomInUnitSphere(seed: ptr<function, u32>) -> vec3f {
  let z = 2.0 * rand(seed) - 1.0;
  let t = 2.0 * PI * rand(seed);
  let r = sqrt(1.0 - z * z);
  let x = r * cos(t);
  let y = r * sin(t);
  return vec3f(x, y, z);
}

// Generate random direction in hemisphere aligned with normal
fn randomHemisphereDirection(normal: vec3f, seed: ptr<function, u32>) -> vec3f {
  let inUnitSphere = randomInUnitSphere(seed);
  if (dot(inUnitSphere, normal) > 0.0) {
    return inUnitSphere;
  } else {
    return -inUnitSphere;
  }
}

// Generate camera ray for pixel
fn generateRay(pixel: vec2u, seed: ptr<function, u32>) -> Ray {
  let dimensions = textureDimensions(accumulationTexture);
  
  // Add random offset within pixel for anti-aliasing
  let offset = vec2f(rand(seed), rand(seed));
  let pixelPos = vec2f(f32(pixel.x) + offset.x, f32(pixel.y) + offset.y);
  
  // Convert to NDC space (-1 to 1)
  let ndc = vec2f(
    (pixelPos.x / f32(dimensions.x) * 2.0 - 1.0) * uniforms.aspectRatio,
    (1.0 - pixelPos.y / f32(dimensions.y)) * 2.0 - 1.0
  );
  
  // Compute ray direction using camera parameters
  let fovScale = tan(uniforms.cameraFov * 0.5 * PI / 180.0);
  let right = normalize(cross(uniforms.cameraDirection, uniforms.cameraUp));
  let up = cross(right, uniforms.cameraDirection);
  
  let rayDirection = normalize(
    uniforms.cameraDirection +
    ndc.x * right * fovScale +
    ndc.y * up * fovScale
  );
  
  return Ray(uniforms.cameraPosition, rayDirection);
}

// Ray-triangle intersection using Möller–Trumbore algorithm
fn rayTriangleIntersect(ray: Ray, triangleIndex: u32) -> HitRecord {
  var record: HitRecord;
  record.hit = false;
  record.t = 1e30;
  
  // Get triangle vertices
  let baseIdx = triangleIndex * 9;
  let v0 = vec3f(vertices[baseIdx],
                 vertices[baseIdx + 1],
                 vertices[baseIdx + 2]);
  
  let v1 = vec3f(vertices[baseIdx + 3],
                 vertices[baseIdx + 4],
                 vertices[baseIdx + 5]);
  
  let v2 = vec3f(vertices[baseIdx + 6],
                 vertices[baseIdx + 7],
                 vertices[baseIdx + 8]);
  
  // Compute edges
  let edge1 = v1 - v0;
  let edge2 = v2 - v0;
  
  // Begin Möller–Trumbore algorithm
  let h = cross(ray.direction, edge2);
  let a = dot(edge1, h);
  
  // Check if ray is parallel to triangle
  if (abs(a) < EPSILON) {
    return record;
  }
  
  let f = 1.0 / a;
  let s = ray.origin - v0;
  let u = f * dot(s, h);
  
  // Check barycentric u coordinate
  if (u < 0.0 || u > 1.0) {
    return record;
  }
  
  let q = cross(s, edge1);
  let v = f * dot(ray.direction, q);
  
  // Check barycentric v coordinate
  if (v < 0.0 || u + v > 1.0) {
    return record;
  }
  
  // Compute intersection distance
  let t = f * dot(edge2, q);
  
  if (t > EPSILON) {
    record.hit = true;
    record.t = t;
    record.position = ray.origin + ray.direction * t;
    
    // Get normals from buffer
    let n0 = vec3f(normals[baseIdx],
                   normals[baseIdx + 1],
                   normals[baseIdx + 2]);
    
    let n1 = vec3f(normals[baseIdx + 3],
                   normals[baseIdx + 4],
                   normals[baseIdx + 5]);
    
    let n2 = vec3f(normals[baseIdx + 6],
                   normals[baseIdx + 7],
                   normals[baseIdx + 8]);
    
    // Interpolate using barycentric coordinates
    let w = 1.0 - u - v;
    record.normal = normalize(w * n0 + u * n1 + v * n2);
    record.materialIndex = triangleIndex;
  }
  
  return record;
}

// Intersect ray with all triangles
fn intersectScene(ray: Ray) -> HitRecord {
  var closest: HitRecord;
  closest.hit = false;
  closest.t = 1e30;
  
  // Get triangle count
  let triangleCount = arrayLength(&vertices) / 9;
  
  // Test against all triangles
  for (var i = 0u; i < triangleCount; i++) {
    let hit = rayTriangleIntersect(ray, i);
    if (hit.hit && hit.t < closest.t) {
      closest = hit;
    }
  }
  
  return closest;
}

// Get material for a triangle
fn getMaterial(materialIndex: u32) -> Material {
  let baseIdx = materialIndex * 8;
  
  return Material(
    vec3f(materials[baseIdx],
          materials[baseIdx + 1],
          materials[baseIdx + 2]),
    materials[baseIdx + 3],
    materials[baseIdx + 4],
    materials[baseIdx + 5]
  );
}

// Sample environment (sky)
fn sampleEnvironment(direction: vec3f) -> vec3f {
  let t = 0.5 * (direction.y + 1.0);
  let skyColor = mix(
    vec3f(1.0, 1.0, 1.0),  // Horizon (white)
    vec3f(0.5, 0.7, 1.0),  // Zenith (light blue)
    t
  );
  
  return skyColor * uniforms.environmentIntensity;
}

// Path trace through the scene
fn pathTrace(ray: Ray, seed: ptr<function, u32>) -> vec3f {
  var result = vec3f(0.0);
  var throughput = vec3f(1.0);
  var currentRay = ray;
  
  for (var bounce = 0; bounce < MAX_BOUNCES; bounce++) {
    let hit = intersectScene(currentRay);
    
    if (!hit.hit) {
      // No hit, sample environment
      result += throughput * sampleEnvironment(currentRay.direction);
      break;
    }
    
    // Get material
    let material = getMaterial(hit.materialIndex);
    
    // Add emission
    result += throughput * material.albedo * material.emissive;
    
    // Russian roulette termination
    if (bounce > 1) {
      let p = max(max(throughput.r, throughput.g), throughput.b);
      if (rand(seed) > p) {
        break;
      }
      throughput /= p;
    }
    
    // Compute new ray direction based on material
    var newDirection: vec3f;
    if (material.metalness > rand(seed)) {
      // Metallic reflection (simplified)
      let reflected = reflect(currentRay.direction, hit.normal);
      
      // Add roughness
      let roughFactor = material.roughness * material.roughness;
      if (roughFactor > 0.0) {
        let randomDir = randomInUnitSphere(seed) * roughFactor;
        newDirection = normalize(reflected + randomDir);
        
        // Ensure reflection is above surface
        if (dot(newDirection, hit.normal) < 0.0) {
          newDirection = reflected;
        }
      } else {
        newDirection = reflected;
      }
      
      // Update throughput based on material color (metallic reflection)
      throughput *= material.albedo;
    } else {
      // Diffuse reflection
      newDirection = normalize(hit.normal + randomInUnitSphere(seed));
      
      // BRDF factor for diffuse is albedo/pi
      throughput *= material.albedo;
    }
    
    // Update ray for next bounce
    currentRay.origin = hit.position + hit.normal * EPSILON;
    currentRay.direction = newDirection;
  }
  
  return result;
}

// Main compute shader
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dimensions = textureDimensions(accumulationTexture);
  
  // Check if within bounds
  if (global_id.x >= dimensions.x || global_id.y >= dimensions.y) {
    return;
  }
  
  // Initialize random seed
  var seed = uniforms.seed + 
            global_id.x * 1973u + 
            global_id.y * 9277u + 
            uniforms.sampleCount * 26699u;
  
  // Generate ray for this pixel
  let ray = generateRay(global_id.xy, &seed);
  
  // Trace path through scene
  let radiance = pathTrace(ray, &seed);
  
  // Load previous accumulated color
  let previousColor = textureLoad(accumulationTexture, vec2i(global_id.xy));
  
  // Progressive accumulation
  var newColor: vec4f;
  if (uniforms.sampleCount == 0u) {
    newColor = vec4f(radiance, 1.0);
  } else {
    newColor = vec4f(
      (previousColor.rgb * f32(uniforms.sampleCount) + radiance) / f32(uniforms.sampleCount + 1u),
      1.0
    );
  }
  
  // Store accumulated result
  textureStore(accumulationTexture, vec2i(global_id.xy), newColor);
  
  // Apply tone mapping for display
  let toneMapped = newColor.rgb / (newColor.rgb + vec3f(1.0));
  let gammaCorrected = pow(toneMapped, vec3f(1.0/2.2));
  
  // Store result in output texture
  textureStore(outputTexture, vec2i(global_id.xy), vec4f(gammaCorrected, 1.0));
}
