import { Injectable, NgZone, Inject } from '@angular/core';
import * as THREE from 'three';
import { VonGridService } from './von-grid.service';
import { PathMap, PathCell } from './maze-generator.service';
import { ProcessedConnComponent, createInterpolatedStyles } from './maze-solver.service';
import { loadTextureSet, getMaterial } from '../../../assets/material_textures/loadingTextures';
import { PathTracerService } from './pathTracing_webgpu.service';
import { AnimationState, AnimationHandler, IAnimationManager } from './animation-interfaces';
import { CameraAnimator } from './camera-animator';
import { LightingAnimator } from './lighting-animator';
import { AnimationManager } from './animation-manager';
import { PathAnimator } from './path-animator';
import { VG } from 'src/assets/js/hex-grid';
import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
// Expose THREE on window (for legacy compatibility)
declare global {
  interface Window { 
    THREE: typeof THREE; 
    vg: VG;
    gc?: () => void;
  }
}
if (typeof window !== 'undefined') { window.THREE = THREE; }

/**
 * MazeSceneManager - Handles 3D rendering and animation of mazes
 * 
 * This consolidated class is responsible for:
 * 1. WebGPU-based rendering
 * 2. Creating and managing maze geometry
 * 3. Coordinating lighting and camera animations
 * 4. Path tracing for realistic rendering
 */
@Injectable({
  providedIn: 'root'
})
export class MazeSceneManager {
  // Core THREE.js components
  private renderer: InstanceType<typeof WebGPURenderer> | null = null; 
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  // Used for temporary storage of the scene manager returned by vonGridService.createScene
  private sceneManager: any;

  // von‑grid components
  private hexGrid: any;
  private board: any;

  // Animation and state tracking
  private pathMap: PathMap | null = null;
  private animationFrameId: number | null = null;
  private animationQueue: any;
  private animationState: AnimationState = AnimationState.IDLE;
  private animationSpeed: number = 1.0;

  // Debug and performance monitoring
  private debug: boolean = false;
  private frameStats = {
    framesRendered: 0,
    lastSecond: 0,
    fps: 0
  };
  private lastReportedFps: number = 0;

  // Storage for meshes created for paths
  private pathMeshes: Map<string, THREE.Object3D> = new Map();

  // Container and resize
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Renderer type flag
  private usingWebGPU: boolean = false;
  private gpuDevice: any = null;

  private initialized: boolean = false;

  // Hex/coordinate mapping
  private hexDirections: { q: number, r: number, s: number }[] = [
    { q: 1, r: -1, s: 0 },
    { q: 1, r: 0, s: -1 },
    { q: 0, r: 1, s: -1 },
    { q: -1, r: 1, s: 0 },
    { q: -1, r: 0, s: 1 },
    { q: 0, r: -1, s: 1 }
  ];
  private linearToAxialArray: { q: number, r: number }[] = [];

  // Intro animation properties
  private introAnimationInProgress: boolean = false;
  private introDuration: number = 5000;
  private sunLight: THREE.DirectionalLight | null = null;

  // Animation system components
  private animationManager: AnimationManager = new AnimationManager();
  private cameraAnimator: CameraAnimator | null = null;
  private lightingAnimator: LightingAnimator | null = null;
  private pathAnimator: PathAnimator | null = null;

  // Scene organization: groups for tiles, walls, paths, lights, effects
  private sceneGroups: {
    tiles: THREE.Group;
    walls: THREE.Group;
    paths: THREE.Group;
    lights: THREE.Group;
    effects: THREE.Group;
  } = {
    tiles: new THREE.Group(),
    walls: new THREE.Group(),
    paths: new THREE.Group(),
    lights: new THREE.Group(),
    effects: new THREE.Group()
  };

  // Material settings
  private bronzeMaterial: THREE.Material | null = null;
  private carbonFiberMaterial: THREE.Material | null = null;
  
  // Use path tracer for WebGPU rendering
  private pathTracer: PathTracerService | null = null;
  private usePathTracing: boolean = true;

  constructor(
    private ngZone: NgZone,
    private vonGridService: VonGridService,
    @Inject(PathTracerService) private PathTracerService: PathTracerService
  ) {
    this.pathTracer = PathTracerService;
  }

  /**
   * Initialize the maze animator with a container element
   */
  async initialize(container: HTMLElement): Promise<boolean> {
    try {
      console.log('Initializing MazeSceneManager...');
      this.container = container;
      
      // Step 1: Load required scripts
      if (!await this.loadVonGridScript()) {
        console.error('Failed to load von-grid script');
        return false;
      }
      
      // Step 2: Create renderer and scene (this creates the WebGPU device)
      if (!await this.setupRendererAndScene(container)) {
        console.error('Failed to setup renderer and scene');
        return false;
      }
      
      // Step 3: Initialize path tracer with shared device
      if (this.pathTracer && this.gpuDevice) {
        await this.pathTracer.initializeWithDevice(container, this.gpuDevice);
        console.log('Path tracer initialized with shared WebGPU device');
      } else if (this.pathTracer) {
        console.error('No WebGPU device available for path tracer');
        return false;
      }
      
      // Step 4: Continue with rest of initialization
      await this.initializeBasicComponents();
      await this.loadMaterials();
      this.setupResizeObserver();
      this.initializeAnimationSystem();
      await this.startAnimationLoop();
      
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('Critical error during MazeSceneManager initialization:', error);
      return false;
    }
  }

