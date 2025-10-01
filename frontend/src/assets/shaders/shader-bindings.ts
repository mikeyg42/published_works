/**
 * Constants defining shader binding groups and indices 
 * for ensuring consistency between shaders and runtime binding setup
 */

// Binding groups and indices used in the shaders
export const ShaderBindings = {
  // Path tracing compute shader bindings
  PathTracing: {
    Group0: {
      Uniforms: 0,
      prevAccumulationTexture: 1,
      accumulationTexture: 2,
      outputTexture: 3,
      vertices: 4,
      normals: 5,
      materials: 6,
    }
  },
  
  // Display shader bindings
  Display: {
    Group0: {
      OutputTexture: 0,
      TextureSampler: 1
    }
  }
};

// Type for binding group keys
type BindingGroupKey = keyof typeof ShaderBindings;
type GroupNumberStr = 'Group0' | 'Group1' | 'Group2' | 'Group3'; // Add more as needed
 
/**
 * Structure of uniform data expected by the path tracing shader
 * Must match the 'Uniforms' struct in pathTracing.wgsl
 */
export interface PathTracingUniforms {
  cameraPosition: [number, number, number, number]; // vec3f + padding
  cameraDirection: [number, number, number, number]; // vec3f + padding
  cameraUp: [number, number, number, number]; // vec3f + padding
  cameraFov: number;
  environmentIntensity: number;
  sampleCount: number;
  seed: number;
  time: number;
  aspectRatio: number;
}

/**
 * Structure of material data expected by the path tracing shader
 * Must match the 'Material' struct in pathTracing.wgsl
 */
export interface Material {
  albedo: [number, number, number]; // vec3f
  metalness: number;
  roughness: number;
  emissive: number;
}

/**
 * Descriptor for a single binding resource, including its type.
 */
export type BindingResourceDescriptor = {
  resource: GPUBindingResource;
  type: 'uniform-buffer' | 'storage-buffer' | 'sampler' | 'sampled-texture' | 'storage-texture';
  visibility?: GPUShaderStageFlags;
  storageTextureFormat?: GPUTextureFormat; // Only for storage textures
  storageTextureAccess?: GPUStorageTextureAccess; // Only for storage textures
  sampleType?: GPUTextureSampleType; // Only for sampled textures
};

/**
 * Helper function to create a bind group and its layout for a given shader and group.
 * @param device - The WebGPU device
 * @param shaderType - The shader type key (e.g., 'PathTracing')
 * @param groupNumber - The group number (e.g., 0 for Group0)
 * @param resources - A mapping from binding name to resource descriptor
 * @returns An object containing the bind group and its layout
 */
export function createBindGroupWithLayout(
  device: GPUDevice,
  shaderType: BindingGroupKey,
  groupNumber: number,
  resources: Record<string, BindingResourceDescriptor>
): { bindGroup: GPUBindGroup; layout: GPUBindGroupLayout } {
  const bindingsMap = ShaderBindings[shaderType];
  if (!bindingsMap) {
    throw new Error(`Unknown shader type: ${shaderType}`);
  }
  const groupKey = `Group${groupNumber}`;
  if (!(groupKey in bindingsMap)) {
    throw new Error(`Binding group not defined: ${groupKey} for ${shaderType}`);
  }
  const group = (bindingsMap as Record<string, any>)[groupKey];

  // Map the resources to the correct binding points
  const entries: GPUBindGroupEntry[] = [];
  const layoutEntries: GPUBindGroupLayoutEntry[] = [];

  for (const [name, desc] of Object.entries(resources)) {
    if (!(name in group)) {
      throw new Error(`Binding point not defined: ${name} in ${groupKey} for ${shaderType}`);
    }
    const bindingPoint = group[name as keyof typeof group] as number;
    entries.push({
      binding: bindingPoint,
      resource: desc.resource
    });
    // Determine layout entry
    let layoutEntry: GPUBindGroupLayoutEntry = {
      binding: bindingPoint,
      visibility: desc.visibility ?? (GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX),
    } as GPUBindGroupLayoutEntry;
    switch (desc.type) {
      case 'uniform-buffer':
        layoutEntry.buffer = { type: 'uniform' };
        break;
      case 'storage-buffer':
        layoutEntry.buffer = { type: 'storage' };
        break;
      case 'sampler':
        layoutEntry.sampler = {};
        break;
      case 'sampled-texture':
        layoutEntry.texture = {
          sampleType: desc.sampleType
        };
        break;
      case 'storage-texture':
        layoutEntry.storageTexture = {
          access: desc.storageTextureAccess ?? 'write-only',
          format: desc.storageTextureFormat ?? 'rgba8unorm',
        };
        break;
      default:
        throw new Error(`Unknown binding resource type: ${desc.type}`);
    }
    layoutEntries.push(layoutEntry);
  }

  const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries });
  const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries });
  return { bindGroup, layout: bindGroupLayout };
}