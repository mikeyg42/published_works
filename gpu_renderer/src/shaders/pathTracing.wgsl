// pathTracing.wgsl
// Monte Carlo path tracer for maze visualization using accumulation-based convergence
// Implements unbiased path tracing with importance sampling and Russian roulette

// ============================================================================
// UNIFORM BUFFER STRUCTURE
// ============================================================================

// 256-byte uniform buffer matching Rust layout exactly
// All padding fields are required for std140 alignment compliance
struct Uniforms {
    camera_position: vec3<f32>,          // bytes 0-12: World space camera position
    _pad0: f32,                           // bytes 12-16: Alignment padding
    camera_direction: vec3<f32>,         // bytes 16-28: Normalized view direction
    _pad1: f32,                           // bytes 28-32: Alignment padding
    camera_up: vec3<f32>,                // bytes 32-44: Camera up vector
    _pad2: f32,                           // bytes 44-48: Alignment padding
    camera_fov: f32,                      // bytes 48-52: Field of view in radians
    environment_intensity: f32,           // bytes 52-56: Sky brightness multiplier
    sample_count: u32,                    // bytes 56-60: Current accumulation count
    seed: u32,                            // bytes 60-64: Frame-unique random seed
    time: f32,                            // bytes 64-68: Elapsed time in seconds
    aspect_ratio: f32,                    // bytes 68-72: Width/height ratio
    _reserved: array<vec4<f32>, 11>,     // bytes 72-248: Reserved for future use
    _reserved2: vec2<f32>,                // bytes 248-256: Final alignment padding
}

// ============================================================================
// MATERIAL DEFINITION
// ============================================================================

// Simplified PBR material model
struct Material {
    albedo: vec3<f32>,     // Base color (linear RGB)
    metalness: f32,        // 0=dielectric, 1=metallic
    roughness: f32,        // 0=mirror, 1=diffuse
    emissive: f32,         // Emission strength multiplier
}

// ============================================================================
// RESOURCE BINDINGS
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var prevAccumulationTexture: texture_2d<f32>;
@group(0) @binding(2) var accumulationTexture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<storage, read> vertices: array<vec3<f32>>;
@group(0) @binding(5) var<storage, read> normals: array<vec3<f32>>;
@group(0) @binding(6) var<storage, read> materials: array<Material>;

// ============================================================================
// CONSTANTS
// ============================================================================

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;           // Ray offset to prevent self-intersection
const MAX_BOUNCES: u32 = 5u;           // Maximum path length
const RUSSIAN_ROULETTE_DEPTH: u32 = 2u; // Start RR after this many bounces

// ============================================================================
// RAY TRACING STRUCTURES
// ============================================================================

struct Ray {
    origin: vec3<f32>,
    direction: vec3<f32>,
}

struct HitRecord {
    t: f32,                    // Ray parameter at intersection
    position: vec3<f32>,       // World space hit point
    normal: vec3<f32>,         // Shading normal (front-facing)
    material_index: u32,       // Index into materials array
    hit: bool,                 // Valid intersection flag
}

// ============================================================================
// RANDOM NUMBER GENERATION
// ============================================================================

// PCG hash function for high-quality pseudo-random numbers
fn pcg_hash(state: ptr<function, u32>) -> u32 {
    *state = *state * 747796405u + 2891336453u;
    let word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
    return (word >> 22u) ^ word;
}

// Generate uniform random float in [0, 1)
fn random_float(seed: ptr<function, u32>) -> f32 {
    return f32(pcg_hash(seed)) / 4294967295.0;
}

// Generate uniform random float in [min, max)
fn random_float_range(seed: ptr<function, u32>, min: f32, max: f32) -> f32 {
    return min + (max - min) * random_float(seed);
}

// ============================================================================
// SAMPLING FUNCTIONS
// ============================================================================

// Generate cosine-weighted random direction on hemisphere
// Used for importance sampling of Lambertian BRDF
fn random_cosine_direction(seed: ptr<function, u32>) -> vec3<f32> {
    let r1 = random_float(seed);
    let r2 = random_float(seed);
    
    let phi = TWO_PI * r1;
    let sqrt_r2 = sqrt(r2);
    
    // Generate point on unit hemisphere with cosine distribution
    let x = cos(phi) * sqrt_r2;
    let y = sin(phi) * sqrt_r2;
    let z = sqrt(1.0 - r2);
    
    return vec3<f32>(x, y, z);
}

// Build orthonormal basis from normal vector
// Uses Frisvad's method for numerical stability
fn build_onb(normal: vec3<f32>) -> mat3x3<f32> {
    let up = select(
        vec3<f32>(1.0, 0.0, 0.0),
        vec3<f32>(0.0, 1.0, 0.0),
        abs(normal.y) < 0.999
    );
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    return mat3x3<f32>(tangent, bitangent, normal);
}

// ============================================================================
// CAMERA MODEL
// ============================================================================

