/**
 * Utility file for WebGPU availability checking and feature detection
 */

/**
 * Features required by the application
 */
export interface RequiredWebGPUFeatures {
  // Core features needed for the application
  requiredFeatures: GPUFeatureName[];

  // Optional features that enhance the experience but aren't necessary
  optionalFeatures?: GPUFeatureName[];

  // Minimum limits required (like maxBindGroups, maxBufferSize, etc.)
  requiredLimits?: Partial<Record<keyof GPUSupportedLimits, number>>;
}

/**
 * Result of checking WebGPU availability
 */
export interface WebGPUAvailabilityResult {
  available: boolean;
  adapter?: GPUAdapter;
  device?: GPUDevice;
  missingFeatures?: string[];
  limitIssues?: Record<string, { required: number; available: number }>;
  error?: Error;
}

/**
 * Check if WebGPU is available and has required features
 *
 * @param requirements The features and limits required by the application
 * @returns A promise that resolves to the availability result
 */
export async function checkWebGPUAvailability(
  requirements: RequiredWebGPUFeatures
): Promise<WebGPUAvailabilityResult> {
  // Check if navigator.gpu exists
  if (!navigator.gpu) {
    return {
      available: false,
      error: new Error('WebGPU not supported in this browser')
    };
  }

  try {
    // Request adapter with power preference
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });

    if (!adapter) {
      return {
        available: false,
        error: new Error('Couldn\'t request WebGPU adapter')
      };
    }

    // Check required features
    const missingFeatures = requirements.requiredFeatures.filter(
      feature => !adapter.features.has(feature)
    );

    if (missingFeatures.length > 0) {
      return {
        available: false,
        adapter,
        missingFeatures,
        error: new Error(`Missing required WebGPU features: ${missingFeatures.join(', ')}`)
      };
    }

    // Check required limits
    const limitIssues: Record<string, { required: number; available: number }> = {};

    if (requirements.requiredLimits) {
      for (const [limitName, requiredValue] of Object.entries(requirements.requiredLimits)) {
        // Safe access to limits
        const limitKey = limitName as keyof GPUSupportedLimits;
        if (limitKey in adapter.limits) {
          const availableValue = adapter.limits[limitKey];

          if (typeof availableValue === 'number' && availableValue < requiredValue) {
            limitIssues[limitName] = {
              required: requiredValue,
              available: availableValue
            };
          }
        } else {
          // Limit not found on adapter
          limitIssues[limitName] = {
            required: requiredValue,
            available: 0
          };
        }
      }

      if (Object.keys(limitIssues).length > 0) {
        return {
          available: false,
          adapter,
          limitIssues,
          error: new Error('Device does not meet required WebGPU limits')
        };
      }
    }

    // Request device with required features and limits
    const device = await adapter.requestDevice({
      requiredFeatures: requirements.requiredFeatures,
      requiredLimits: requirements.requiredLimits
    });

    return {
      available: true,
      adapter,
      device
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error : new Error('Unknown error initializing WebGPU')
    };
  }
}

/**
 * Default required features for path tracing application - RELAXED for compatibility
 */
export const defaultPathTracingRequirements: RequiredWebGPUFeatures = {
  requiredFeatures: [
    // Remove timestamp-query and other non-essential features for now
    // 'timestamp-query',         // For performance measurement
    // 'indirect-first-instance', // For more efficient rendering
  ],
  optionalFeatures: [
    'timestamp-query',         // Move to optional
    'indirect-first-instance', // Move to optional
    'depth-clip-control',      // Better depth buffer control
    'float32-filterable'       // For better texture filtering
  ],
  requiredLimits: {
    maxBufferSize: 134217728,            // 128MB buffer size (reduced)
    maxStorageBufferBindingSize: 67108864, // 64MB storage buffer (reduced)
    maxComputeWorkgroupStorageSize: 16384,  // 16KB workgroup memory (reduced)
    maxComputeInvocationsPerWorkgroup: 512, // Reduced from 1024
    maxComputeWorkgroupSizeX: 256,          // Reduced from 1024
    maxComputeWorkgroupSizeY: 256,          // Reduced from 1024
    maxComputeWorkgroupSizeZ: 64,
    maxBindGroups: 4,
    maxBindingsPerBindGroup: 8,
    maxSampledTexturesPerShaderStage: 16
  }
};

/**
 * Helper function to initialize WebGPU with error handling
 *
 * @param requirements The features and limits required by the application
 * @param errorCallback Function to call if initialization fails
 * @returns A promise that resolves to the device or null
 */
export async function initializeWebGPU(
  requirements: RequiredWebGPUFeatures = defaultPathTracingRequirements,
  errorCallback?: (message: string, error?: Error) => void
): Promise<GPUDevice | null> {
  const result = await checkWebGPUAvailability(requirements);

  if (!result.available) {
    const errorMessage = result.error?.message ||
                         (result.missingFeatures?.length
                           ? `Missing WebGPU features: ${result.missingFeatures.join(', ')}`
                           : 'WebGPU not available');

    // Format limit issues if any
    let detailedError = errorMessage;
    if (result.limitIssues && Object.keys(result.limitIssues).length > 0) {
      detailedError += '\nLimit issues:';
      for (const [limit, values] of Object.entries(result.limitIssues)) {
        detailedError += `\n- ${limit}: required ${values.required}, available ${values.available}`;
      }
    }

    if (errorCallback) {
      errorCallback(detailedError, result.error);
    } else {
      console.error('WebGPU initialization failed:', detailedError);
    }

    return null;
  }

  return result.device!;
}

export async function assessDevicePerformance(
  device: GPUDevice,
  adapter: GPUAdapter
): Promise<{
  rating: 'low' | 'medium' | 'high';
  recommendedSettings: {
    workgroupSize: [number, number];
    maxBounces: number;
    useAO: boolean;
  };
}> {
  // Try to use adapter info if available (not always implemented)
  let adapterInfo: GPUAdapterInfo | null = null;
  if ('requestAdapterInfo' in adapter) {
    try {
      adapterInfo = await (adapter as any).requestAdapterInfo();
    } catch {}
  }

  // Use device limits as a proxy for performance
  const { maxComputeInvocationsPerWorkgroup, maxStorageBufferBindingSize } = device.limits;
  const isHighEnd = maxComputeInvocationsPerWorkgroup >= 1024 && maxStorageBufferBindingSize >= 128 * 1024 * 1024;
  const isLowEnd = maxComputeInvocationsPerWorkgroup < 256 || maxStorageBufferBindingSize < 32 * 1024 * 1024;

  if (isHighEnd) {
    return {
      rating: 'high',
      recommendedSettings: { workgroupSize: [16, 16], maxBounces: 5, useAO: true }
    };
  } else if (isLowEnd) {
    return {
      rating: 'low',
      recommendedSettings: { workgroupSize: [4, 4], maxBounces: 2, useAO: false }
    };
  } else {
    return {
      rating: 'medium',
      recommendedSettings: { workgroupSize: [8, 8], maxBounces: 3, useAO: true }
    };
  }
}