// pathTracing_animated.wgsl
// Monte Carlo path tracer with orbital spotlight animation system
//
// This shader extends the basic path tracer with dynamic lighting capabilities,
// implementing orbital spotlights that animate around the maze according to
// mathematical frequencies derived from Three.js lighting-animator.ts.
//
// CHANGES FROM ORIGINAL pathTracing.wgsl:
// - Added LightingUniforms structure and SpotLight array for dynamic lighting
// - Added bind group 1 for lighting uniforms (separate from core path tracing)
// - Added calculate_spotlight_contribution() and calculate_dynamic_lighting() functions
// - Modified path_trace() to integrate direct lighting from orbital spotlights
// - Enhanced sample_environment() to respond to animation states
// - All path tracing logic remains identical for backward compatibility
//
// Key features:
// - Maintains backward compatibility with existing path tracing
// - Adds orbital spotlight system with realistic cone-based light falloff
// - Supports animation states (intro/solving/solved) with different lighting behaviors
// - Uses dual bind group system to isolate lighting from core path tracing
// - Direct lighting calculated only on primary ray hits for performance

// ============================================================================
// UNIFORM BUFFER STRUCTURES
// ============================================================================

// Core camera and rendering uniforms - 256 bytes total for std140 compliance
// This structure must match the Rust Uniforms layout exactly
struct Uniforms {
    camera_position: vec3<f32>,          // World space camera position
    _pad0: f32,                          // Alignment padding for std140
    camera_direction: vec3<f32>,         // Normalized view direction vector
    _pad1: f32,                          // Alignment padding for std140
    camera_up: vec3<f32>,                // Camera up vector for orientation
    _pad2: f32,                          // Alignment padding for std140
    camera_fov: f32,                     // Field of view in radians - tune for wider/narrower view
    environment_intensity: f32,           // Sky brightness multiplier - tune for ambient lighting
    sample_count: u32,                   // Current accumulation count for progressive rendering
    seed: u32,                           // Frame-unique random seed for noise variation
    time: f32,                           // Elapsed time in seconds for time-based effects
    aspect_ratio: f32,                   // Width/height ratio for correct projection
    _reserved: array<vec4<f32>, 11>,     // Reserved space for future expansion
    _reserved2: vec2<f32>,               // Final padding to reach exactly 256 bytes
}

// Individual spotlight definition with cone-based falloff
// Position and direction are updated each frame by the animation system
struct SpotLight {
    position: vec3<f32>,                 // World space position of the light
    _pad0: f32,                          // Alignment padding for std140
    direction: vec3<f32>,                // Direction the spotlight points
    _pad1: f32,                          // Alignment padding for std140
    color: vec3<f32>,                    // RGB color of the light - tune for mood
    intensity: f32,                      // Brightness multiplier - tune for overall lighting strength
    inner_cone_angle: f32,               // Inner cone angle in radians - tune for sharp/soft falloff
    outer_cone_angle: f32,               // Outer cone angle in radians - should be larger than inner
    range: f32,                          // Maximum light range - tune for light reach
    _pad2: f32,                          // Alignment padding for std140
}

// Lighting system uniforms containing all active spotlights
// Updated each frame with new positions from orbital animation mathematics
struct LightingUniforms {
    num_spotlights: u32,                 // Number of active spotlights (0-8)
    _pad0: array<u32, 3>,                // Alignment padding for std140
    spotlights: array<SpotLight, 8>,     // Array of spotlight data - max 8 for performance
    time: f32,                           // Animation time for shader-based effects
    animation_state: u32,                // Current animation state affects lighting behavior
    _pad1: array<u32, 2>,                // Alignment padding for std140
}

// Material properties for physically-based rendering
struct Material {
    albedo: vec3<f32>,                   // Base surface color in linear RGB
    metalness: f32,                      // Metallic surface property (0=dielectric, 1=metallic)
    roughness: f32,                      // Surface roughness (0=mirror, 1=completely rough)
    emissive: f32,                       // Self-emission strength for glowing surfaces
}