// Generate primary ray from camera through pixel
// Includes anti-aliasing via random sub-pixel offset
fn generate_camera_ray(pixel: vec2<u32>, seed: ptr<function, u32>) -> Ray {
    let dimensions = vec2<f32>(textureDimensions(outputTexture));
    
    // Apply random offset within pixel for anti-aliasing
    let jitter = vec2<f32>(random_float(seed), random_float(seed));
    let uv = (vec2<f32>(pixel) + jitter) / dimensions;
    
    // Convert to normalized device coordinates [-1, 1]
    let ndc = uv * 2.0 - 1.0;
    
    // Build camera coordinate system
    let fov_scale = tan(uniforms.camera_fov * 0.5);
    let right = normalize(cross(uniforms.camera_direction, uniforms.camera_up));
    let up = cross(right, uniforms.camera_direction);
    
    // Calculate ray direction
    let ray_dir = normalize(
        uniforms.camera_direction +
        right * ndc.x * fov_scale * uniforms.aspect_ratio +
        up * -ndc.y * fov_scale  // Negative Y for correct orientation
    );
    
    return Ray(uniforms.camera_position, ray_dir);
}

// ============================================================================
// INTERSECTION TESTING
// ============================================================================

// Möller-Trumbore ray-triangle intersection
// Returns hit record with interpolated shading normal
fn ray_triangle_intersect(ray: Ray, tri_idx: u32) -> HitRecord {
    var hit: HitRecord;
    hit.hit = false;
    hit.t = 1e20;
    
    // Fetch triangle vertices (3 consecutive vec3s per triangle)
    let v0 = vertices[tri_idx * 3u];
    let v1 = vertices[tri_idx * 3u + 1u];
    let v2 = vertices[tri_idx * 3u + 2u];
    
    // Calculate edge vectors
    let edge1 = v1 - v0;
    let edge2 = v2 - v0;
    let h = cross(ray.direction, edge2);
    let a = dot(edge1, h);
    
    // Check if ray is parallel to triangle
    if abs(a) < EPSILON {
        return hit;
    }
    
    let f = 1.0 / a;
    let s = ray.origin - v0;
    let u = f * dot(s, h);
    
    // Check barycentric coordinate u
    if u < 0.0 || u > 1.0 {
        return hit;
    }
    
    let q = cross(s, edge1);
    let v = f * dot(ray.direction, q);
    
    // Check barycentric coordinate v
    if v < 0.0 || u + v > 1.0 {
        return hit;
    }
    
    // Calculate intersection distance
    let t = f * dot(edge2, q);
    
    if t > EPSILON && t < hit.t {
        hit.hit = true;
        hit.t = t;
        hit.position = ray.origin + ray.direction * t;
        
        // Fetch and interpolate vertex normals
        let n0 = normals[tri_idx * 3u];
        let n1 = normals[tri_idx * 3u + 1u];
        let n2 = normals[tri_idx * 3u + 2u];
        
        let w = 1.0 - u - v;
        hit.normal = normalize(w * n0 + u * n1 + v * n2);
        
        // Ensure normal faces against ray direction
        if dot(hit.normal, ray.direction) > 0.0 {
            hit.normal = -hit.normal;
        }
        
        // Store material index (clamped to valid range)
        hit.material_index = min(tri_idx, arrayLength(&materials) - 1u);
    }
    
    return hit;
}

// Test ray against entire scene geometry
// Returns closest intersection if any
fn intersect_scene(ray: Ray, max_t: f32) -> HitRecord {
    var closest: HitRecord;
    closest.hit = false;
    closest.t = max_t;
    
    let tri_count = arrayLength(&vertices) / 3u;
    
    // Linear search through all triangles
    // Future optimization: Add BVH acceleration structure
    for (var i = 0u; i < tri_count; i++) {
        let hit = ray_triangle_intersect(ray, i);
        if hit.hit && hit.t < closest.t {
            closest = hit;
        }
    }
    
    return closest;
}

// ============================================================================
// ENVIRONMENT LIGHTING
// ============================================================================

// Sample environment map (simple gradient sky)
// Returns radiance for rays that escape the scene
fn sample_environment(direction: vec3<f32>) -> vec3<f32> {
    // Gradient from horizon to zenith based on Y component
    let t = 0.5 * (direction.y + 1.0);
    let horizon_color = vec3<f32>(1.0, 1.0, 1.0);
    let zenith_color = vec3<f32>(0.5, 0.7, 1.0);
    return mix(horizon_color, zenith_color, t) * uniforms.environment_intensity;
}

// ============================================================================
// BRDF EVALUATION
// ============================================================================

