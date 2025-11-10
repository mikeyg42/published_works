/// <reference types="@webgpu/types" />

/**
 * pathTracing_webgpu.service.ts
 *
 * This service implements a WebGPU-based path tracer for Three.js scenes.
 */


import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { loadShaderFile } from '../../../assets/shaders/shader-loader';
import { ShaderBindings } from '../../../assets/shaders/shader-bindings';
import { initializeWebGPU, assessDevicePerformance, defaultPathTracingRequirements } from '../../../assets/shaders/webgpu-utils';

@Injectable({
  providedIn: 'root'
})
export class PathTracerService {
  private pathTracingShaderText: string = '';
  private displayShaderText: string = '';
  
  private canvas: HTMLCanvasElement | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat | null = null;
  
  // Pipeline and binding objects
  private renderPipeline: GPURenderPipeline | null = null;
  private computePipeline: GPUComputePipeline | null = null;
  private renderBindGroup: GPUBindGroup | null = null;
  private computeBindGroup: GPUBindGroup | null = null;
  
  // Buffers
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private normalBuffer: GPUBuffer | null = null;
  private materialBuffer: GPUBuffer | null = null;
  
  // Textures
  private accumulationTexture1: GPUTexture | null = null;
  private accumulationTexture2: GPUTexture | null = null;
  private outputTexture: GPUTexture | null = null;
  
  // Rendering state
  private sampleCount: number = 0;
  private quality: 'low' | 'high' = 'high';
  private maxSamples: number = 1000;
  private environmentIntensity: number = 1.0;
  
  // Canvas dimensions
  private width: number = 0;
  private height: number = 0;
  private aspectRatio: number = 1.0;
  
  // Animation
  private animationFrameId: number | null = null;
  private isDisposed: boolean = false;
  private camera: THREE.Camera | null = null;

  public errorMessage: string | null = null;
  public devicePerformance: { rating: 'low' | 'medium' | 'high'; recommendedSettings: { workgroupSize: [number, number]; maxBounces: number; useAO: boolean; }; } | null = null;
  
  // New properties
  private currentAccumulationTexture: number = 0; // 0 or 1 to track which texture is current
  private computeBindGroups: GPUBindGroup[] = [];

  // CRITICAL FIX: Store bind group layouts as class properties
  private computeBindGroupLayout: GPUBindGroupLayout | null = null;
  private renderBindGroupLayout: GPUBindGroupLayout | null = null;

  private isInitialized: boolean = false;
  private sceneReady: boolean = false;
  private buildingScene: boolean = false;

  // CRASH PREVENTION MEASURES
  private renderErrorCount: number = 0;
  private maxRenderErrors: number = 10;
  private lastRenderTime: number = 0;
  private minRenderInterval: number = 16; // Limit to ~60fps max
  private maxTextureSize: number = 2048; // Prevent excessive memory usage
  private isRenderLoopActive: boolean = false;

  /**
   * Initialize with an existing WebGPU device (shared)
   * This is the preferred initialization method to avoid multiple device conflicts
   */
  async initializeWithDevice(
    container: HTMLElement, 
    sharedDevice: GPUDevice
  ): Promise<void> {
    console.log('Initializing WebGPU path tracer with shared device');
    this.errorMessage = null;
    this.device = sharedDevice; // Use the shared device
    
    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.zIndex = '1000'; // Make sure it's on top
    this.canvas.style.pointerEvents = 'none'; // Allow interactions to pass through
    this.canvas.id = 'webgpu-path-tracer-canvas';
    container.appendChild(this.canvas);

    console.log('WebGPU canvas created and added to container');
    
    // Force layout and wait for canvas dimensions
    console.log('Waiting for canvas to be properly sized...');
    await new Promise<void>(resolve => {
      const checkSize = () => {
        if (this.canvas!.clientWidth > 0 && this.canvas!.clientHeight > 0) {
          console.log(`Canvas sized: ${this.canvas!.clientWidth}x${this.canvas!.clientHeight}`);
          resolve();
        } else {
          requestAnimationFrame(checkSize);
        }
      };
      checkSize();
    });
    
    // Set initial size
    this.updateCanvasSize();
    
    // Setup resize observer - IMPORTANT: Keep this!
    const resizeObserver = new ResizeObserver(() => {
      this.updateCanvasSize();
      this.resetRendering();
    });
    resizeObserver.observe(container);
    
    // Configure context with shared device
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('Failed to create WebGPU context.');
    }
    