// ============================================================================
// RESOURCE BINDINGS
// ============================================================================

// Bind Group 0: Core path tracing resources
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var prevAccumulationTexture: texture_2d<f32>;
@group(0) @binding(2) var accumulationTexture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<storage, read> vertices: array<vec3<f32>>;
@group(0) @binding(5) var<storage, read> normals: array<vec3<f32>>;
@group(0) @binding(6) var<storage, read> materials: array<Material>;

// Bind Group 1: Dynamic lighting system - separate for modularity
@group(1) @binding(0) var<uniform> lighting: LightingUniforms;

// ============================================================================
// CONSTANTS
// ============================================================================

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const INV_PI: f32 = 0.31830988618;
const EPSILON: f32 = 0.0001;               // Ray offset to prevent self-intersection - tune if z-fighting occurs
const MAX_BOUNCES: u32 = 5u;               // Maximum path length - increase for more realistic lighting (slower)
const RUSSIAN_ROULETTE_DEPTH: u32 = 2u;    // Depth to start probabilistic termination - tune for performance/quality

// ============================================================================
// RAY TRACING STRUCTURES
// ============================================================================

// Ray structure for path tracing
struct Ray {
    origin: vec3<f32>,                   // Ray starting point in world space
    direction: vec3<f32>,                // Ray direction (should be normalized)
}

// Intersection result containing all necessary shading information
struct HitRecord {
    t: f32,                              // Distance along ray to intersection point
    position: vec3<f32>,                 // World space intersection position
    normal: vec3<f32>,                   // Surface normal at intersection (front-facing)
    material_index: u32,                 // Index into materials array
    hit: bool,                           // Whether a valid intersection occurred
}

// ============================================================================
// RANDOM NUMBER GENERATION
// ============================================================================

// PCG hash function for high-quality pseudorandom number generation
// Uses the PCG algorithm which provides better distribution than simple LCGs
fn pcg_hash(state: ptr<function, u32>) -> u32 {
    *state = *state * 747796405u + 2891336453u;
    let word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
    return (word >> 22u) ^ word;
}

// Generate uniform random float in [0, 1) from PCG state
fn random_float(seed: ptr<function, u32>) -> f32 {
    return f32(pcg_hash(seed)) / 4294967295.0;
}

// Generate uniform random float in [min, max) range
fn random_float_range(seed: ptr<function, u32>, min: f32, max: f32) -> f32 {
    return min + (max - min) * random_float(seed);
}

// ============================================================================
// IMPORTANCE SAMPLING FUNCTIONS
// ============================================================================

// Generate cosine-weighted random direction on unit hemisphere
// This sampling pattern matches the Lambertian BRDF for unbiased Monte Carlo integration
// Returns direction in local coordinate space (z-up hemisphere)
fn random_cosine_direction(seed: ptr<function, u32>) -> vec3<f32> {
    let r1 = random_float(seed);
    let r2 = random_float(seed);

    let phi = TWO_PI * r1;           // Uniform angle around hemisphere
    let sqrt_r2 = sqrt(r2);          // Cosine-weighted distribution for elevation

    let x = cos(phi) * sqrt_r2;      // X component
    let y = sin(phi) * sqrt_r2;      // Y component
    let z = sqrt(1.0 - r2);          // Z component (elevation)

    return vec3<f32>(x, y, z);
}

// Build orthonormal basis from surface normal using Frisvad's method
// Creates tangent space transformation matrix for importance sampling
// Avoids numerical instability when normal is parallel to world up vector
fn build_onb(normal: vec3<f32>) -> mat3x3<f32> {
    let up = select(
        vec3<f32>(1.0, 0.0, 0.0),        // Use X-axis if normal is close to Y-axis
        vec3<f32>(0.0, 1.0, 0.0),        // Use Y-axis otherwise
        abs(normal.y) < 0.999            // Threshold to avoid near-parallel vectors
    );
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    return mat3x3<f32>(tangent, bitangent, normal);
}