// Evaluate simplified PBR BRDF
// Returns BRDF * cos(theta) for importance sampled direction
fn evaluate_brdf(
    wo: vec3<f32>,      // Outgoing direction (to camera)
    wi: vec3<f32>,      // Incoming direction (from light)
    normal: vec3<f32>,  // Shading normal
    material: Material
) -> vec3<f32> {
    let n_dot_wi = max(dot(normal, wi), 0.0);
    
    if material.metalness > 0.5 {
        // Simplified metallic BRDF with GGX distribution
        let h = normalize(wo + wi);
        let n_dot_h = max(dot(normal, h), 0.0);
        let roughness = max(material.roughness, 0.001);
        let alpha = roughness * roughness;
        
        // GGX normal distribution
        let alpha2 = alpha * alpha;
        let denom = n_dot_h * n_dot_h * (alpha2 - 1.0) + 1.0;
        let d = alpha2 / (PI * denom * denom);
        
        return material.albedo * d * n_dot_wi;
    } else {
        // Lambertian diffuse BRDF
        return material.albedo * INV_PI * n_dot_wi;
    }
}

// ============================================================================
// PATH TRACING CORE
// ============================================================================

// Trace path through scene using Monte Carlo integration
// Returns estimated radiance along ray
fn path_trace(primary_ray: Ray, seed: ptr<function, u32>) -> vec3<f32> {
    var radiance = vec3<f32>(0.0);
    var throughput = vec3<f32>(1.0);
    var ray = primary_ray;
    
    for (var bounce = 0u; bounce < MAX_BOUNCES; bounce++) {
        // Find nearest intersection
        let hit = intersect_scene(ray, 10000.0);
        
        // If no hit, sample environment
        if !hit.hit {
            radiance += throughput * sample_environment(ray.direction);
            break;
        }
        
        // Fetch material properties
        let material = materials[hit.material_index];
        
        // Add emissive contribution
        if material.emissive > 0.0 {
            radiance += throughput * material.albedo * material.emissive;
        }
        
        // Russian roulette for path termination
        if bounce > RUSSIAN_ROULETTE_DEPTH {
            let survival_prob = max(throughput.x, max(throughput.y, throughput.z));
            if random_float(seed) > survival_prob {
                break;
            }
            throughput /= survival_prob;
        }
        
        // Sample next direction based on material
        let onb = build_onb(hit.normal);
        var wi: vec3<f32>;
        
        if material.metalness > random_float(seed) {
            // Metallic reflection with roughness
            let reflected = reflect(ray.direction, hit.normal);
            let roughness = max(material.roughness, 0.001);
            
            if roughness < 1.0 {
                // Add roughness perturbation
                let local_dir = random_cosine_direction(seed);
                let perturb = onb * local_dir * roughness;
                wi = normalize(reflected + perturb);
            } else {
                wi = reflected;
            }
            
            // Terminate if reflection goes below surface
            if dot(wi, hit.normal) <= 0.0 {
                break;
            }
        } else {
            // Diffuse reflection with cosine-weighted sampling
            let local_dir = random_cosine_direction(seed);
            wi = onb * local_dir;
        }
        
        // Update throughput with BRDF
        let brdf = evaluate_brdf(-ray.direction, wi, hit.normal, material);
        throughput *= brdf * PI;  // PI cancels with 1/PI from PDF
        
        // Setup next ray segment
        ray.origin = hit.position + hit.normal * EPSILON;
        ray.direction = wi;
    }
    
    return radiance;
}

// ============================================================================
// TONE MAPPING
// ============================================================================

// ACES filmic tone mapping operator
// Maps HDR values to [0,1] with film-like response curve
fn aces_tonemap(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

// ============================================================================
// MAIN COMPUTE KERNEL
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let pixel = global_id.xy;
    let dimensions = textureDimensions(outputTexture);
    
    // Bounds check
    if pixel.x >= dimensions.x || pixel.y >= dimensions.y {
        return;
    }
    
    // Initialize per-pixel random seed
    var seed = uniforms.seed + pixel.x * 1973u + pixel.y * 9277u + uniforms.sample_count * 26699u;
    
    // Generate primary ray and trace path
    let ray = generate_camera_ray(pixel, &seed);
    let radiance = path_trace(ray, &seed);
    
    // Load previous accumulation (or zero on first frame)
    let prev_color = select(
        vec4<f32>(0.0),
        textureLoad(prevAccumulationTexture, vec2<i32>(pixel), 0),
        uniforms.sample_count > 0u
    );
    
    // Progressive accumulation with incremental averaging
    let weight = 1.0 / f32(uniforms.sample_count + 1u);
    let accumulated = mix(prev_color.rgb, radiance, weight);
    
    // Store raw HDR accumulation
    textureStore(accumulationTexture, pixel, vec4<f32>(accumulated, 1.0));
    
    // Apply tone mapping and gamma correction for display
    let tonemapped = aces_tonemap(accumulated);
    let gamma_corrected = pow(tonemapped, vec3<f32>(1.0 / 2.2));
    
    // Store final LDR output
    textureStore(outputTexture, pixel, vec4<f32>(gamma_corrected, 1.0));
}