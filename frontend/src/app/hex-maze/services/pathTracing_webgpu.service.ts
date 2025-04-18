/// <reference types="@webgpu/types" />

/**
 * pathTracing_webgpu.service.ts
 *
 * This service implements a WebGPU-based path tracer for Three.js scenes.
 */


import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { loadShaderFile } from './shaders/shader-loader';

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
  private accumulationTexture: GPUTexture | null = null;
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

  
  /**
   * Initializes the path tracer with a WebGPU device, context, and pipelines.
   */
  async initialize(container: HTMLElement): Promise<void> {
    console.log('Initializing WebGPU path tracer');
    
    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.appendChild(this.canvas);
    
    // Set initial size
    this.updateCanvasSize();
    
    // Setup resize observer
    const resizeObserver = new ResizeObserver(() => {
      this.updateCanvasSize();
      this.resetRendering();
    });
    resizeObserver.observe(container);
    
    // Check WebGPU support
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser.');
    }
    
    // Request adapter
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });
    
    if (!adapter) {
      throw new Error('Failed to get GPU adapter.');
    }
    
    console.log('WebGPU adapter obtained:', adapter.limits);
    
    // Request device
    this.device = await adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize
      }
    });
    
    // Configure context
    this.context = this.canvas.getContext('webgpu');
    if (!this.device || !this.context) {
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
      this.pathTracingShaderText = await loadShaderFile('./src/app/hex-maze/services/shaders/pathTracing.wgsl');
      this.displayShaderText = await loadShaderFile('./src/app/hex-maze/services/shaders/display.wgsl');
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

    // Create compute pipeline
    this.computePipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: computeShaderModule,
        entryPoint: 'main'
      }
    });
    
    // Create render pipeline with the correct format
    this.renderPipeline = await this.device.createRenderPipelineAsync({
      layout: 'auto',
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
    
    // Create initial bind groups
    this.createBindGroups();
    
    // Set quality
    this.setQuality(this.quality);
    
    console.log('WebGPU Path Tracer initialized successfully.');
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
   * Updates the canvas dimensions to match the container.
   */
  private updateCanvasSize(): void {
    if (!this.canvas) return;
    
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(this.canvas.clientWidth * dpr);
    const height = Math.floor(this.canvas.clientHeight * dpr);
    
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.aspectRatio = width / height;
      
      this.canvas.width = width;
      this.canvas.height = height;
      
      if (this.device) {
        this.createTextures();
        this.createBindGroups();
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
    this.accumulationTexture?.destroy();
    this.outputTexture?.destroy();
    
    // Create accumulation texture (32-bit float for HDR)
    this.accumulationTexture = this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
    });
    
    // Create output texture (8-bit for display)
    this.outputTexture = this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
  }

  /**
   * Creates the bind groups for the compute and render pipelines.
   */
  
  // Replace the ng seGroups method with this fixed version
private createBindGroups(): void {
  if (!this.device || !this.uniformBuffer || !this.computePipeline || !this.renderPipeline ||
      !this.accumulationTexture || !this.outputTexture) {
    console.warn('Cannot create bind groups: required resources not initialized.');
    return;
  }
  
  // Create sampler for rendering
  const sampler = this.device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear'
  });
  
  // Create entries for compute bind group
  const computeEntries: GPUBindGroupEntry[] = [
      {
        binding: 0,
        resource: { buffer: this.uniformBuffer }
      },
      {
        binding: 1,
        resource: this.accumulationTexture.createView()
      },
      {
        binding: 2,
        resource: this.outputTexture.createView()
      }
    ];
    
    // Add geometry buffers if they exist
    if (this.vertexBuffer) {
      computeEntries.push({
        binding: 3,
        resource: { buffer: this.vertexBuffer }
      });
    }
    
    if (this.normalBuffer) {
      computeEntries.push({
        binding: 4,
        resource: { buffer: this.normalBuffer }
      });
    }
    
    if (this.materialBuffer) {
      computeEntries.push({
        binding: 5,
        resource: { buffer: this.materialBuffer }
      });
    }
    
    // Create compute bind group - use entries, not bindings
    try {
      this.computeBindGroup = this.device.createBindGroup({
        layout: this.computePipeline.getBindGroupLayout(0),
        entries: computeEntries
      });
    } catch (error) {
      console.error('Failed to create compute bind group:', error);
      return;
    }

    // Create render bind group - use entries, not bindings
    try {
      this.renderBindGroup = this.device.createBindGroup({
        layout: this.renderPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: this.outputTexture.createView()
          },
          {
            binding: 1,
            resource: sampler
          }
        ]
      });
    } catch (error) {
      console.error('Failed to create render bind group:', error);
    }
  }

  /**
   * Updates the camera parameters for the path tracer.
   */
  updateCamera(camera: THREE.Camera): void {
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
    const materials = new Float32Array(totalTriangleCount * 8);
    
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
            
            // Store material properties
            materials[materialOffset] = materialColor.r;
            materials[materialOffset + 1] = materialColor.g;
            materials[materialOffset + 2] = materialColor.b;
            materials[materialOffset + 3] = metalness;
            materials[materialOffset + 4] = roughness;
            materials[materialOffset + 5] = emissive;
            materials[materialOffset + 6] = 0; // reserved
            materials[materialOffset + 7] = 0; // reserved
            
            triangleOffset += 9;
            materialOffset += 8;
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
            
            // Store material properties
            materials[materialOffset] = materialColor.r;
            materials[materialOffset + 1] = materialColor.g;
            materials[materialOffset + 2] = materialColor.b;
            materials[materialOffset + 3] = metalness;
            materials[materialOffset + 4] = roughness;
            materials[materialOffset + 5] = emissive;
            materials[materialOffset + 6] = 0; // reserved
            materials[materialOffset + 7] = 0; // reserved
            
            triangleOffset += 9;
            materialOffset += 8;
          }
        }
      } catch (error) {
        console.error(`Error processing mesh ${meshIndex}:`, error);
      }
    });
    
    console.log(`Processed ${triangleOffset / 9} triangles`);
    
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
    this.createBindGroups();
    
    // Reset rendering since scene changed
    this.resetRendering();
    
    console.log('Path traced scene built successfully with', triangleOffset / 9, 'triangles.');
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

  /**
   * Starts the rendering loop.
   */
  startRendering(): void {
  // Cancel any existing rendering loop
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    // Reset if we've reached max samples
    if (this.sampleCount >= this.maxSamples) {
      this.resetRendering();
    }
    
    console.log('Starting path tracer rendering loop');
    
    // Define the render loop
    const renderLoop = () => {
      if (this.isDisposed) {
        this.animationFrameId = null;
        return;
      }
      
      this.render();
      
      // Continue rendering if we haven't reached max samples
      if (this.sampleCount < this.maxSamples) {
        this.animationFrameId = requestAnimationFrame(renderLoop);
      } else {
        // Animation stops when max samples reached
        this.animationFrameId = null;
        console.log(`Path tracing completed with ${this.sampleCount} samples`);
      }
    };
    
    // Start the loop
    this.animationFrameId = requestAnimationFrame(renderLoop);
  }

  /**
   * Performs a single render pass.
   */
  render(): void {
    if (!this.device || !this.context || !this.computePipeline || !this.renderPipeline ||
        !this.computeBindGroup || !this.renderBindGroup || !this.uniformBuffer) {
      console.warn('Cannot render: some WebGPU resources are not initialized');
      return;
    }
    
    try {
      // Update sample count in uniform buffer
      const sampleCountData = new Uint32Array([this.sampleCount]);
      this.device.queue.writeBuffer(this.uniformBuffer, 56, sampleCountData);
      
      // Update time value if needed
      const timeData = new Float32Array([performance.now() / 1000.0]);
      this.device.queue.writeBuffer(this.uniformBuffer, 64, timeData);
      
      // Create encoder
      const encoder = this.device.createCommandEncoder();
      
      // Compute pass for path tracing
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(this.computePipeline);
      computePass.setBindGroup(0, this.computeBindGroup);
      
      // Dispatch workgroups with ceiling division to cover all pixels
      const workgroupsX = Math.ceil(this.width / 8);
      const workgroupsY = Math.ceil(this.height / 8);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
      computePass.end();
      
      // Render pass to display result
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }]
      });
      
      renderPass.setPipeline(this.renderPipeline);
      renderPass.setBindGroup(0, this.renderBindGroup);
      renderPass.draw(3);  // Full-screen triangle
      renderPass.end();
      
      // Submit commands
      this.device.queue.submit([encoder.finish()]);
      
      // Increment sample count
      this.sampleCount++;
      
      if (this.sampleCount % 20 === 0) {
        console.log(`Path tracing: ${this.sampleCount}/${this.maxSamples} samples`);
      }
    } catch (error) {
      console.error('Error during WebGPU rendering:', error);
      
      // Cancel animation on error
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    }
  }

  /**
   * Cleans up all WebGPU resources.
   */
  dispose(): void {
    this.isDisposed = true;
    
    // Cancel rendering loop
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    // Destroy textures
    this.accumulationTexture?.destroy();
    this.outputTexture?.destroy();
    
    // Destroy buffers
    this.vertexBuffer?.destroy();
    this.normalBuffer?.destroy();
    this.materialBuffer?.destroy();
    this.uniformBuffer?.destroy();
    
    // Remove canvas
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    
    // Clear references
    this.canvas = null;
    this.device = null;
    this.context = null;
    this.renderPipeline = null;
    this.computePipeline = null;
    
    console.log('Path tracer resources disposed.');
  }
}