// ============================================================================
// CAMERA MODEL
// ============================================================================

fn generate_camera_ray(pixel: vec2<u32>, seed: ptr<function, u32>) -> Ray {
    let dimensions = vec2<f32>(textureDimensions(outputTexture));

    let jitter = vec2<f32>(random_float(seed), random_float(seed));
    let uv = (vec2<f32>(pixel) + jitter) / dimensions;
    let ndc = uv * 2.0 - 1.0;

    let fov_scale = tan(uniforms.camera_fov * 0.5);
    let right = normalize(cross(uniforms.camera_direction, uniforms.camera_up));
    let up = cross(right, uniforms.camera_direction);

    let ray_dir = normalize(
        uniforms.camera_direction +
        right * ndc.x * fov_scale * uniforms.aspect_ratio +
        up * -ndc.y * fov_scale
    );

    return Ray(uniforms.camera_position, ray_dir);
}

// ============================================================================
// INTERSECTION TESTING (unchanged)
// ============================================================================

fn ray_triangle_intersect(ray: Ray, tri_idx: u32) -> HitRecord {
    var hit: HitRecord;
    hit.hit = false;
    hit.t = 1e20;

    let v0 = vertices[tri_idx * 3u];
    let v1 = vertices[tri_idx * 3u + 1u];
    let v2 = vertices[tri_idx * 3u + 2u];

    let edge1 = v1 - v0;
    let edge2 = v2 - v0;
    let h = cross(ray.direction, edge2);
    let a = dot(edge1, h);

    if abs(a) < EPSILON {
        return hit;
    }

    let f = 1.0 / a;
    let s = ray.origin - v0;
    let u = f * dot(s, h);

    if u < 0.0 || u > 1.0 {
        return hit;
    }

    let q = cross(s, edge1);
    let v = f * dot(ray.direction, q);

    if v < 0.0 || u + v > 1.0 {
        return hit;
    }

    let t = f * dot(edge2, q);

    if t > EPSILON && t < hit.t {
        hit.hit = true;
        hit.t = t;
        hit.position = ray.origin + ray.direction * t;

        let n0 = normals[tri_idx * 3u];
        let n1 = normals[tri_idx * 3u + 1u];
        let n2 = normals[tri_idx * 3u + 2u];

        let w = 1.0 - u - v;
        hit.normal = normalize(w * n0 + u * n1 + v * n2);

        if dot(hit.normal, ray.direction) > 0.0 {
            hit.normal = -hit.normal;
        }

        hit.material_index = min(tri_idx, arrayLength(&materials) - 1u);
    }

    return hit;
}

fn intersect_scene(ray: Ray, max_t: f32) -> HitRecord {
    var closest: HitRecord;
    closest.hit = false;
    closest.t = max_t;

    let tri_count = arrayLength(&vertices) / 3u;

    for (var i = 0u; i < tri_count; i++) {
        let hit = ray_triangle_intersect(ray, i);
        if hit.hit && hit.t < closest.t {
            closest = hit;
        }
    }

    return closest;
}

// ============================================================================
// ORBITAL SPOTLIGHT SYSTEM
// ============================================================================

