/**
 * Enhanced shader loading utility with caching, retries, and error handling
 */

// Type for shader loader options
interface ShaderLoaderOptions {
  maxRetries?: number;
  retryDelay?: number;
  forceRefresh?: boolean;
  timeout?: number;
}

// Shader cache to avoid redundant network requests
class ShaderCache {
  private static instance: ShaderCache;
  private cache: Map<string, string> = new Map();
  private inProgress: Map<string, Promise<string>> = new Map();
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): ShaderCache {
    if (!ShaderCache.instance) {
      ShaderCache.instance = new ShaderCache();
    }
    return ShaderCache.instance;
  }
  
  /**
   * Load a shader with built-in caching
   */
  public async loadShader(path: string, options: ShaderLoaderOptions = {}): Promise<string> {
    const { 
      maxRetries = 3, 
      retryDelay = 1000, 
      forceRefresh = false,
      timeout = 10000
    } = options;
    
    // Return cached version if available and refresh not forced
    if (!forceRefresh && this.cache.has(path)) {
      return this.cache.get(path)!;
    }
    
    // If a load is already in progress for this path, return that promise
    if (this.inProgress.has(path)) {
      return this.inProgress.get(path)!;
    }
    
    // Start a new load operation with retry logic
    const loadPromise = this.loadWithRetry(path, maxRetries, retryDelay, timeout);
    this.inProgress.set(path, loadPromise);
    
    try {
      const shaderText = await loadPromise;
      this.cache.set(path, shaderText);
      return shaderText;
    } finally {
      // Remove from in-progress map regardless of success/failure
      this.inProgress.delete(path);
    }
  }
  
  /**
   * Clear the shader cache
   */
  public clearCache(path?: string): void {
    if (path) {
      this.cache.delete(path);
    } else {
      this.cache.clear();
    }
  }
  
  /**
   * Implementation of retry logic for loading shaders
   */
  private async loadWithRetry(
    path: string, 
    maxRetries: number, 
    retryDelay: number,
    timeout: number
  ): Promise<string> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Create an AbortController for timeout handling
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
          // Attempt to fetch the shader
          const response = await fetch(path, { 
            cache: 'no-cache',
            headers: { 'pragma': 'no-cache', 'cache-control': 'no-cache' },
            signal: controller.signal
          });
          
          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
          }
          
          // Check for empty or partial responses
          const text = await response.text();
          if (!text || text.length === 0) {
            throw new Error('Empty shader file received');
          }
          
          // Basic validation - check for wgsl syntax elements
          if (path.endsWith('.wgsl') && 
             (!text.includes('@compute') && !text.includes('@vertex') && !text.includes('@fragment'))) {
            throw new Error('Invalid WGSL shader: missing required entry point');
          }
          
          return text;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`Shader load attempt ${attempt + 1}/${maxRetries + 1} failed: ${lastError.message}`);
        
        // If this was our last retry, throw the error
        if (attempt === maxRetries) {
          break;
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    // If we get here, we've exhausted all retries
    throw new Error(`Failed to load shader after ${maxRetries + 1} attempts: ${lastError?.message}`);
  }
}

/**
 * Helper to load shader text with caching and error handling
 */
export async function loadShaderFile(
  path: string, 
  options?: ShaderLoaderOptions
): Promise<string> {
  return await ShaderCache.getInstance().loadShader(path, options);
}

/**
 * Preload multiple shaders in parallel
 */
export async function preloadShaders(
  paths: string[],
  options?: ShaderLoaderOptions
): Promise<void> {
  const loadPromises = paths.map(path => 
    ShaderCache.getInstance().loadShader(path, options)
      .catch(error => {
        console.error(`Failed to preload shader ${path}:`, error);
        // We don't rethrow to allow other shaders to load
      })
  );
  
  await Promise.all(loadPromises);
}

/**
 * Clear shader cache
 */
export function clearShaderCache(path?: string): void {
  ShaderCache.getInstance().clearCache(path);
}