  /**
   * Extract WebGPU device from the renderer for sharing
   */
  private getWebGPUDevice(): GPUDevice | null {
    if (this.renderer && this.usingWebGPU) {
      // Access the internal WebGPU device from the renderer
      // The WebGPURenderer stores the device internally
      const webgpuRenderer = this.renderer as any;
      
      // Try different possible property names where the device might be stored
      if (webgpuRenderer._device) {
        return webgpuRenderer._device;
      }
      if (webgpuRenderer.device) {
        return webgpuRenderer.device;
      }
      if (webgpuRenderer.backend && webgpuRenderer.backend.device) {
        return webgpuRenderer.backend.device;
      }
      if (webgpuRenderer.getDevice && typeof webgpuRenderer.getDevice === 'function') {
        return webgpuRenderer.getDevice();
      }
      
      // Try to access through the context
      if (webgpuRenderer._context && webgpuRenderer._context.device) {
        return webgpuRenderer._context.device;
      }
      
      // Try to access through parameters
      if (webgpuRenderer.parameters && webgpuRenderer.parameters.device) {
        return webgpuRenderer.parameters.device;
      }
      
      // As a last resort, check if we stored it during creation
      if (this.gpuDevice) {
        return this.gpuDevice;
      }
      
      console.warn('Could not find WebGPU device in renderer structure');
    }
    return null;
  }

  private async loadVonGridScript(): Promise<boolean> {
    console.log('Loading von‑grid script');
    return await this.vonGridService.loadScripts();
  }

  private async setupRendererAndScene(container: HTMLElement): Promise<boolean> {
    // Only use WebGPU, no WebGL fallback
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      console.error('WebGPU not supported in this browser');
      return false;
    }
    
    console.log('WebGPU supported, setting up renderer');
    