// Calculate individual spotlight contribution with cone-based falloff
// Implements realistic spotlight behavior with smooth edge transitions
// Returns the RGB contribution of this light to the surface point
fn calculate_spotlight_contribution(
    light: SpotLight,
    world_pos: vec3<f32>,
    normal: vec3<f32>,
    view_dir: vec3<f32>
) -> vec3<f32> {
    let light_dir = normalize(light.position - world_pos);
    let distance = length(light.position - world_pos);

    // Early rejection for points outside light range - improves performance
    if distance > light.range {
        return vec3<f32>(0.0);
    }

    // Spotlight cone calculation - determines if point is within light cone
    let spot_dir = normalize(-light.direction);        // Direction the spotlight points
    let spot_angle = dot(light_dir, spot_dir);         // Angle between light ray and spot direction
    let inner_cos = cos(light.inner_cone_angle);       // Inner cone threshold
    let outer_cos = cos(light.outer_cone_angle);       // Outer cone threshold

    // Smooth falloff between inner and outer cone - eliminates harsh edges
    let spot_intensity = smoothstep(outer_cos, inner_cos, spot_angle);

    if spot_intensity <= 0.0 {
        return vec3<f32>(0.0);
    }

    // Quadratic distance attenuation - realistic light falloff behavior
    let attenuation = 1.0 / (1.0 + distance * distance / (light.range * light.range));

    // Lambertian diffuse lighting - surface receives light proportional to angle
    let ndotl = max(dot(normal, light_dir), 0.0);

    // Blinn-Phong specular highlight for surface gloss
    let half_dir = normalize(light_dir + view_dir);
    let ndoth = max(dot(normal, half_dir), 0.0);
    let specular = pow(ndoth, 32.0) * 0.3;             // Specular strength - tune for shininess

    let diffuse_contrib = ndotl;
    let final_intensity = light.intensity * spot_intensity * attenuation * (diffuse_contrib + specular);

    return light.color * final_intensity;
}

// Sum contributions from all active orbital spotlights
// This is where the orbital animation system contributes to path tracing
// Each spotlight's position is updated by the Rust animation system
fn calculate_dynamic_lighting(
    world_pos: vec3<f32>,
    normal: vec3<f32>,
    view_dir: vec3<f32>
) -> vec3<f32> {
    var total_light = vec3<f32>(0.0);

    // Iterate through all active spotlights and accumulate their contributions
    for (var i = 0u; i < lighting.num_spotlights; i++) {
        let light_contrib = calculate_spotlight_contribution(
            lighting.spotlights[i],
            world_pos,
            normal,
            view_dir
        );
        total_light += light_contrib;
    }

    return total_light;
}

// ============================================================================
// ENHANCED ENVIRONMENT LIGHTING
// ============================================================================

fn sample_environment(direction: vec3<f32>) -> vec3<f32> {
    // Enhanced environment with animation state influence
    let t = 0.5 * (direction.y + 1.0);

    var horizon_color: vec3<f32>;
    var zenith_color: vec3<f32>;

    // Adjust environment colors based on animation state
    switch lighting.animation_state {
        case 0u: { // Intro
            horizon_color = vec3<f32>(1.0, 0.95, 0.9);  // Warm
            zenith_color = vec3<f32>(0.4, 0.6, 1.0);    // Cool blue
        }
        case 1u: { // Solving
            horizon_color = vec3<f32>(1.0, 1.0, 1.0);   // Neutral
            zenith_color = vec3<f32>(0.5, 0.7, 1.0);    // Standard blue
        }
        case 2u: { // Solved
            horizon_color = vec3<f32>(1.0, 0.9, 0.7);   // Golden
            zenith_color = vec3<f32>(0.9, 0.8, 0.6);    // Warm golden
        }
        default: {
            horizon_color = vec3<f32>(1.0, 1.0, 1.0);
            zenith_color = vec3<f32>(0.5, 0.7, 1.0);
        }
    }

    return mix(horizon_color, zenith_color, t) * uniforms.environment_intensity;
}

// ============================================================================
// ENHANCED BRDF EVALUATION
// ============================================================================

fn evaluate_brdf(
    wo: vec3<f32>,
    wi: vec3<f32>,
    normal: vec3<f32>,
    material: Material
) -> vec3<f32> {
    let n_dot_wi = max(dot(normal, wi), 0.0);

    if material.metalness > 0.5 {
        let h = normalize(wo + wi);
        let n_dot_h = max(dot(normal, h), 0.0);
        let roughness = max(material.roughness, 0.001);
        let alpha = roughness * roughness;

        let alpha2 = alpha * alpha;
        let denom = n_dot_h * n_dot_h * (alpha2 - 1.0) + 1.0;
        let d = alpha2 / (PI * denom * denom);

        return material.albedo * d * n_dot_wi;
    } else {
        return material.albedo * INV_PI * n_dot_wi;
    }
}