    // Get preferred format
    this.format = navigator.gpu.getPreferredCanvasFormat();
    console.log('Using canvas format:', this.format);
    
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied'
    });

    // Add device lost and error handling
    this.setupDeviceErrorHandling();
    
    // Create uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: 256, // Must be a multiple of 16
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    
    // Create textures for accumulation and output
    this.createTextures();

    // Load shader code
    try {
      // These paths should match your assets configuration in angular.json
      this.pathTracingShaderText = await loadShaderFile('/assets/shaders/pathTracing.wgsl');
      this.displayShaderText = await loadShaderFile('/assets/shaders/display.wgsl');
      console.log('Shaders loaded successfully');
    } catch (error) {
      console.error('Failed to load shaders:', error);
      throw new Error('Failed to load shaders');
    }
    
    // Then use the loaded text for your shader modules
    const computeShaderModule = this.device.createShaderModule({
      code: this.pathTracingShaderText
    });
    
    const renderShaderModule = this.device.createShaderModule({
      code: this.displayShaderText
    });

    // CRITICAL FIX: Create explicit bind group layouts instead of 'auto'
    this.computeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: {
          access: 'write-only',
          format: 'rgba32float'
        }},
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: {
          access: 'write-only',
          format: 'rgba8unorm'
        }},
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }
      ]
    });

    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
      ]
    });

    // Create explicit pipeline layouts
    const computePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.computeBindGroupLayout]
    });
    const renderPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.renderBindGroupLayout]
    });

    // Create compute pipeline with explicit layout
    this.computePipeline = await this.device.createComputePipelineAsync({
      layout: computePipelineLayout,
      compute: {
        module: computeShaderModule,
        entryPoint: 'main'
      }
    });
    console.log('✅ Compute pipeline created with explicit layout');

    // Create render pipeline with explicit layout
    this.renderPipeline = await this.device.createRenderPipelineAsync({
      layout: renderPipelineLayout,
      vertex: {
        module: renderShaderModule,
        entryPoint: 'vertexMain',
        buffers: []
      },
      fragment: {
        module: renderShaderModule,
        entryPoint: 'fragmentMain',
        targets: [{ format: this.format }]
      },
      primitive: { topology: 'triangle-list' }
    });
    
    // Initialize default scene parameters
    this.initializeDefaultSceneParams();
    
    // DEFERRED BIND GROUP CREATION - only create if all resources are available
    this.tryCreateBindGroups();
    
    // Set quality
    this.setQuality(this.quality);
    
    console.log('WebGPU Path Tracer initialized successfully with shared device.');

    // Mark as initialized
    this.isInitialized = true;
    // Don't start render loop here - it will be started after scene is built
  }

  /**
   * Initializes the path tracer with a WebGPU device, context, and pipelines.
   */
  async initialize(container: HTMLElement): Promise<void> {
    console.warn('PathTracer.initialize() deprecated - use initializeWithDevice()');
    // Don't create a new device - wait for shared device
    throw new Error('PathTracer requires shared WebGPU device');
  }
  
  private initializeDefaultSceneParams(): void {
    if (!this.device || !this.uniformBuffer) return;
    
    const uniformData = new ArrayBuffer(256);
    const floatView = new Float32Array(uniformData);
    const uintView = new Uint32Array(uniformData);
    
    // Camera position with padding (offset 0-15)
    floatView[0] = 0;    // position.x
    floatView[1] = 10;   // position.y
    floatView[2] = 10;   // position.z
    floatView[3] = 0;    // padding
    
    // Camera direction with padding (offset 16-31)
    floatView[4] = 0;    // direction.x
    floatView[5] = -0.7; // direction.y
    floatView[6] = -0.7; // direction.z
    floatView[7] = 0;    // padding
    
    // Camera up vector with padding (offset 32-47)
    floatView[8] = 0;    // up.x
    floatView[9] = 1;    // up.y
    floatView[10] = 0;   // up.z
    floatView[11] = 0;   // padding
    
    // Camera parameters (offset 48-55)
    floatView[12] = 45;                     // fov in degrees
    floatView[13] = this.environmentIntensity; // environment intensity
    
    // Sample count and seed (offset 56-63)
    uintView[14] = 0;                      // sampleCount
    uintView[15] = Math.floor(Math.random() * 4294967295); // seed
    
    // Time and aspect ratio (offset 64-71)
    floatView[16] = performance.now() / 1000.0; // time
    floatView[17] = this.aspectRatio;          // aspectRatio
    
    // Write the entire buffer at once
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    
    console.log('Default scene parameters initialized');
  }

  /**
   * Attempts to create bind groups only if all required resources are available.
   * This is called from multiple places to handle deferred initialization.
   */
  private tryCreateBindGroups(): void {
    if (!this.device || !this.uniformBuffer || !this.computePipeline || !this.renderPipeline ||
        !this.accumulationTexture1 || !this.accumulationTexture2 || !this.outputTexture) {
      console.log('Deferring bind group creation: required resources not yet initialized.');
      return;
    }

    // Always create placeholder buffers if scene buffers don't exist yet
    if (!this.vertexBuffer) {
      console.log('Creating placeholder vertex buffer');
      this.vertexBuffer = this.createBufferWithData(
        new Float32Array([0, 0, 0]), // Single triangle placeholder
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      );
    }
    if (!this.normalBuffer) {
      console.log('Creating placeholder normal buffer');
      this.normalBuffer = this.createBufferWithData(
        new Float32Array([0, 1, 0]), // Default up normal
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      );
    }
    if (!this.materialBuffer) {
      console.log('Creating placeholder material buffer');
      this.materialBuffer = this.createBufferWithData(
        new Float32Array([0.5, 0.5, 0.5, 0.0, 0.5, 0.0]), // Default gray material
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      );
    }

    console.log('Creating bind groups - all resources available.');
    this.createBindGroups();
  }

  /**
   * Updates the canvas dimensions to match the container.
   * CRASH PREVENTION: Limits maximum texture size and prevents excessive reallocations
   */
  private updateCanvasSize(): void {
    if (!this.canvas) return;
    
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // Limit device pixel ratio
    const rawWidth = Math.floor(this.canvas.clientWidth * dpr);
    const rawHeight = Math.floor(this.canvas.clientHeight * dpr);
    
    // CRASH PREVENTION: Limit maximum size to prevent GPU memory exhaustion
    const width = Math.max(1, Math.min(this.maxTextureSize, rawWidth));
    const height = Math.max(1, Math.min(this.maxTextureSize, rawHeight));
    
    // Skip if size hasn't changed significantly to prevent excessive recreation
    if (Math.abs(width - this.width) < 2 && Math.abs(height - this.height) < 2) {
      return;
    }
    
    if (this.width !== width || this.height !== height) {
      console.log(`Canvas size changed: ${this.width}x${this.height} → ${width}x${height} (limited from ${rawWidth}x${rawHeight})`);
      this.width = width;
      this.height = height;
      this.aspectRatio = width / height;
      
      this.canvas.width = width;
      this.canvas.height = height;
      
      if (this.device && this.width > 0 && this.height > 0) {
        // Create textures first
        this.createTextures();
        
        // Then try to create bind groups (will succeed if all resources are ready)
        this.tryCreateBindGroups();
        
        // Reset rendering with new dimensions
        this.resetRendering();
      }
    }
  }

  /**
   * Creates the accumulation and output textures.
   */
  private createTextures(): void {
    if (!this.device || this.width === 0 || this.height === 0) return;
    
    // Clean up existing textures
    this.accumulationTexture1?.destroy();
    this.accumulationTexture2?.destroy();
    this.outputTexture?.destroy();
    
    // Create two accumulation textures (32-bit float for HDR)
    this.accumulationTexture1 = this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    
    this.accumulationTexture2 = this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    
    // Create output texture (8-bit for display)
    this.outputTexture = this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    
    // Reset the current texture index
    this.currentAccumulationTexture = 0;
  }

  /**
   * Creates the bind groups for the compute and render pipelines.
   * This method assumes all required resources are available.
   */
  private createBindGroups(): void {
    if (!this.device || !this.uniformBuffer || !this.computePipeline || !this.renderPipeline ||
        !this.accumulationTexture1 || !this.accumulationTexture2 || !this.outputTexture) {
      console.warn('Cannot create bind groups: required resources not initialized.');
      return;
    }

    // Create sampler for rendering and reading textures
    const sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear'
    });

    // CRITICAL FIX: Use the stored explicit bind group layout
    if (!this.computeBindGroupLayout) {
      console.error('❌ Compute bind group layout not initialized');
      return;
    }

    // Create compute bind group entries for ping-pong textures
    const computeEntries1: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer } }, // uniforms
      { binding: 1, resource: this.accumulationTexture2.createView() }, // prevAccumulationTexture
      { binding: 2, resource: this.accumulationTexture1.createView() }, // accumulationTexture (write)
      { binding: 3, resource: this.outputTexture.createView() }, // outputTexture
    ];

    const computeEntries2: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer } }, // uniforms
      { binding: 1, resource: this.accumulationTexture1.createView() }, // prevAccumulationTexture
      { binding: 2, resource: this.accumulationTexture2.createView() }, // accumulationTexture (write)
      { binding: 3, resource: this.outputTexture.createView() }, // outputTexture
    ];

    // Add vertex/normal/material buffers if they exist
    if (this.vertexBuffer) {
      computeEntries1.push({ binding: 4, resource: { buffer: this.vertexBuffer } });
      computeEntries2.push({ binding: 4, resource: { buffer: this.vertexBuffer } });
      console.log('Added vertex buffer to bind group');
    }
    if (this.normalBuffer) {
      computeEntries1.push({ binding: 5, resource: { buffer: this.normalBuffer } });
      computeEntries2.push({ binding: 5, resource: { buffer: this.normalBuffer } });
      console.log('Added normal buffer to bind group');
    }
    if (this.materialBuffer) {
      computeEntries1.push({ binding: 6, resource: { buffer: this.materialBuffer } });
      computeEntries2.push({ binding: 6, resource: { buffer: this.materialBuffer } });
      console.log('Added material buffer to bind group');
    }
    
    // Create compute bind groups using the stored explicit layout
    const computeBindGroup1 = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: computeEntries1
    });
    console.log('✅ Compute bind group 1 created with explicit layout');

    const computeBindGroup2 = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: computeEntries2
    });
    console.log('✅ Compute bind group 2 created with explicit layout');
    
    // Store both bind groups and initialize with the first one
    this.computeBindGroups = [computeBindGroup1, computeBindGroup2];
    this.computeBindGroup = this.computeBindGroups[this.currentAccumulationTexture];

    // --- Render Bind Group (Display) ---
    // CRITICAL FIX: Use stored explicit render bind group layout
    if (!this.renderBindGroupLayout) {
      console.error('❌ Render bind group layout not initialized');
      return;
    }

    const renderEntries: GPUBindGroupEntry[] = [
      { binding: 0, resource: this.outputTexture.createView() }, // outputTexture
      { binding: 1, resource: sampler }, // textureSampler
    ];

    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: renderEntries
    });
    console.log('✅ Render bind group created with explicit layout');
    
    console.log('Bind groups created successfully.');
  }

  /**
   * Updates the camera parameters for the path tracer.
   */
  updateCamera(camera: THREE.Camera): void {
    this.camera = camera;
    if (!this.device || !this.uniformBuffer) return;
    
    // Extract camera parameters
    const position = new Float32Array([
      camera.position.x, camera.position.y, camera.position.z, 0
    ]);
    
    // Create direction and up vectors
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    
    const directionArray = new Float32Array([
      direction.x, direction.y, direction.z, 0
    ]);
    
    const upArray = new Float32Array([
      up.x, up.y, up.z, 0
    ]);
    
    // Get FOV (defaults to 45 if not a perspective camera)
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
    
    // Only update fov and environmentIntensity (keep the other values)
    const fovEnvArray = new Float32Array([fov, this.environmentIntensity]);
    
    // Update uniform buffer
    this.device.queue.writeBuffer(this.uniformBuffer, 0, position);
    this.device.queue.writeBuffer(this.uniformBuffer, 16, directionArray);
    this.device.queue.writeBuffer(this.uniformBuffer, 32, upArray);
    this.device.queue.writeBuffer(this.uniformBuffer, 48, fovEnvArray); // Only 8 bytes, not 16
    
    // No need to reset here - we should let resetRendering handle that
  }

  /**
   * Resets the path tracing accumulation.
   */
  resetRendering(): void {
    this.sampleCount = 0;
    
    // Update the sample count in the uniform buffer
    if (this.device && this.uniformBuffer) {
      const sampleData = new Uint32Array([0]);
      this.device.queue.writeBuffer(this.uniformBuffer, 56, sampleData); // sampleCount at offset 56
      
      // Also update random seed
      const seedData = new Uint32Array([Math.floor(Math.random() * 4294967295)]);
      this.device.queue.writeBuffer(this.uniformBuffer, 60, seedData); // seed at offset 60
    }
    
    // Reset to using the first accumulation texture
    this.currentAccumulationTexture = 0;
    if (this.computeBindGroups.length > 0) {
      this.computeBindGroup = this.computeBindGroups[this.currentAccumulationTexture];
    }
    
    console.log('Path tracer accumulation reset.');
  }

  /**
   * Builds a path tracing scene from Three.js meshes.
   */
  async buildSceneFromMaze(params: { 
    tiles: THREE.Mesh[], 
    walls: THREE.Mesh[], 
    center: THREE.Vector3, 
    size: number, 
    floorY: number 
  }): Promise<void> {
    if (!this.device) {
      console.error('Cannot build scene: WebGPU device not initialized');
      return;
    }
    
    // Prevent concurrent scene building
    if (this.buildingScene) {
      console.log('Scene building already in progress, skipping...');
      return;
    }
    
    this.buildingScene = true;
    
    try {
      console.log('Building path traced scene from maze geometry...');
      console.log(`Tiles: ${params.tiles.length}, Walls: ${params.walls.length}`);
      
      // Collect all meshes
      const allMeshes = [...params.tiles, ...params.walls];
      
      // Skip if no meshes
      if (allMeshes.length === 0) {
        console.warn('No meshes provided to buildSceneFromMaze');
        return;
            }
      
      // Count total triangles
      let totalTriangleCount = 0;
      allMeshes.forEach(mesh => {
        if (!mesh || !mesh.geometry) return;
        
        const geometry = mesh.geometry;
        if (geometry instanceof THREE.BufferGeometry) {
          const index = geometry.index;
          const position = geometry.attributes['position'];
          
          if (position && position.count > 0) {
            if (index) {
              totalTriangleCount += index.count / 3;
            } else {
              totalTriangleCount += position.count / 3;
            }
          }
        }
      });
      
      console.log(`Total triangles: ${totalTriangleCount}`);
      
      if (totalTriangleCount === 0) {
        console.warn('No triangles found in provided meshes');
        return;
      }
      
      // Create arrays for geometry data
      const vertices = new Float32Array(totalTriangleCount * 9);
      const normals = new Float32Array(totalTriangleCount * 9);
      const materials = new Float32Array(totalTriangleCount * 6); // Match shader VALUES_PER_MATERIAL = 6
      
      // Process all meshes
      let triangleOffset = 0;
      let materialOffset = 0;
      
      const tempMatrix = new THREE.Matrix4();
      const tempVec3 = new THREE.Vector3();
      const tempNormal = new THREE.Vector3();
      
      allMeshes.forEach((mesh, meshIndex) => {
        if (!mesh || !mesh.geometry) return;
        
        const geometry = mesh.geometry;
        if (!(geometry instanceof THREE.BufferGeometry)) return;
        
        const position = geometry.attributes['position'];
        const normal = geometry.attributes['normal'];
        const index = geometry.index;
        
        if (!position) return;
        
        // Get mesh transform
        tempMatrix.copy(mesh.matrixWorld);
        
        // Get material properties
        let materialColor = new THREE.Color(0.8, 0.8, 0.8);
        let metalness = 0.0;
        let roughness = 0.5;
        let emissive = 0.0;
        
        if (mesh.material) {
          const material = mesh.material as THREE.MeshStandardMaterial;
          if (material.color) materialColor.copy(material.color);
          if (material.metalness !== undefined) metalness = material.metalness;
          if (material.roughness !== undefined) roughness = material.roughness;
          if (material.emissive) {
            const em = material.emissive;
            emissive = (em.r * 0.2126 + em.g * 0.7152 + em.b * 0.0722) * 
                      (material.emissiveIntensity !== undefined ? material.emissiveIntensity : 1.0);
          }
        }
        
        try {
          // Process geometry
          if (index) {
            // Indexed geometry
            for (let i = 0; i < index.count; i += 3) {
              for (let j = 0; j < 3; j++) {
                const idx = index.getX(i + j);
                
                // Get vertex and transform to world space
                tempVec3.fromBufferAttribute(position, idx);
                tempVec3.applyMatrix4(tempMatrix);
                
                vertices[triangleOffset + j * 3] = tempVec3.x;
                vertices[triangleOffset + j * 3 + 1] = tempVec3.y;
                vertices[triangleOffset + j * 3 + 2] = tempVec3.z;
                
                // Get normal and transform to world space
                if (normal) {
                  tempNormal.fromBufferAttribute(normal, idx);
                  tempNormal.transformDirection(tempMatrix);
                  tempNormal.normalize();
                  
                  normals[triangleOffset + j * 3] = tempNormal.x;
                  normals[triangleOffset + j * 3 + 1] = tempNormal.y;
                  normals[triangleOffset + j * 3 + 2] = tempNormal.z;
                } else {
                  // Default normal if none provided
                  normals[triangleOffset + j * 3] = 0;
                  normals[triangleOffset + j * 3 + 1] = 1;
                  normals[triangleOffset + j * 3 + 2] = 0;
                }
              }
              
              // Store material properties (6 values per material to match shader)
              materials[materialOffset] = materialColor.r;
              materials[materialOffset + 1] = materialColor.g;
              materials[materialOffset + 2] = materialColor.b;
              materials[materialOffset + 3] = metalness;
              materials[materialOffset + 4] = roughness;
              materials[materialOffset + 5] = emissive;

              triangleOffset += 9;
              materialOffset += 6; // Match shader VALUES_PER_MATERIAL = 6
            }
          } else {
            // Non-indexed geometry
            for (let i = 0; i < position.count; i += 3) {
              for (let j = 0; j < 3; j++) {
                // Get vertex and transform to world space
                tempVec3.fromBufferAttribute(position, i + j);
                tempVec3.applyMatrix4(tempMatrix);
                
                vertices[triangleOffset + j * 3] = tempVec3.x;
                vertices[triangleOffset + j * 3 + 1] = tempVec3.y;
                vertices[triangleOffset + j * 3 + 2] = tempVec3.z;
                
                // Get normal and transform to world space
                if (normal) {
                  tempNormal.fromBufferAttribute(normal, i + j);
                  tempNormal.transformDirection(tempMatrix);
                  tempNormal.normalize();
                  
                  normals[triangleOffset + j * 3] = tempNormal.x;
                  normals[triangleOffset + j * 3 + 1] = tempNormal.y;
                  normals[triangleOffset + j * 3 + 2] = tempNormal.z;
                } else {
                  // Default normal if none provided
                  normals[triangleOffset + j * 3] = 0;
                  normals[triangleOffset + j * 3 + 1] = 1;
                  normals[triangleOffset + j * 3 + 2] = 0;
                }
              }
              
              // Store material properties (6 values per material to match shader)
              materials[materialOffset] = materialColor.r;
              materials[materialOffset + 1] = materialColor.g;
              materials[materialOffset + 2] = materialColor.b;
              materials[materialOffset + 3] = metalness;
              materials[materialOffset + 4] = roughness;
              materials[materialOffset + 5] = emissive;

              triangleOffset += 9;
              materialOffset += 6; // Match shader VALUES_PER_MATERIAL = 6
            }
          }
        } catch (error) {
          console.error(`Error processing mesh ${meshIndex}:`, error);
        }
      });
      
      console.log(`Processed ${triangleOffset / 9} triangles`);
      
      // Mark scene as not ready while we rebuild
      this.sceneReady = false;
      
      // Clean up old buffers
      if (this.vertexBuffer) this.vertexBuffer.destroy();
      if (this.normalBuffer) this.normalBuffer.destroy();
      if (this.materialBuffer) this.materialBuffer.destroy();
      
      // Create new buffers with the processed data
      this.vertexBuffer = this.createBufferWithData(
        vertices.slice(0, triangleOffset), 
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      );
      
      this.normalBuffer = this.createBufferWithData(
        normals.slice(0, triangleOffset), 
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      );
      
      this.materialBuffer = this.createBufferWithData(
        materials.slice(0, materialOffset), 
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      );
      
      // Update bind groups with new buffers
      // Clear old bind groups to force recreation
      this.computeBindGroups = [];
      this.computeBindGroup = null;
      this.renderBindGroup = null;
      
      // Now recreate bind groups with the new buffers
      this.tryCreateBindGroups();
      
      // Reset rendering since scene changed
      this.resetRendering();
      
      // CRITICAL FIX: Validate scene before marking ready
      const triangleCount = triangleOffset / 9;
      console.log('🔍 Validating scene build...');
      console.log(`- Triangles processed: ${triangleCount}`);
      console.log(`- Vertex buffer size: ${this.vertexBuffer?.size || 0} bytes`);
      console.log(`- Normal buffer size: ${this.normalBuffer?.size || 0} bytes`);
      console.log(`- Material buffer size: ${this.materialBuffer?.size || 0} bytes`);

      // Only mark as ready if we actually have geometry
      if (triangleCount > 0 && this.vertexBuffer && this.normalBuffer && this.materialBuffer) {
        // Mark scene as ready for rendering
        this.sceneReady = true;
        console.log('✅ Scene validated and ready for path tracing');

        // Now start the render loop
        this.startRenderLoop();
        console.log('🚀 Path tracer render loop started');
      } else {
        console.error('❌ Scene validation failed - no geometry or missing buffers');
        console.error(`Triangle count: ${triangleCount}, Buffers: vertex=${!!this.vertexBuffer}, normal=${!!this.normalBuffer}, material=${!!this.materialBuffer}`);
        this.sceneReady = false;
      }
      
    } catch (error) {
      console.error('Error building path traced scene:', error);
    } finally {
      // Reset the building flag
      this.buildingScene = false;
    }
  }

  /**
   * Helper to create a GPU buffer with initial data.
   */
  private createBufferWithData(data: Float32Array | Uint32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    if (!this.device || data.length === 0) {
      console.warn('Cannot create buffer: device is null or data is empty');
      throw new Error('Cannot create buffer: device is null or data is empty');
    }

    try {
      // Calculate aligned buffer size (must be a multiple of 4 bytes)
      const alignedSize = Math.ceil(data.byteLength / 4) * 4;

      // NOTE: Buffer validation against device limits was considered but omitted
      // REASONING:
      // - Device limits are often theoretical maximums, not practical constraints
      // - Real-world limits depend on available memory and driver state (dynamic)
      // - Hard validation could block legitimate large maze scenes that would work fine
      // - WebGPU will naturally fail gracefully with clear error messages if limits exceeded
      // - Existing crash prevention (renderErrorCount, etc.) handles GPU failures appropriately
      // FUTURE CONSIDERATION: If buffer-related crashes occur in production, consider:
      //   1. Configurable buffer size limits (like existing maxTextureSize: 2048)
      //   2. Graceful degradation (scene simplification) rather than hard failures
      //   3. Dynamic memory pressure monitoring instead of static limit validation
      
      // Create the buffer with enough size to hold the data
      const buffer = this.device.createBuffer({
        size: alignedSize,
        usage: usage,
        mappedAtCreation: true
      });
      
      // Copy data to the buffer based on its type
      if (data instanceof Float32Array) {
        new Float32Array(buffer.getMappedRange()).set(data);
      } else {
        new Uint32Array(buffer.getMappedRange()).set(data);
      }
      
      // Unmap to make the buffer available for GPU use
      buffer.unmap();
      
      return buffer;
    } catch (error) {
      console.error('Error creating WebGPU buffer:', error);
      throw error;
    }
  }

  /**
   * Sets the quality level of the path tracer.
   */
  setQuality(quality: 'low' | 'high'): void {
    this.quality = quality;
    
    if (quality === 'low') {
      this.maxSamples = 100;
      console.log('Path tracer quality set to low (max 100 samples).');
    } else {
      this.maxSamples = 1000;
      console.log('Path tracer quality set to high (max 1000 samples).');
    }
    
    this.resetRendering();
  }

  /**
   * Updates the environment intensity.
   */
  updateEnvironmentIntensity(intensity: number): void {
    this.environmentIntensity = intensity;
    
    // Update uniform buffer
    if (this.device && this.uniformBuffer) {
      const data = new Float32Array([
        this.environmentIntensity
      ]);
      
      this.device.queue.writeBuffer(this.uniformBuffer, 52, data);
    }
    
    this.resetRendering();
    console.log('Environment intensity updated to', intensity);
  }

  /**
   * Returns the current progress of path tracing (0-1)
   */
  getProgress(): number {
    if (this.maxSamples <= 0) return 1.0;
    return Math.min(this.sampleCount / this.maxSamples, 1.0);
  }

  /**
   * Sets the size of the path tracer
   */
  setSize(width: number, height: number): void {
    this.updateCanvasSize();
    // Force reset the rendering after size change
    this.resetRendering();
  }

  // Add a new method to start the render loop
  public startRenderLoop() {
    if (!this.isInitialized) {
      console.warn('Path tracing not initialized yet');
      return;
    }

    if (!this.sceneReady) {
      console.warn('Cannot start render loop: scene not ready - call buildSceneFromMaze first');
      return;
    }

    if (this.animationFrameId) {
      console.warn('Render loop already running');
      return;
    }

    this.renderLoop();
  }

  private renderLoop() {
    if (!this.isInitialized || this.isDisposed) return;

    // CRASH PREVENTION: Limit render frequency to prevent excessive resource usage
    const now = performance.now();
    if (now - this.lastRenderTime < this.minRenderInterval) {
      this.animationFrameId = requestAnimationFrame(() => this.renderLoop());
      return;
    }
    this.lastRenderTime = now;

    // CRASH PREVENTION: Check if we're already in a render loop to prevent recursion
    if (this.isRenderLoopActive) {
      console.warn('Render loop already active, skipping frame');
      this.animationFrameId = requestAnimationFrame(() => this.renderLoop());
      return;
    }

    this.isRenderLoopActive = true;
    
    try {
      // Update camera if needed
      if (this.camera) {
        this.updateCamera(this.camera);
      }

      // Render the scene
      this.render();
      
      // Reset error count on successful render
      this.renderErrorCount = 0;
      
    } catch (error) {
      console.error('Error in render loop:', error);
      this.renderErrorCount++;
      
      // CRASH PREVENTION: Stop render loop if too many errors occur
      if (this.renderErrorCount >= this.maxRenderErrors) {
        console.error(`Too many render errors (${this.renderErrorCount}), stopping render loop to prevent crash`);
        this.stopRenderLoop();
        return;
      }
    } finally {
      this.isRenderLoopActive = false;
    }
    
    // Schedule next frame only if not disposed and not stopped
    if (!this.isDisposed && this.animationFrameId !== null) {
      this.animationFrameId = requestAnimationFrame(() => this.renderLoop());
    }
  }

  /**
   * Stop the render loop
   * CRASH PREVENTION: Ensures render loop is properly stopped
   */
  public stopRenderLoop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
      console.log('Path tracer render loop stopped.');
    }
    
    // Reset render loop flags
    this.isRenderLoopActive = false;
    this.renderErrorCount = 0;
  }

  /**
   * Performs a single render pass.
   */
  render(): void {
    // CRASH PREVENTION: Early exit conditions
    // CRITICAL DEBUG: Log why render is skipped
    if (!this.sceneReady || this.isDisposed) {
      if (!this.sceneReady) {
        console.log('🚫 Render skipped: Scene not ready - path tracer waiting for geometry');
      }
      if (this.isDisposed) {
        console.log('🚫 Render skipped: Path tracer disposed');
      }
      return;
    }
    
    // CRASH PREVENTION: Limit total samples to prevent infinite rendering
    if (this.sampleCount >= this.maxSamples) {
      return;
    }
    
    // Debug: log that we're attempting to render
    if (this.sampleCount === 0 || this.sampleCount % 100 === 0) {
      console.log(`Path tracer render: sceneReady=${this.sceneReady}, sampleCount=${this.sampleCount}, hasBindGroups=${!!this.computeBindGroup && !!this.renderBindGroup}`);
    }
    
    if (!this.device || !this.context || !this.computePipeline || !this.renderPipeline ||
        !this.computeBindGroup || !this.renderBindGroup || !this.uniformBuffer) {
      // Add debugging to see what's missing
      if (!this.device) console.warn('Path tracer render: device is null');
      if (!this.context) console.warn('Path tracer render: context is null');
      if (!this.computePipeline) console.warn('Path tracer render: computePipeline is null');
      if (!this.renderPipeline) console.warn('Path tracer render: renderPipeline is null');
      if (!this.computeBindGroup) console.warn('Path tracer render: computeBindGroup is null');
      if (!this.renderBindGroup) console.warn('Path tracer render: renderBindGroup is null');
      if (!this.uniformBuffer) console.warn('Path tracer render: uniformBuffer is null');

      // Try to recreate bind groups if they're missing
      if (!this.computeBindGroup || !this.renderBindGroup) {
        console.log('Attempting to recreate missing bind groups...');
        this.tryCreateBindGroups();
      }

      return;
    }
    
    // Update time in uniform buffer
    const timeData = new Float32Array([performance.now() / 1000.0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 64, timeData);
    
    // Increment sample count
    this.sampleCount++;
    
    // Update sample count in uniform buffer
    const sampleData = new Uint32Array([this.sampleCount]);
    this.device.queue.writeBuffer(this.uniformBuffer, 56, sampleData);
    
    try {
      // Debug: confirm we're actually executing render commands
      if (this.sampleCount === 0) {
        console.log('🎯 EXECUTING WebGPU render commands - first sample!');
      }

      // Create command encoder
      const commandEncoder = this.device.createCommandEncoder();
      
      // Dispatch compute shader
      const computePass = commandEncoder.beginComputePass();
      computePass.setPipeline(this.computePipeline);
      
      // Use the current bind group (will be swapped after rendering)
      computePass.setBindGroup(0, this.computeBindGroup);
      
      // Calculate dispatch size based on canvas dimensions
      const workgroupSize = this.devicePerformance?.recommendedSettings?.workgroupSize || [8, 8];
      const dispatchWidth = Math.ceil(this.width / workgroupSize[0]);
      const dispatchHeight = Math.ceil(this.height / workgroupSize[1]);
      
      // CRASH PREVENTION: Limit dispatch size to prevent GPU overload
      const maxDispatchSize = 1024;
      if (dispatchWidth > maxDispatchSize || dispatchHeight > maxDispatchSize) {
        console.warn(`Dispatch size too large: ${dispatchWidth}x${dispatchHeight}, limiting to ${maxDispatchSize}`);
        throw new Error('Dispatch size exceeds safe limits');
      }
      
      computePass.dispatchWorkgroups(dispatchWidth, dispatchHeight, 1);
      computePass.end();
      
      // CRASH PREVENTION: Check context before getting current texture
      if (!this.context) {
        throw new Error('WebGPU context lost during render');
      }
      
      // Render output texture to canvas
      const currentTexture = this.context.getCurrentTexture();
      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: currentTexture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }
        }]
      });
      renderPass.setPipeline(this.renderPipeline);
      renderPass.setBindGroup(0, this.renderBindGroup);
      renderPass.draw(3, 1, 0, 0); // Render full-screen triangles with 3 vertices, matches vertexMain
      renderPass.end();
      
      // Submit command buffer
      this.device.queue.submit([commandEncoder.finish()]);
      
      // Swap accumulation textures for next frame
      this.currentAccumulationTexture = 1 - this.currentAccumulationTexture; // Toggle between 0 and 1
      if (this.computeBindGroups.length > this.currentAccumulationTexture) {
        this.computeBindGroup = this.computeBindGroups[this.currentAccumulationTexture];
      }
      
    } catch (error) {
      console.error('Error during WebGPU render:', error);
      throw error; // Re-throw to be handled by render loop
    }
  }

  /**
   * Cleans up all WebGPU resources.
   * CRASH PREVENTION: Ensures proper cleanup to prevent memory leaks
   */
  /**
   * Setup device error and lost handling
   */
  private setupDeviceErrorHandling(): void {
    if (!this.device) return;

    // Handle uncaptured WebGPU errors
    this.device.addEventListener('uncapturederror', (event) => {
      console.error('🚨 Uncaptured WebGPU error:', event.error);
      console.error('Error type:', event.error.constructor.name);

      // Attempt graceful recovery based on error type
      if (event.error.message.includes('device lost') || event.error.message.includes('context lost')) {
        this.handleDeviceLost();
      } else {
        // For other errors, just log and continue
        console.warn('Continuing operation despite WebGPU error');
      }
    });

    // Handle device lost events (if supported)
    if ('lost' in this.device) {
      (this.device as any).lost.then((info: any) => {
        console.error('🚨 WebGPU device lost:', info.reason, info.message);
        this.handleDeviceLost();
      });
    }
  }

  /**
   * Handle WebGPU device lost scenarios
   */
  private handleDeviceLost(): void {
    console.log('🔄 Attempting to recover from device lost...');

    // Stop current rendering
    this.isDisposed = true;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Clear all GPU resources
    this.finalizeDispose();

    // Note: In a production app, you might want to reinitialize here
    // For now, just notify the user that a refresh may be needed
    console.warn('⚠️ WebGPU device lost - page refresh may be required');
  }

  dispose(): void {
    if (this.isDisposed) {
      return; // Already disposed
    }
    
    console.log('Disposing path tracer resources...');
    this.isDisposed = true;
    
    // Stop render loop first
    this.stopRenderLoop();
    
    // Wait for any active render loop to finish
    if (this.isRenderLoopActive) {
      console.log('Waiting for render loop to finish...');
      // Give it a moment to finish
      setTimeout(() => this.finalizeDispose(), 100);
      return;
    }
    
    this.finalizeDispose();
  }
  
  private finalizeDispose(): void {
    try {
      // Destroy textures
      this.accumulationTexture1?.destroy();
      this.accumulationTexture2?.destroy();
      this.outputTexture?.destroy();
      
      // Destroy buffers
      this.vertexBuffer?.destroy();
      this.normalBuffer?.destroy();
      this.materialBuffer?.destroy();
      this.uniformBuffer?.destroy();

      // Clear bind group layouts and pipelines
      // Note: WebGPU doesn't require explicit destruction of layouts/pipelines,
      // but clearing references helps with garbage collection
      this.computeBindGroupLayout = null;
      this.renderBindGroupLayout = null;
      this.computePipeline = null;
      this.renderPipeline = null;

      // Clear bind group arrays and references
      this.computeBindGroups = [];
      this.computeBindGroup = null;
      this.renderBindGroup = null;

      // Remove canvas
      if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
      
      // Clear references
      this.canvas = null;
      this.device = null;
      this.context = null;
      this.format = null;
      this.renderPipeline = null;
      this.computePipeline = null;
      this.renderBindGroup = null;
      this.computeBindGroup = null;
      this.computeBindGroups = [];
      this.camera = null;
      
      // Reset state
      this.isInitialized = false;
      this.sceneReady = false;
      this.buildingScene = false;
      this.isRenderLoopActive = false;
      this.sampleCount = 0;
      this.renderErrorCount = 0;
      
      console.log('Path tracer resources disposed successfully.');
    } catch (error) {
      console.error('Error during path tracer disposal:', error);
    }
  }
}