    // Create our own WebGPU device first
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.error('No WebGPU adapter available');
        return false;
      }
      
      this.gpuDevice = await adapter.requestDevice();
      console.log('Created WebGPU device:', this.gpuDevice);
    } catch (error) {
      console.error('Failed to create WebGPU device:', error);
      return false;
    }
    
    const sceneConfig = {
      element: container,
      alpha: true,
      antialias: true,
      clearColor: 0x0a0a12,
      fog: new THREE.FogExp2(0x0a0a12, 0.002),
      light: new THREE.DirectionalLight(0xccccff, 0.3),
      cameraType: 'PerspectiveCamera',
      cameraPosition: new THREE.Vector3(0, 150, 150),
      width: container.clientWidth,
      height: container.clientHeight,
      enableShadows: true,
      preferWebGPU: true, // Force WebGPU
      device: this.gpuDevice // Pass our device to the renderer
    };
    
    try {
      // Create scene with vonGridService
      const sceneResult = this.vonGridService.createScene(sceneConfig, {
        fov: 45,
        near: 1,
        far: 2000
      });
      
      // Extract scene components
      this.scene = sceneResult.container;
      this.camera = sceneResult.camera;
      this.renderer = sceneResult.renderer;
      this.usingWebGPU = true;
      
      console.log('Renderer: WebGPU with path tracing');
      
      console.log('Initializing von‑grid with loader');
      if (this.renderer) {
        this.vonGridService.initLoader(this.renderer);
      }
      this.initializeSceneGroups();
      this.setupLighting();
      this.configureShadows();
      return true;
    } catch (error) {
      console.error('Failed to set up renderer:', error);
      return false;
    }
  }

  private initializeSceneGroups(): void {
    if (!this.scene) return;
    Object.values(this.sceneGroups).forEach(group => {
      if (group && !group.parent) {
        if (this.scene) {
          this.scene.add(group);
        }
      }
    });
  }

  private setupLighting(): void {
    if (!this.scene || !this.sceneGroups) return;
    const lightsGroup = this.sceneGroups.lights;
    while (lightsGroup.children.length > 0) {
      lightsGroup.remove(lightsGroup.children[0]);
    }
    
    // Enhanced lighting for path tracing
    const ambientLight = new THREE.AmbientLight(0x222233, 0.2);
    lightsGroup.add(ambientLight);
    
    // Create a physically accurate sun light
    this.sunLight = new THREE.DirectionalLight(0xccccff, 0.3);
    this.sunLight.position.set(1, 1, 1).normalize();
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    
    // Enhanced shadow settings
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 500;
    this.sunLight.shadow.bias = -0.0001;
    
    // Add subtle hemisphere light for more natural lighting
    const hemiLight = new THREE.HemisphereLight(0xccccff, 0x080820, 0.15);
    lightsGroup.add(hemiLight);
    
    lightsGroup.add(this.sunLight);
  }

  private configureShadows(): void {
    if (!this.renderer) return;
    
    console.log('Configuring WebGPU shadow settings');
    this.renderer.shadowMap.enabled = true;
    
    if (this.sunLight) {
      this.sunLight.castShadow = true;
      this.sunLight.shadow.mapSize.width = 2048;
      this.sunLight.shadow.mapSize.height = 2048;
      
      // Enhanced shadows for WebGPU
      const shadowCamSize = 100;
      this.sunLight.shadow.camera.left = -shadowCamSize;
      this.sunLight.shadow.camera.right = shadowCamSize;
      this.sunLight.shadow.camera.top = shadowCamSize;
      this.sunLight.shadow.camera.bottom = -shadowCamSize;
      this.sunLight.shadow.bias = -0.0001;
    }
  }

  private setupResizeObserver(): void {
    if (!this.container) return;
    
    const resizeHandler = () => {
      if (!this.container) return;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      
      if (this.renderer) {
        this.renderer.setSize(width, height);
      }
      
      if (this.camera instanceof THREE.PerspectiveCamera) {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
      }
      
      // Update path tracer size
      if (this.pathTracer) {
        this.pathTracer.setSize(width, height);
      }
    };
    
    this.resizeObserver = new ResizeObserver(resizeHandler);
    this.resizeObserver.observe(this.container);
    
    // Initial size update
    resizeHandler();
  }

  private async initializeBasicComponents(): Promise<void> {
    if (this.pathMap) {
      this.hexGrid = this.vonGridService.createHexGrid({ cellSize: this.pathMap.dimensions.hexHeight / 2 });
    } else {
      this.hexGrid = this.vonGridService.createHexGrid({ cellSize: 10 });
    }
    
    this.board = this.vonGridService.createBoard(this.hexGrid, {});
    if (this.board && this.board.group && this.sceneGroups.tiles) {
      this.sceneGroups.tiles.add(this.board.group);
    }
    
    this.animationQueue = this.vonGridService.createLinkedList();
  }
  /**
   * Create / recreate board tiles using the current board and bronze material.
   * The bevel values scale automatically with the supplied cellSize.
   */
  private async generateTiles(cellSize: number): Promise<void> {
    if (!this.board) return;

    const extrudeSettings = {
      depth: 1,
      bevelEnabled: true,
      bevelSegments: 3,
      steps: 2,
      bevelSize: cellSize / 15,
      bevelThickness: cellSize / 15
    };

    await this.board.generateTilemap({
      tileScale: 0.95,
      material: this.bronzeMaterial,
      extrudeSettings
    });
  }

  /**
   * Load materials with proper error handling and fallbacks
   */
  private async loadMaterials(): Promise<void> {
    // Start timers for diagnostics
    const startTime = performance.now();
    const timeoutDuration = 10000; // 10 seconds timeout
    
    try {
      // Create promises for material loading
      const bronzePromise = this.loadMaterial('bronze', '/assets/material_textures/bronze');
      const carbonPromise = this.loadMaterial('carbon-fiber', '/assets/material_textures/carbon-fiber');
      
      // Wait for both with timeout
      await Promise.race([
        Promise.all([bronzePromise, carbonPromise]),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Material loading timed out')), timeoutDuration)
        )
      ]);
      
      // Get the loaded materials
      this.bronzeMaterial = getMaterial('bronze');
      this.carbonFiberMaterial = getMaterial('carbon-fiber');
      // Enhance materials for path tracing
      if (this.bronzeMaterial) {
        this.enhanceMaterialForPathTracing(this.bronzeMaterial);
      }
      if (this.carbonFiberMaterial) {
        this.enhanceMaterialForPathTracing(this.carbonFiberMaterial);
      }
      
      // Fallbacks if needed
      if (!this.bronzeMaterial) {
        console.warn('Creating fallback bronze material');
        this.bronzeMaterial = this.createFallbackMaterial(0xcd7f32, 0.8, 0.3);
      }
      
      if (!this.carbonFiberMaterial) {
        console.warn('Creating fallback carbon-fiber material');
        this.carbonFiberMaterial = this.createFallbackMaterial(0x222222, 0.4, 0.7);
      }
      
      const elapsed = performance.now() - startTime;
      console.log(`Materials loaded in ${elapsed.toFixed(2)}ms`);
      
    } catch (error) {
      console.error('Error loading materials:', error);
      // Create fallbacks on error
      this.bronzeMaterial = this.createFallbackMaterial(0xcd7f32, 0.8, 0.3);
      this.carbonFiberMaterial = this.createFallbackMaterial(0x222222, 0.4, 0.7);
    }
  }

  /**
   * Enhance a material for path tracing
   */
  private enhanceMaterialForPathTracing(material: THREE.Material): void {
    if (!material) return;
    
    if (material instanceof THREE.MeshStandardMaterial) {
      // Use path tracer-friendly properties for metals
      if (material.color.getHex() === 0xcd7f32) { // Bronze
        material.roughness = 0.15;  // Less roughness for better reflections
        material.metalness = 0.95;  // Very metallic
        material.envMapIntensity = 1.2; // More reflective
      }
      
      // Carbon fiber should be more matte with subtle reflections
      if (material.color.getHex() === 0x222222) { 
        material.roughness = 0.7;   // Quite rough
        material.metalness = 0.1;   // Not very metallic
        material.envMapIntensity = 0.8;
      }
    }
  }

  /**
   * Load a single material with promise
   */
  private loadMaterial(name: string, path: string): Promise<void> {
    return new Promise<void>((resolve) => {
      loadTextureSet(name, path, () => {
        console.log(`${name} textures loaded`);
        resolve();
      });
    });
  }

  /**
   * Create a fallback material when textures can't be loaded
   */
  private createFallbackMaterial(
    color: number, 
    metalness: number = 0.5, 
    roughness: number = 0.5
  ): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      flatShading: false
    });
    
    this.enhanceMaterialForPathTracing(material);
    
    return material;
  }

  // -------------------------------------------------------------------
  // Animation System Initialization
  // -------------------------------------------------------------------
  private initializeAnimationSystem(): void {
    if (!this.camera || !this.scene) return;
    
    this.cameraAnimator = new CameraAnimator(this.camera, this.animationManager.getTweenGroup('camera'));
    
    this.lightingAnimator = new LightingAnimator(
      this.scene, 
      this.sceneGroups.lights, 
      this.animationManager.getTweenGroup('lights'),
      this.pathTracer || undefined
    );
    
    this.animationManager.register('camera', this.cameraAnimator);
    this.animationManager.register('lighting', this.lightingAnimator);
    
    if (this.hexGrid) {
      const pathAnimator = this.vonGridService.createPathAnimator({});
      this.pathAnimator = new PathAnimator(
        this.scene,
        this.hexGrid,
        pathAnimator,
        this.animationQueue,
        this.animationManager.getTweenGroup('paths'),
        this.getAxialFromLinearId.bind(this),
        this.pathTracer || undefined,
        this.sceneGroups
      );
      this.animationManager.register('paths', this.pathAnimator);
    }
  }

  private startAnimationLoop(): Promise<void> {
    return new Promise<void>(resolve => {
      this.ngZone.runOutsideAngular(() => {
        let lastTime = 0;
        
        const animate = (time: number) => {
          this.animationFrameId = requestAnimationFrame(animate);
          
          const delta = lastTime ? (time - lastTime) / 1000 : 0;
          lastTime = time;
          
          try {
            this.updatePerformanceStats(time);
            
            this.animationManager.start();
            
            if (this.camera && this.pathTracer) {
              this.pathTracer.updateCamera(this.camera);
            }
          } catch (error) {
            console.error("Animation loop error:", error);
          }
        };
        
        this.animationFrameId = requestAnimationFrame(animate);
        setTimeout(resolve, 100);
      });
    });
  }

  /**
   * Updates performance statistics
   */
  private updatePerformanceStats(time: number): void {
    this.frameStats.framesRendered++;
    
    // Calculate FPS every second
    if (time > this.frameStats.lastSecond + 1000) {
      this.frameStats.fps = this.frameStats.framesRendered;
      this.frameStats.framesRendered = 0;
      this.frameStats.lastSecond = time;
      
      // Log only if significant change or debugging
      if (this.debug || Math.abs(this.frameStats.fps - this.lastReportedFps) > 5) {
        console.log(`Current FPS: ${this.frameStats.fps}`);
        this.lastReportedFps = this.frameStats.fps;
      }
      
      // Log path tracer progress
      if (this.pathTracer) {
        const progress = this.pathTracer.getProgress();
        if (this.debug || progress < 1.0) {
          console.log(`Path tracing progress: ${(progress * 100).toFixed(1)}%`);
        }
      }
    }
  }

  /**
   * Create a new maze from a path map
   */
  async createMaze(pathMap: PathMap): Promise<void> {
    if (!this.scene || !this.hexGrid || !this.board) return;
    
    this.clearMaze();
    this.pathMap = pathMap;
    
    this.createLinearIdToAxialArray(pathMap.dimensions.rows, pathMap.dimensions.cols);
    
    const cellSize = pathMap.dimensions.hexHeight / 2;
    this.hexGrid.cellSize = cellSize;
    this._updateGridDimensions();
    
    this.processPathMapEdges(pathMap);
    
    const cellsMap = new Map<number, any>();
    pathMap.cells.forEach(cell => {
      const axialCoords = this.getAxialFromLinearId(cell.linearId);
      if (!axialCoords) { 
        throw new Error(`Failed to convert linearId ${cell.linearId} to axial coordinates`); 
      }
      
      const q = axialCoords.q;
      const r = axialCoords.r;
      const s = -q - r;
      
      const hexCell = new window.vg.Cell(q, r, s);
      hexCell.h = 1;
      hexCell.walkable = cell.openPaths.length > 0;
      hexCell.userData = { linearId: cell.linearId, openPaths: cell.openPaths };
      hexCell.randomId = window.vg.LinkedList.generateID();
      
      this.hexGrid.add(hexCell);
      cellsMap.set(cell.linearId, hexCell);
    });
    
    // Ensure materials are available
    if (!this.bronzeMaterial || !this.carbonFiberMaterial) {
      await this.loadMaterials();
    }
    
    // Generate tiles with enhanced settings for path tracing
    await this.generateTiles(cellSize);

    if (this.board.tiles) {
      this.board.tiles.forEach((tile: any) => {
        if (tile.mesh) {
          tile.mesh.castShadow = true;
          tile.mesh.receiveShadow = true;
          
          // Enhanced quality for path tracing
          if (tile.mesh.geometry) {
            // Make sure normals are computed for better lighting
            tile.mesh.geometry.computeVertexNormals();
            
            // Mark material for path tracing enhancement
            if (tile.mesh.material && !tile.mesh.userData['enhancedForPathTracing']) {
              this.enhanceMaterialForPathTracing(tile.mesh.material);
              tile.mesh.userData['enhancedForPathTracing'] = true;
            }
          }
          
          // CRITICAL: Add tiles to the sceneGroups.tiles for path tracer access
          this.sceneGroups.tiles.add(tile.mesh);
        }
      });
    }
    
    this.createWalls(pathMap, cellsMap, this.carbonFiberMaterial);
    
    // Set up path tracing for the complete scene
    if (this.pathTracer) {
      await this.pathTracer.buildSceneFromMaze({
        tiles: this.sceneGroups.tiles.children as THREE.Mesh[],
        walls: this.sceneGroups.walls.children as THREE.Mesh[],
        center: new THREE.Vector3(),
        size: 100,
        floorY: 0
      });
    }
    
    await this.prepareIntroAnimation();
  }



  /**
   * Animate solution paths through the maze
   */
  public async animatePaths(components: ProcessedConnComponent[]): Promise<void> {
    this.animationState = AnimationState.PATHS;
    this.animationManager.setState(AnimationState.PATHS);
    
    if (!this.pathAnimator) {
      this.initializeAnimationSystem();
    }
    
    const sortedComponents = [...components].sort((a, b) => a.pathLength - b.pathLength);
    
    // Generate beautiful color palette for path tracing
    let colors: string[] = [];
    if (sortedComponents.length >= 7) {
      colors = ['#e1e1ff', '#4169E1', '#00B2EE', '#7DF9FF'];
    } else if (sortedComponents.length >= 5) {
      colors = ['#4169E1', '#00B2EE', '#7DF9FF'];
    } else if (sortedComponents.length >= 2) {
      colors = ['#4169E1', '#7DF9FF'];
    }
    
    const pathStyles = createInterpolatedStyles(colors, sortedComponents.length, 0.9).map(style => ({
      color: style.color,
      opacity: 0.9 // Add opacity to match required type
    }));
    
    await this.validateAndRaiseSolvedComponents(sortedComponents, pathStyles);
    
    if (this.pathAnimator) {
      this.pathAnimator.start();
    }
    
    // Reset path tracer to account for new components
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
    }
    
    sortedComponents.forEach((component, index) => {
      const color = new THREE.Color(pathStyles[index].color);
      if (this.pathAnimator) {
        this.pathAnimator.queuePathAnimation(component, color);
      }
    });
    
    // Scene already built in createMaze() - no need to rebuild
  }

  /**
   * Skip the intro animation and go straight to path animation
   */
  async skipIntroAnimation(): Promise<void> {
    if (this.animationState !== AnimationState.INTRO) return;
    
    this.cameraAnimator?.stop();
    
    const bounds = this.calculateMazeBounds();
    const center = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      0,
      (bounds.minZ + bounds.maxZ) / 2
    );
    const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    
    const distance = size * 1.2;
    const angle = 60 * Math.PI / 180;
    
    if (this.camera) {
      this.camera.position.set(
        center.x - distance * Math.cos(angle),
        distance * Math.sin(angle),
        center.z
      );
      this.camera.lookAt(center);
    }
    
    await this.finishIntroAnimation();
  }

  /**
   * Check if WebGPU is being used
   */
  public isUsingWebGPU(): boolean {
    return this.usingWebGPU;
  }

  /**
   * Check if intro animation is in progress
   */
  public isIntroAnimationInProgress(): boolean {
    return this.introAnimationInProgress;
  }

  /**
   * Check if the animator is initialized
   */
  public isInitialized(): boolean {
    return this.initialized && !!this.scene && !!this.renderer && !!this.hexGrid;
  }

  /**
   * Focus camera on a specific point
   */
  focusCameraOn(position: THREE.Vector3, distance?: number, duration?: number): Promise<void> {
    if (!this.cameraAnimator) return Promise.resolve();
    return this.cameraAnimator.focusOn(position, distance || 50, duration || 1000);
  }

  /**
   * Toggle shadows
   */
  public toggleShadows(enabled: boolean): void {
    if (!this.renderer) return;
    
    this.renderer.shadowMap.enabled = enabled;
    
    if (this.scene) {
      this.scene.traverse((object: THREE.Object3D) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = enabled;
          object.receiveShadow = enabled;
        }
      });
    }
    
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
    }
  }

  /**
   * Export screenshot as data URL
   */
  public exportScreenshot(): string {
    if (!this.renderer) return '';
    
    try {
      return this.renderer.domElement.toDataURL('image/png');
    } catch (e) {
      console.error('Failed to create screenshot', e);
      return '';
    }
  }

  /**
   * Reset camera to default position
   */
  public resetCamera(): void {
    this.centerCameraOnMaze();
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
    }
  }

  /**
   * Centers the camera's view on the maze
   */
  private centerCameraOnMaze(): void {
    const bounds = this.calculateMazeBounds();
    const center = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      0,
      (bounds.minZ + bounds.maxZ) / 2
    );
    
    if (this.camera) {
      this.camera.lookAt(center);
      if (this.pathTracer) {
        this.pathTracer.resetRendering();
      }
    }
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    // Stop all animations
    if (this.animationManager) {
      this.animationManager.dispose();
    }
    
    // Cleanup animators
    this.cameraAnimator = null;
    this.lightingAnimator = null;
    this.pathAnimator = null;
    
    // Dispose path tracer
    if (this.pathTracer) {
      this.pathTracer.dispose();
    }
    
    // Remove resize observer
    if (this.resizeObserver) {
      if (this.container) {
        this.resizeObserver.unobserve(this.container);
      }
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // Clear scene groups with proper resource disposal
    if (this.sceneGroups) {
      Object.values(this.sceneGroups).forEach(group => {
        this.clearGroup(group);
      });
    }
    
    // Clear path meshes
    this.clearPathVisualizations();
    
    // Dispose board and hex grid
    if (this.board) {
      this.board.reset();
      this.board = null;
    }
    
    if (this.hexGrid) {
      this.hexGrid.dispose();
      this.hexGrid = null;
    }
    
    // Explicitly destroy WebGPU device if we have control over it
    if (this.usingWebGPU && this.gpuDevice) {
      try {
        this.gpuDevice.destroy();
      } catch (err) {
        console.warn('Error destroying WebGPU device:', err);
      }
      this.gpuDevice = null;
    }
    
    // Clean up renderer and scene
    if (this.renderer) {
      this.renderer.dispose();
      if (this.container && this.renderer.domElement) {
        try {
          this.container.removeChild(this.renderer.domElement);
        } catch (e) {
          console.warn('Error removing renderer DOM element', e);
        }
      }
      this.renderer = null;
    }
    
    // Clear references
    this.scene = null;
    this.camera = null;
    this.container = null;
    this.pathMap = null;
    this.bronzeMaterial = null;
    this.carbonFiberMaterial = null;
    
    // Force garbage collection if available
    if (window.gc) {
      window.gc();
    }
    
    console.log('MazeSceneManager disposed');
  }

  // -------------------------------------------------------------------
  // Maze & Intro Animation Methods
  // -------------------------------------------------------------------
  private async prepareIntroAnimation(): Promise<void> {
    if (!this.cameraAnimator || !this.lightingAnimator) {
      await this.initializeAnimationSystem();
    }
    
    this.animationState = AnimationState.INTRO;
    this.animationManager.setState(AnimationState.INTRO);
    this.introAnimationInProgress = true;
    
    const bounds = this.calculateMazeBounds();
    const center = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      0,
      (bounds.minZ + bounds.maxZ) / 2
    );
    const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    
    if (!this.lightingAnimator) return;
    this.lightingAnimator.setMazeBounds(center, size);
    
    const initialCameraPosition = new THREE.Vector3(
      center.x - size * 5,
      size * 5,
      center.z + size * 5
    );
    
    const distance = size * 1.2;
    const angle = 60 * Math.PI / 180;
    const finalCameraPosition = new THREE.Vector3(
      center.x - distance * Math.cos(angle),
      distance * Math.sin(angle),
      center.z
    );
    
    if (!this.camera) return;
    this.camera.position.copy(initialCameraPosition);
    this.camera.lookAt(center);
    
    // Disable progressive refinement during intro
    if (this.pathTracer) {
      this.pathTracer.setQuality('low');
    }
    
    if (!this.lightingAnimator) return;
    this.lightingAnimator.createSpotlights();
    this.lightingAnimator.start();
    
    if (!this.cameraAnimator) return;
    this.cameraAnimator.start();
    this.cameraAnimator.spiralPath(
      initialCameraPosition,
      finalCameraPosition,
      center,
      this.introDuration,
      () => this.finishIntroAnimation()
    );
    
    // Scene already built in createMaze() - just reset quality and rendering
    if (this.pathTracer) {
      this.pathTracer.setQuality('high');
      this.pathTracer.resetRendering();
    }
  }

  private async finishIntroAnimation(): Promise<void> {
    this.animationState = AnimationState.PATHS;
    this.animationManager.setState(AnimationState.PATHS);
    this.introAnimationInProgress = false;
    
    const cameraDirection = new THREE.Vector3();
    if (this.camera) {
      this.camera.getWorldDirection(cameraDirection);
    }
    
    if (this.lightingAnimator) {
      await this.lightingAnimator.transitionToNormalLighting(cameraDirection);
    }
    
    if (this.pathTracer) {
      this.pathTracer.setQuality('high');
      this.pathTracer.resetRendering();
      // Scene already built in createMaze() - no need to rebuild
    }
    
    if (this.animationQueue && this.animationQueue.length > 0 && this.pathAnimator) {
      this.pathAnimator.start();
      this.pathAnimator.processNextPathInQueue();
    }
  }

  /**
   * Validates and raises cells in solved components
   */
  private async validateAndRaiseSolvedComponents(
    components: ProcessedConnComponent[],
    pathStyles: { color: string; opacity: number }[]
  ): Promise<void> {
    if (!this.pathAnimator) return;
    
    const validationPromises: Promise<void>[] = [];
    
    components.forEach((component, index) => {
      if (!component.path || component.path.length < 2) {
        return;
      }
      
      const colorStr = pathStyles[index].color;
      const color = parseInt(colorStr.replace('#', '0x'));
      
      const promise = new Promise<void>(resolve => {
        setTimeout(() => {
          try {
            if (this.pathAnimator) {
              this.pathAnimator.raiseCellsInComponent(component, 1.5, color);
            }
            resolve();
          } catch (err) {
            console.error(`Error raising cells in component ${index}:`, err);
            resolve();
          }
        }, index * 100);
      });
      
      validationPromises.push(promise);
    });
    
    await Promise.all(validationPromises);
    
    // Scene already built in createMaze() - no need to rebuild for component validation
  }

  /**
   * Creates 3D wall meshes between cells that don't have open paths
   */
  private createWalls(pathMap: PathMap, cellsMap: Map<number, any>, wallMaterial: THREE.Material | null): void {
    const wallsGroup = this.sceneGroups.walls;
    
    while (wallsGroup.children.length > 0) {
      const wall = wallsGroup.children[0];
      wallsGroup.remove(wall);
      this.disposeMesh(wall);
    }
    
    // Configure wall dimensions
    const wallHeight = 3;
    let wallThickness = 0.25; // Slightly thinner walls look better with path tracing
    
    pathMap.cells.forEach(cell => {
      const hexCell = cellsMap.get(cell.linearId);
      if (!hexCell) return;
      
      for (let i = 0; i < 6; i++) {
        if (cell.openPaths.includes(i)) continue;
        
        const dir = this.hexDirections[i];
        const neighborQ = hexCell.q + dir.q;
        const neighborR = hexCell.r + dir.r;
        const neighborS = hexCell.s + dir.s;
        
        const neighborHash = this.hexGrid.cellToHash({ q: neighborQ, r: neighborR, s: neighborS });
        
        if (this.hexGrid.cells[neighborHash] && wallMaterial) {
          this.createWallBetweenCells(
            hexCell,
            { q: neighborQ, r: neighborR, s: neighborS },
            i,
            wallHeight,
            wallThickness,
            wallMaterial,
            0
          );
        } else if (!wallMaterial) {
          console.log('No wall material found');
        }
      }
    });
    
    // Walls are built as part of createMaze() - scene will be built there
  }

  /**
   * Creates a single wall mesh between two cells
   */
  private createWallBetweenCells(
    cell1: any,
    cell2: any,
    direction: number,
    height: number,
    thickness: number,
    material: THREE.Material,
    yPosition: number = 0
  ): void {
    if (!this.sceneGroups || !this.hexGrid) return;
    
    const pos1 = this.hexGrid.cellToPixel(cell1);
    
    const dir = this.hexDirections[direction];
    const wallPos = new THREE.Vector3(
      pos1.x + dir.q * this.hexGrid.cellSize * 0.75,
      height / 2 + yPosition,
      pos1.z + (dir.s - dir.r) * this.hexGrid.cellSize * 0.5 * window.vg.SQRT3
    );
    
    const angle = (direction * 60) * window.vg.DEG_TO_RAD;
    
    // Create wall geometry with more segments for smoother walls
    const wallGeo = new THREE.BoxGeometry(
      this.hexGrid.cellSize * 0.95,
      height,
      thickness,
      2, // width segments
      4, // height segments
      1  // depth segments
    );
    
    const wallMesh = new THREE.Mesh(wallGeo, material);
    wallMesh.position.copy(wallPos);
    wallMesh.rotation.y = angle;
    
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    
    // Enhance material for path tracing
    if (material instanceof THREE.MeshStandardMaterial) {
      // Clone the material to avoid affecting other walls
      wallMesh.material = material.clone();
      this.enhanceMaterialForPathTracing(wallMesh.material);
      wallMesh.userData['enhancedForPathTracing'] = true;
    }
    
    this.sceneGroups.walls.add(wallMesh);
  }

  /**
   * Calculates the bounding box of the entire maze
   */
  private calculateMazeBounds(): { minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number } {
    const bounds = {
      minX: Infinity, maxX: -Infinity,
      minY: Infinity, maxY: -Infinity,
      minZ: Infinity, maxZ: -Infinity
    };
    
    if (this.board && this.board.tiles) {
      this.board.tiles.forEach((tile: any) => {
        const pos = tile.position;
        bounds.minX = Math.min(bounds.minX, pos.x);
        bounds.maxX = Math.max(bounds.maxX, pos.x);
        bounds.minY = Math.min(bounds.minY, pos.y);
        bounds.maxY = Math.max(bounds.maxY, pos.y);
        bounds.minZ = Math.min(bounds.minZ, pos.z);
        bounds.maxZ = Math.max(bounds.maxZ, pos.z);
      });
    }
    
    // Add a small margin to ensure everything is visible
    const margin = 5;
    bounds.minX -= margin;
    bounds.maxX += margin;
    bounds.minY -= margin;
    bounds.maxY += margin;
    bounds.minZ -= margin;
    bounds.maxZ += margin;
    
    return bounds;
  }

  /**
   * Clears all maze elements from the scene
   */
  private clearMaze(): void {
    if (!this.scene) return;
    
    if (this.board) {
      this.board.reset();
    }
    
    if (this.sceneGroups) {
      Object.values(this.sceneGroups).forEach(group => {
        this.clearGroup(group);
      });
    }
    
    this.clearPathVisualizations();
    
    if (this.hexGrid) {
      for (const key in this.hexGrid.cells) {
        if (this.hexGrid.cells.hasOwnProperty(key)) {
          this.hexGrid.remove(this.hexGrid.cells[key]);
        }
      }
    }
    
    if (this.animationQueue) {
      this.animationQueue.clear();
    }
    
    // Reset path tracer when maze is cleared
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
    }
  }

  /**
   * Recursively clears all children from a THREE.Group
   */
  private clearGroup(group: THREE.Group): void {
    while (group.children.length > 0) {
      const child: THREE.Object3D = group.children[0];
      group.remove(child);
      
      if (child instanceof THREE.Mesh) {
        this.disposeMesh(child);
      } else if (child instanceof THREE.Group) {
        this.clearGroup(child);
      }
    }
  }

  /**
   * Clears all path visualization elements
   */
  private clearPathVisualizations(): void {
    if (!this.scene || !this.sceneGroups) return;
    
    const pathsGroup = this.sceneGroups.paths;
    while (pathsGroup.children.length > 0) {
      const child = pathsGroup.children[0];
      pathsGroup.remove(child);
      this.disposeMesh(child);
    }
    
    this.pathMeshes.forEach(mesh => {
      if (mesh.parent) { mesh.parent.remove(mesh); }
      if (mesh instanceof THREE.Mesh) { this.disposeMesh(mesh); }
    });
    
    this.pathMeshes.clear();
    
    // Reset path tracer when paths are cleared
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
    }
  }

  /**
   * Properly disposes of a THREE.Mesh and its resources
   */
  private disposeMesh(mesh: THREE.Object3D): void {
    if (!(mesh instanceof THREE.Mesh)) return;
    
    // Dispose geometry
    if (mesh.geometry) { 
      mesh.geometry.dispose(); 
    }
    
    // Dispose material(s)
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material: THREE.Material) => material.dispose());
      } else {
        mesh.material.dispose();
      }
    }
    
    // Clean up path tracer specific resources
    if (mesh.userData['pathTracerData']) {
      mesh.userData['pathTracerData'] = null;
    }
  }

  /**
   * Creates a mapping from linear IDs to axial coordinates
   */
  createLinearIdToAxialArray(rows: number, cols: number): void {
    this.linearToAxialArray = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const linearId = row * cols + col + 1;
        const r = row;
        const q = col - Math.floor((row - (row & 1)) / 2);
        this.linearToAxialArray[linearId] = { q, r };
      }
    }
  }

  /**
   * Retrieves axial coordinates for a given linear ID
   */
  getAxialFromLinearId(linearId: number): { q: number, r: number } | undefined {
    return this.linearToAxialArray[linearId];
  }

  /**
   * Updates the internal dimensions of the hex grid
   */
  private _updateGridDimensions(): void {
    if (!this.hexGrid) return;
    this.hexGrid._cellLength = this.hexGrid.cellSize * 2;
    this.hexGrid._cellWidth = window.vg.SQRT3 * this.hexGrid.cellSize;
  }

  /**
   * Processes the edges in a path map to establish connections between cells
   */
  private processPathMapEdges(pathMap: PathMap): void {
    const cellsById = new Map<number, PathCell>();
    pathMap.cells.forEach(cell => { cellsById.set(cell.linearId, cell); });
    
    pathMap.edges.forEach(edge => {
      const fromCell = cellsById.get(edge.from);
      const toCell = cellsById.get(edge.to);
      
      if (!fromCell || !toCell) {
        throw new Error(`Edge references non-existent cell: from=${edge.from}, to=${edge.to}`);
      }
      
      const fromAxial = this.getAxialFromLinearId(fromCell.linearId);
      const toAxial = this.getAxialFromLinearId(toCell.linearId);
      
      if (!fromAxial || !toAxial) {
        throw new Error(`Failed to convert cell IDs to axial coordinates: from=${fromCell.linearId}, to=${toCell.linearId}`);
      }
      
      let directionIndex = -1;
      for (let i = 0; i < this.hexDirections.length; i++) {
        const dir = this.hexDirections[i];
        if (fromAxial.q + dir.q === toAxial.q && fromAxial.r + dir.r === toAxial.r) {
          directionIndex = i;
          break;
        }
      }
      
      if (directionIndex === -1) {
        throw new Error(`Could not determine direction between cells: from=${fromCell.linearId}, to=${toCell.linearId}`);
      }
      
      if (!fromCell.openPaths.includes(directionIndex)) {
        fromCell.openPaths.push(directionIndex);
      }
      
      const oppositeDirection = (directionIndex + 3) % 6;
      if (!toCell.openPaths.includes(oppositeDirection)) {
        toCell.openPaths.push(oppositeDirection);
      }
    });
  }
} 