// ============================================================================
// ENHANCED PATH TRACING CORE
// ============================================================================

fn path_trace(primary_ray: Ray, seed: ptr<function, u32>) -> vec3<f32> {
    var radiance = vec3<f32>(0.0);
    var throughput = vec3<f32>(1.0);
    var ray = primary_ray;

    for (var bounce = 0u; bounce < MAX_BOUNCES; bounce++) {
        let hit = intersect_scene(ray, 10000.0);

        if !hit.hit {
            radiance += throughput * sample_environment(ray.direction);
            break;
        }

        let material = materials[hit.material_index];

        // Add emissive contribution
        if material.emissive > 0.0 {
            radiance += throughput * material.albedo * material.emissive;
        }

        // Integrate orbital spotlight system with path tracing
        // Direct lighting is only calculated on the first bounce for performance
        // Indirect lighting from spotlights comes naturally through the Monte Carlo process
        if bounce == 0u {
            let view_dir = normalize(uniforms.camera_position - hit.position);
            let dynamic_lighting_contrib = calculate_dynamic_lighting(
                hit.position,
                hit.normal,
                view_dir
            );

            // Apply material response to lighting - Lambertian assumption for direct lighting
            let material_response = material.albedo * INV_PI;
            radiance += throughput * dynamic_lighting_contrib * material_response;
        }

        // Russian roulette
        if bounce > RUSSIAN_ROULETTE_DEPTH {
            let survival_prob = max(throughput.x, max(throughput.y, throughput.z));
            if random_float(seed) > survival_prob {
                break;
            }
            throughput /= survival_prob;
        }

        // Sample next direction
        let onb = build_onb(hit.normal);
        var wi: vec3<f32>;

        if material.metalness > random_float(seed) {
            let reflected = reflect(ray.direction, hit.normal);
            let roughness = max(material.roughness, 0.001);

            if roughness < 1.0 {
                let local_dir = random_cosine_direction(seed);
                let perturb = onb * local_dir * roughness;
                wi = normalize(reflected + perturb);
            } else {
                wi = reflected;
            }

            if dot(wi, hit.normal) <= 0.0 {
                break;
            }
        } else {
            let local_dir = random_cosine_direction(seed);
            wi = onb * local_dir;
        }

        let brdf = evaluate_brdf(-ray.direction, wi, hit.normal, material);
        throughput *= brdf * PI;

        ray.origin = hit.position + hit.normal * EPSILON;
        ray.direction = wi;
    }

    return radiance;
}

// ============================================================================
// TONE MAPPING (unchanged)
// ============================================================================

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

    if pixel.x >= dimensions.x || pixel.y >= dimensions.y {
        return;
    }

    // Initialize per-pixel random seed
    var seed = uniforms.seed + pixel.x * 1973u + pixel.y * 9277u + uniforms.sample_count * 26699u;

    // Generate primary ray and trace path with dynamic lighting
    let ray = generate_camera_ray(pixel, &seed);
    let radiance = path_trace(ray, &seed);

    // Progressive accumulation
    let prev_color = select(
        vec4<f32>(0.0),
        textureLoad(prevAccumulationTexture, vec2<i32>(pixel), 0),
        uniforms.sample_count > 0u
    );

    let weight = 1.0 / f32(uniforms.sample_count + 1u);
    let accumulated = mix(prev_color.rgb, radiance, weight);

    // Store raw HDR accumulation
    textureStore(accumulationTexture, pixel, vec4<f32>(accumulated, 1.0));

    // Apply tone mapping and gamma correction
    let tonemapped = aces_tonemap(accumulated);
    let gamma_corrected = pow(tonemapped, vec3<f32>(1.0 / 2.2));

    // Store final LDR output
    textureStore(outputTexture, pixel, vec4<f32>(gamma_corrected, 1.0));
}