import { Injectable, Inject, PLATFORM_ID, NgZone } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import * as THREE from 'three';

import { PathMap, PathCell } from './maze-generator.service';
import { ProcessedConnComponent } from './maze-solver.service';

// Import OrbitControls with type assertion
import '../../../assets/js/hex-grid/lib/OrbitControls.js';

// Import von-grid library (you may need to adjust this based on how you've integrated it)
declare var vg: any;

// Add type declaration to make TypeScript happy
declare module 'three' {
  export class OrbitControls {
    constructor(object: THREE.PerspectiveCamera | THREE.OrthographicCamera, domElement?: HTMLElement);
    enabled: boolean;
    target: THREE.Vector3;
    enableDamping: boolean;
    dampingFactor: number;
    screenSpacePanning: boolean;
    minDistance: number;
    maxDistance: number;
    maxPolarAngle: number;
    update(): void;
    dispose(): void;
  }
}

@Injectable({
    providedIn: 'root'
  })
export class MazeAnimatorService {
  private renderer: THREE.WebGLRenderer | any = null; // 'any' to support WebGPURenderer
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: THREE.OrbitControls | null = null;
  private hexGrid: any = null;
  private board: any = null; // vg.Board instance
  private pathMap: PathMap | null = null;
  private animationFrameId: number | null = null;
  private pathMeshes: Map<string, THREE.Object3D> = new Map();
  private wallGroup: THREE.Group | null = null;
  private animatingPaths: { 
    component: ProcessedConnComponent, 
    currentStep: number, 
    meshes: THREE.Object3D[],
    color: THREE.Color
  }[] = [];
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private hexDirections: any[] = [];
  private usingWebGPU: boolean = false;
  private linearToAxialArray: { q: number, r: number }[] = [];

  // Add properties for intro animation
  private introAnimationInProgress: boolean = false;
  private spotlights: THREE.SpotLight[] = [];
  private initialCameraPosition: THREE.Vector3 | null = null;
  private finalCameraPosition: THREE.Vector3 | null = null;
  private introAnimationStartTime: number = 0;
  private introDuration: number = 5000; // 5 seconds in milliseconds
  private sunLight: THREE.DirectionalLight | null = null;

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private ngZone: NgZone
  ) {
    // Define the six directions of a hexagon (in cube coordinates)
    this.hexDirections = [
      { q: 1, r: -1, s: 0 },  // 0: East
      { q: 1, r: 0, s: -1 },  // 1: Northeast
      { q: 0, r: 1, s: -1 },  // 2: Northwest
      { q: -1, r: 1, s: 0 },  // 3: West
      { q: -1, r: 0, s: 1 },  // 4: Southwest
      { q: 0, r: -1, s: 1 }   // 5: Southeast
    ];
  }

  /**
   * Initialize the 3D rendering environment
   */
  initialize(container: HTMLElement): boolean {
    if (!isPlatformBrowser(this.platformId)) {
      return false;
    }

    this.container = container;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Initialize the vg.Loader
    if (typeof vg.Loader !== 'undefined' && vg.Loader.init) {
      vg.Loader.init();
    } else {
      console.warn('vg.Loader not found, this may cause issues with von-grid');
    }

    // Try to create a WebGPU renderer first, fall back to WebGL if not available
    try {
      if ('WebGPURenderer' in THREE) {
        this.renderer = new (THREE as any).WebGPURenderer({ 
          antialias: true,
          powerPreference: 'high-performance'
        });
        this.usingWebGPU = true;
        console.debug('Using WebGPU renderer');
      } else {
        throw new Error('WebGPU not available');
      }
    } catch (e) {
      console.warn('WebGPU not supported, falling back to WebGL', e);
      this.renderer = new THREE.WebGLRenderer({ 
        antialias: true,
        powerPreference: 'high-performance' 
      });
      this.usingWebGPU = false;
    }

    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    // Create scene with very dark background (not pure black)
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a12); // Very dark blue-purple
    this.scene.fog = new THREE.FogExp2(0x0a0a12, 0.002); // Match background color

    // Setup camera
    this.camera = new THREE.PerspectiveCamera(60, width / height, 1, 2000);
    this.camera.position.set(0, 150, 150);
    this.camera.lookAt(0, 0, 0);

    // Setup lighting - modified for intro animation and dark theme
    const ambientLight = new THREE.AmbientLight(0x222233, 0.2); // Very dim blue-tinted ambient light
    this.scene.add(ambientLight);

    // Setup initial sun light but make it dim initially
    this.sunLight = new THREE.DirectionalLight(0xccccff, 0.3); // Slightly blue-tinted light
    this.sunLight.position.set(1, 1, 1).normalize();
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.scene.add(this.sunLight);

    // Setup controls
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 500;
    this.controls.maxPolarAngle = Math.PI / 2;
    
    // Disable controls during intro animation
    this.controls.enabled = false;

    // Initialize the hex grid
    this.hexGrid = new vg.HexGrid({
      cellSize: 10
    });

    // Initialize the board to manage the grid
    this.board = new vg.Board(this.hexGrid, {
      allowDiagonal: false,
      heuristic: 'manhattan'
    });

    // Add the board to the scene
    this.scene.add(this.board.group);

    // Create a group for walls
    this.wallGroup = new THREE.Group();
    this.scene.add(this.wallGroup);

    // Setup resize observer for responsive design
    this.setupResizeObserver();

    return true;
  }

  /**
   * Creates and renders the 3D maze from the pathMap
   */
  createMaze(pathMap: PathMap): void {
    if (!this.scene || !this.hexGrid || !this.board) return;

    // Clear previous maze
    this.clearMaze();
    this.pathMap = pathMap;

    // Initialize the linear to axial coordinate lookup array
    this.createLinearIdToAxialArray(pathMap.dimensions.rows, pathMap.dimensions.cols);

    // Configure hex grid
    const cellSize = pathMap.dimensions.hexWidth / (2 * Math.sqrt(3));
    this.hexGrid.cellSize = cellSize;
    this._updateGridDimensions();

    // Process edges to ensure openPaths is correctly populated
    this.processPathMapEdges(pathMap);

    // Create cells in the grid
    const cellsMap = new Map<number, any>(); // Map linearId to cell
    
    pathMap.cells.forEach(cell => {
      // Use the axial coordinates from our conversion function
      const axialCoords = this.getAxialFromLinearId(cell.linearId);
      
      if (!axialCoords) {
        throw new Error(`Failed to convert linearId ${cell.linearId} to axial coordinates`);
      }
      
      const q = axialCoords.q;
      const r = axialCoords.r;
      const s = -q - r;
      
      const hexCell = new vg.Cell(q, r, s);
      hexCell.h = 1; // Base height
      hexCell.walkable = cell.openPaths.length > 0;
      hexCell.userData = {
        linearId: cell.linearId,
        openPaths: cell.openPaths
      };
      
      this.hexGrid.add(hexCell);
      cellsMap.set(cell.linearId, hexCell);
    });

    // Generate the 3D tiles
    const materials = this.createMaterials();
    this.board.generateTilemap({
      tileScale: 0.95,
      material: materials.base,
      extrudeSettings: {
        depth: 1,
        bevelEnabled: true,
        bevelSegments: 1,
        steps: 1,
        bevelSize: cellSize / 20,
        bevelThickness: cellSize / 20
      }
    });

    // Enable shadows on all tiles
    if (this.board.tiles) {
      this.board.tiles.forEach((tile: any) => {
        if (tile.mesh) {
          tile.mesh.castShadow = true;
          tile.mesh.receiveShadow = true;
        }
      });
    }

    // Create walls between cells
    this.createWalls(pathMap, cellsMap);

    // Instead of immediately centering the camera, prepare for intro animation
    this.prepareIntroAnimation();
  }

  /**
   * Process the edges from pathMap to ensure openPaths is correctly populated
   */
  private processPathMapEdges(pathMap: PathMap): void {
    // Create a map to quickly look up cells by linearId
    const cellsById = new Map<number, PathCell>();
    pathMap.cells.forEach(cell => {
      cellsById.set(cell.linearId, cell);
    });

    // Process each edge to update the openPaths arrays
    pathMap.edges.forEach(edge => {
      const fromCell = cellsById.get(edge.from);
      const toCell = cellsById.get(edge.to);
      
      if (!fromCell || !toCell) {
        throw new Error(`Edge references non-existent cell: from=${edge.from}, to=${edge.to}`);
      }
      
      // Use axial coordinates from our conversion function
      const fromAxial = this.getAxialFromLinearId(fromCell.linearId);
      const toAxial = this.getAxialFromLinearId(toCell.linearId);
      
      if (!fromAxial || !toAxial) {
        throw new Error(`Failed to convert cell IDs to axial coordinates: from=${fromCell.linearId}, to=${toCell.linearId}`);
      }
      
      // Find the direction index based on the relative positions using axial coordinates
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
      
      // If we found a valid direction, add it to openPaths if not already there
      if (!fromCell.openPaths.includes(directionIndex)) {
        fromCell.openPaths.push(directionIndex);
      }
      
      // Also add the opposite direction to the toCell
      const oppositeDirection = (directionIndex + 3) % 6;
      if (!toCell.openPaths.includes(oppositeDirection)) {
        toCell.openPaths.push(oppositeDirection);
      }
    });
  }

  /**
   * Create walls between cells based on the pathMap
   */
  private createWalls(pathMap: PathMap, cellsMap: Map<number, any>): void {
    if (!this.wallGroup) return;
    
    // Clear any existing walls
    while (this.wallGroup.children.length > 0) {
      const wall = this.wallGroup.children[0];
      this.wallGroup.remove(wall);
      if (wall instanceof THREE.Mesh) {
        wall.geometry.dispose();
        if (wall.material instanceof THREE.Material) {
          wall.material.dispose();
        }
      }
    }

    // Use neon green material for walls
    const wallMaterial = new THREE.MeshPhongMaterial({
      color: 0x00ff44, // Neon green
      emissive: 0x008822, // Slight glow effect
      specular: 0xffffff, // Strong specular highlights
      shininess: 100, // Very shiny for that neon effect
      side: THREE.DoubleSide
    });

    const wallHeight = 3;
    const wallThickness = 0.3;

    // Process each cell
    pathMap.cells.forEach(cell => {
      const hexCell = cellsMap.get(cell.linearId);
      if (!hexCell) return;

      // Check each direction
      for (let i = 0; i < 6; i++) {
        // Skip if there's an open path in this direction
        if (cell.openPaths.includes(i)) continue;

        // Calculate neighbor coordinates
        const dir = this.hexDirections[i];
        const neighborQ = hexCell.q + dir.q;
        const neighborR = hexCell.r + dir.r;
        const neighborS = hexCell.s + dir.s;

        // Check if neighbor exists in our grid
        const neighborHash = this.hexGrid.cellToHash({q: neighborQ, r: neighborR, s: neighborS});
        const neighborExists = !!this.hexGrid.cells[neighborHash];

        // Only create walls between existing cells
        if (neighborExists) {
          this.createWallBetweenCells(hexCell, {q: neighborQ, r: neighborR, s: neighborS}, i, wallHeight, wallThickness, wallMaterial);
        }
      }
    });
  }

  /**
   * Create a wall between two cells
   */
  private createWallBetweenCells(cell1: any, cell2: any, direction: number, height: number, thickness: number, material: THREE.Material): void {
    if (!this.wallGroup || !this.hexGrid) return;

    // Get cell positions
    const pos1 = this.hexGrid.cellToPixel(cell1);
    
    // Calculate wall position (midpoint between cells)
    const dir = this.hexDirections[direction];
    const wallPos = new THREE.Vector3(
      pos1.x + dir.q * this.hexGrid.cellSize * 0.75,
      height / 2,
      pos1.z + (dir.s - dir.r) * this.hexGrid.cellSize * 0.5 * vg.SQRT3
    );
    
    // Calculate wall rotation
    const angle = (direction * 60) * vg.DEG_TO_RAD;
    
    // Create wall geometry
    const wallGeo = new THREE.BoxGeometry(
      this.hexGrid.cellSize * 0.95, // Length
      height,                        // Height
      thickness                      // Thickness
    );
    
    const wallMesh = new THREE.Mesh(wallGeo, material);
    wallMesh.position.copy(wallPos);
    wallMesh.rotation.y = angle;
    
    // Enable shadows
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    
    this.wallGroup.add(wallMesh);
  }

  /**
   * Visualize the paths from the maze solver with a tracing animation effect
   */
  public VisualizePaths(components: ProcessedConnComponent[]): void {
    if (!this.scene || !this.pathMap) return;
    
    // Clear any previous path visualizations
    this.clearPathVisualizations();
    
    // Sort components by path length
    const sortedComponents = [...components].sort((a, b) => a.pathLength - b.pathLength);
    
    // Import the color creation function from the solver service
    const pathStyles = this.createInterpolatedStyles(
      ['#ffffff', '#0d47a1', '#00acc1', '#b2ebf2'], 
      sortedComponents.length, 
      0.8
    );
    
    // Initialize path animations for each component
    sortedComponents.forEach((component, index) => {
      if (!component.path || component.path.length < 2) return;
      
      // Get the target color for this component
      const style = pathStyles[index];
      const targetColor = new THREE.Color(style.color);
      
      this.animatingPaths.push({
        component,
        currentStep: 0,
        meshes: [],
        color: targetColor
      });
    });
    
    // Start the animated path tracing
    this.startPathTracing();
  }

  /**
   * Begin the animated path tracing process
   */
  private startPathTracing(): void {
    // Only animate one component at a time
    // Start with the first component (shortest path)
    if (this.animatingPaths.length === 0) return;
    
    this.animatePathTracing(0);
  }

  /**
   * Animate tracing a single path through the maze
   */
  private animatePathTracing(componentIndex: number): void {
    if (componentIndex >= this.animatingPaths.length) return;
    
    const pathInfo = this.animatingPaths[componentIndex];
    const component = pathInfo.component;
    
    // If we're done with this path, move to the next component
    if (pathInfo.currentStep >= component.path.length) {
      // Start the next component's animation after a short delay
      setTimeout(() => {
        this.animatePathTracing(componentIndex + 1);
      }, 500);
      return;
    }
    
    // Get the current cell in the path
    const cellId = component.path[pathInfo.currentStep];
    
    // Animate this cell
    this.animateCellInPath(
      parseInt(cellId),
      pathInfo,
      componentIndex,
      () => {
        // Advance to next step in the path
        pathInfo.currentStep++;
        
        // Continue the animation for this component
        setTimeout(() => {
          this.animatePathTracing(componentIndex);
        }, 150); // Speed of path tracing
      }
    );
  }

  /**
   * Animate a single cell in the path
   */
  private animateCellInPath(
    cellId: number, 
    pathInfo: { 
      component: ProcessedConnComponent, 
      currentStep: number, 
      meshes: THREE.Object3D[],
      color: THREE.Color
    },
    componentIndex: number,
    onComplete: () => void
  ): void {
    const cell = this.findCellById(cellId);
    if (!cell || !this.hexGrid) return;
    
    // Convert to axial coordinates
    const axial = this.getAxialFromLinearId(cellId);
    if (!axial) return;
    
    // Find the cell in the hex grid
    const cellHash = this.hexGrid.cellToHash({
      q: axial.q,
      r: axial.r,
      s: -axial.q - axial.r
    });
    
    const hexCell = this.hexGrid.cells[cellHash];
    if (!hexCell || !hexCell.tile) return;
    
    // Get the tile mesh
    const tileMesh = hexCell.tile.mesh;
    
    // Get the component height and calculate the pulse height
    const componentHeight = 1 + (5 / (componentIndex + 1));
    const pulseHeight = componentHeight + 2;
    
    // Create a bright white material for the pulse effect
    const whiteMaterial = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0xaaaaaa,
      shininess: 100,
      specular: 0xffffff
    });
    
    // Save the original material
    const originalMaterial = tileMesh.material;
    
    // Change to white material
    tileMesh.material = whiteMaterial;
    
    // Original position
    const originalY = componentHeight;
    const currentPosition = tileMesh.position.y;
    
    // Animate the pulse up
    this.animateProperty(
      // The object to animate
      { value: currentPosition },
      // Target value
      { value: pulseHeight },
      // Duration
      200,
      // Easing function
      this.easeOutQuad,
      // Update callback
      (obj) => {
        tileMesh.position.y = obj.value;
      },
      // Complete callback
      () => {
        // Now animate back down
        this.animateProperty(
          { value: pulseHeight },
          { value: originalY },
          300,
          this.easeInOutQuad,
          (obj) => {
            tileMesh.position.y = obj.value;
          },
          () => {
            // Fade from white to target color
            this.fadeColor(
              tileMesh.material as THREE.MeshPhongMaterial, 
              pathInfo.color,
              1000, // Fade duration in ms
              () => {
                // Restore original material with target color
                tileMesh.material = originalMaterial;
                if (tileMesh.material instanceof THREE.MeshPhongMaterial) {
                  tileMesh.material.color.copy(pathInfo.color);
                  tileMesh.material.emissive.copy(pathInfo.color).multiplyScalar(0.3);
                }
                
                // Animation complete
                onComplete();
              }
            );
          }
        );
      }
    );
    
    // If this is not the first tile, create a connection to the previous tile
    if (pathInfo.currentStep > 0) {
      const prevCellId = pathInfo.component.path[pathInfo.currentStep - 1];
      this.createPathSegment(prevCellId.toString(), cellId.toString(), pathInfo.meshes, pathInfo.color);
    }
  }

  /**
   * Animate a property from one value to another
   */
  private animateProperty(
    from: any,
    to: any,
    duration: number,
    easingFn: (t: number) => number,
    updateFn: (obj: any) => void,
    completeFn?: () => void
  ): void {
    const startTime = Date.now();
    
    const animate = () => {
      const currentTime = Date.now();
      const elapsed = currentTime - startTime;
      const progress = Math.min(1, elapsed / duration);
      
      const easedProgress = easingFn(progress);
      
      // Update all properties
      for (const key in from) {
        if (from.hasOwnProperty(key) && to.hasOwnProperty(key)) {
          from[key] = from[key] + (to[key] - from[key]) * easedProgress;
        }
      }
      
      // Call the update function
      updateFn(from);
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        if (completeFn) completeFn();
      }
    };
    
    animate();
  }

  /**
   * Fade a material's color from its current color to a target color
   */
  private fadeColor(
    material: THREE.MeshPhongMaterial,
    targetColor: THREE.Color,
    duration: number,
    onComplete?: () => void
  ): void {
    // Get current colors
    const startColor = material.color.clone();
    const startEmissive = material.emissive.clone();
    const targetEmissive = targetColor.clone().multiplyScalar(0.3);
    
    const startTime = Date.now();
    
    const animate = () => {
      const currentTime = Date.now();
      const elapsed = currentTime - startTime;
      const progress = Math.min(1, elapsed / duration);
      
      const easedProgress = this.easeInOutQuad(progress);
      
      // Interpolate color
      const currentColor = new THREE.Color();
      currentColor.r = startColor.r + (targetColor.r - startColor.r) * easedProgress;
      currentColor.g = startColor.g + (targetColor.g - startColor.g) * easedProgress;
      currentColor.b = startColor.b + (targetColor.b - startColor.b) * easedProgress;
      
      // Interpolate emissive
      const currentEmissive = new THREE.Color();
      currentEmissive.r = startEmissive.r + (targetEmissive.r - startEmissive.r) * easedProgress;
      currentEmissive.g = startEmissive.g + (targetEmissive.g - startEmissive.g) * easedProgress;
      currentEmissive.b = startEmissive.b + (targetEmissive.b - startEmissive.b) * easedProgress;
      
      // Update material
      material.color.copy(currentColor);
      material.emissive.copy(currentEmissive);
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        if (onComplete) onComplete();
      }
    };
    
    animate();
  }

  // Easing functions
  private easeOutQuad(t: number): number {
    return t * (2 - t);
  }

  private easeInOutQuad(t: number): number {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  /**
   * Copy of createInterpolatedStyles from the solver service
   */
  private createInterpolatedStyles(
    baseHexColors: string[],
    total: number,
    alpha: number = 0.8
  ): any[] {
    if (baseHexColors.length < 2) {
      throw new Error('Need at least two base colors to interpolate.');
    }
    if (total < 2) {
      throw new Error('Total interpolated colors must be at least 2.');
    }

    // Create interpolator using THREE.js color interpolation
    const colors: THREE.Color[] = baseHexColors.map(hex => new THREE.Color(hex));
    
    const result: any[] = [];
    for (let i = 0; i < total; i++) {
      const t = i / (total - 1);
      
      // Create an interpolated color
      const color = new THREE.Color();
      
      if (t <= 0) {
        color.copy(colors[0]);
      } else if (t >= 1) {
        color.copy(colors[colors.length - 1]);
      } else {
        // Find the segment
        const segmentCount = colors.length - 1;
        const segment = Math.min(Math.floor(t * segmentCount), segmentCount - 1);
        const segmentT = (t - segment / segmentCount) * segmentCount;
        
        // Interpolate between the two colors in this segment
        const color1 = colors[segment];
        const color2 = colors[segment + 1];
        
        color.r = color1.r + (color2.r - color1.r) * segmentT;
        color.g = color1.g + (color2.g - color1.g) * segmentT;
        color.b = color1.b + (color2.b - color1.b) * segmentT;
      }
      
      // Convert to hex
      const hexColor = '#' + color.getHexString();
      const borderColor = '#' + new THREE.Color(
        Math.min(1, color.r + 0.2),
        Math.min(1, color.g + 0.2),
        Math.min(1, color.b + 0.2)
      ).getHexString();
      
      result.push({
        color: hexColor,
        borderColor: borderColor,
        alpha,
        glowColor: '#f0f4ff'
      });
    }

    return result;
  }

  /**
   * Center the camera on the maze
   */
  private centerCameraOnMaze(): void {
    if (!this.camera || !this.controls || !this.board || !this.board.tiles || this.board.tiles.length === 0) return;
    
    const bounds = this.calculateMazeBounds();
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    
    // Calculate appropriate camera distance based on maze size
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    const size = Math.max(width, depth);
    const distance = size * 1.5;
    
    // Position camera
    this.camera.position.set(
      centerX - distance * 0.7, 
      distance * 0.8, 
      centerZ + distance * 0.7
    );
    
    this.camera.lookAt(centerX, 0, centerZ);
    this.controls.target.set(centerX, 0, centerZ);
    this.controls.update();
  }

  /**
   * Calculate the bounds of the maze for camera positioning
   */
  private calculateMazeBounds(): { minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number } {
    const bounds = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity
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
    
    return bounds;
  }

  /**
   * Find a cell by its linear ID
   */
  private findCellById(linearId: number): PathCell | undefined {
    return this.pathMap?.cells.find(c => c.linearId === linearId);
  }

  /**
   * Create materials for the maze
   */
  private createMaterials(): { base: THREE.Material, path: THREE.Material, wall: THREE.Material } {
    const baseMaterial = new THREE.MeshPhongMaterial({
      color: 0x330066, // Dark purple
      specular: 0x6600cc, // Purple highlights
      shininess: 30,
      flatShading: true
    });
    
    const pathMaterial = new THREE.MeshPhongMaterial({
      color: 0x00ffff,
      emissive: 0x007777,
      shininess: 10,
      transparent: true,
      opacity: 0.7
    });
    
    const wallMaterial = new THREE.MeshPhongMaterial({
      color: 0x00ff44, // Neon green
      emissive: 0x008822, // Slight glow effect
      specular: 0xffffff, // Strong specular for neon look
      shininess: 100,
      flatShading: false
    });
    
    return {
      base: baseMaterial,
      path: pathMaterial,
      wall: wallMaterial
    };
  }

  /**
   * Update grid dimensions when cell size changes
   */
  private _updateGridDimensions(): void {
    if (!this.hexGrid) return;
    
    this.hexGrid._cellWidth = this.hexGrid.cellSize * 2;
    this.hexGrid._cellLength = (vg.SQRT3 * 0.5) * this.hexGrid._cellWidth;
  }

  /**
   * Setup resize observer for responsive design
   */
  private setupResizeObserver(): void {
    if (!isPlatformBrowser(this.platformId) || !this.container) return;
    
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    
    this.resizeObserver.observe(this.container);
  }

  /**
   * Start the animation loop
   */
  private startAnimation(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    
    this.ngZone.runOutsideAngular(() => {
      const animate = () => {
        this.animationFrameId = requestAnimationFrame(animate);
        
        // Update intro animation if in progress
        if (this.introAnimationInProgress) {
          this.updateIntroAnimation();
        }
        
        if (this.controls) {
          this.controls.update();
        }
        
        if (this.renderer && this.scene && this.camera) {
          this.renderer.render(this.scene, this.camera);
        }
      };
      
      animate();
    });
  }

  /**
   * Clear the current maze
   */
  private clearMaze(): void {
    if (!this.scene || !this.board) return;
    
    // Reset the board
    this.board.reset();
    
    // Clear walls
    if (this.wallGroup) {
      while (this.wallGroup.children.length > 0) {
        const wall = this.wallGroup.children[0];
        this.wallGroup.remove(wall);
        if (wall instanceof THREE.Mesh) {
          wall.geometry.dispose();
          if (wall.material instanceof THREE.Material) {
            wall.material.dispose();
          }
        }
      }
    }
    
    this.clearPathVisualizations();
    
    // Reset the grid
    if (this.hexGrid) {
      // Clear cells but keep the grid instance
      for (const key in this.hexGrid.cells) {
        if (this.hexGrid.cells.hasOwnProperty(key)) {
          this.hexGrid.remove(this.hexGrid.cells[key]);
        }
      }
    }
  }

  /**
   * Clear any path visualizations
   */
  private clearPathVisualizations(): void {
    if (!this.scene) return;
    
    // Remove existing path meshes
    this.animatingPaths.forEach(path => {
      path.meshes.forEach(mesh => {
        if (mesh && mesh.parent) {
          this.scene!.remove(mesh);
        }
        if (mesh instanceof THREE.Mesh) {
          mesh.geometry.dispose();
          if (mesh.material instanceof THREE.Material) {
            mesh.material.dispose();
          }
        }
      });
    });
    
    this.animatingPaths = [];
    this.pathMeshes.forEach(mesh => {
      if (mesh && mesh.parent) {
        this.scene!.remove(mesh);
      }
      if (mesh instanceof THREE.Mesh) {
        mesh.geometry.dispose();
        if (mesh.material instanceof THREE.Material) {
          mesh.material.dispose();
        }
      }
    });
    
    this.pathMeshes.clear();
  }

  /**
   * Resize handler for when container changes size
   */
  resize(): void {
    if (!this.renderer || !this.camera || !this.container) return;
    
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setSize(width, height);
  }

  /**
   * Returns true if WebGPU is being used
   */
  isUsingWebGPU(): boolean {
    return this.usingWebGPU;
  }

  /**
   * Cleanup resources when component is destroyed
   */
  dispose(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    if (this.resizeObserver && this.container) {
      this.resizeObserver.unobserve(this.container);
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    this.clearMaze();
    
    if (this.board) {
      this.board.reset();
      this.board = null;
    }
    
    if (this.hexGrid) {
      this.hexGrid.dispose();
      this.hexGrid = null;
    }
    
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
    
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
    
    this.scene = null;
    this.camera = null;
    this.container = null;
  }

  /**
   * Returns if the service was initialized successfully
   */
  isInitialized(): boolean {
    return !!this.scene && !!this.renderer && !!this.hexGrid;
  }

  /**
   * Restart animation of the paths
   */
  restartPathAnimation(): void {
    if (this.animatingPaths.length > 0) {
      // Reset animation state
      this.animatingPaths.forEach(path => {
        path.currentStep = 0;
        
        // Clear existing meshes
        path.meshes.forEach(mesh => {
          if (mesh && mesh.parent) {
            this.scene!.remove(mesh);
          }
          if (mesh instanceof THREE.Mesh) {
            mesh.geometry.dispose();
            if (mesh.material instanceof THREE.Material) {
              mesh.material.dispose();
            }
          }
        });
        
        path.meshes = [];
      });
      
      // Start animation again
      this.animateNextPathStep();
    }
  }

  /**
   * Set camera to focus on entire maze
   */
  resetCamera(): void {
    this.centerCameraOnMaze();
  }

  /**
   * Toggle shadows on/off
   */
  toggleShadows(enabled: boolean): void {
    if (!this.renderer) return;
    
    this.renderer.shadowMap.enabled = enabled;
    
    // Update all objects
    if (this.scene) {
      this.scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = enabled;
          object.receiveShadow = enabled;
        }
      });
    }
  }

  /**
   * Export the current maze as a screenshot
   */
  exportScreenshot(): string {
    if (!this.renderer) return '';
    
    // Render the scene
    if (this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
    
    // Get the image data URL
    try {
      return this.renderer.domElement.toDataURL('image/png');
    } catch (e) {
        console.error('Failed to create screenshot', e);
        return '';
      }
    }

  /**
   * Initializes the linear ID to axial coordinates lookup array.
   */
  createLinearIdToAxialArray(rows: number, cols: number): void {
    this.linearToAxialArray = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const linearId = row * cols + col + 1; // linear IDs are 1-indexed
        const r = row;
        const q = col - Math.floor((row - (row & 1)) / 2);
        this.linearToAxialArray[linearId] = { q, r };
      }
    }
  }
  /**
   * Converts a linear ID to axial coordinates (q,r) for a hexagonal grid.
   * 
   * @param linearId - The 1-based linear index of the hexagon in the grid
   * @returns An object containing the axial coordinates {q,r} or undefined if the ID is invalid
   * 
   * The axial coordinate system uses:
   * - q: The column axis (increases going right)
   * - r: The row axis (increases going down)
   * 
   * This method uses the lookup array created by createLinearIdToAxialArray()
   * and must be called after that initialization.
   */

  getAxialFromLinearId(linearId: number): { q: number, r: number } | undefined {
    return this.linearToAxialArray[linearId];
  }

  /**
   * Prepare for the intro animation
   */
  private prepareIntroAnimation(): void {
    if (!this.scene || !this.camera) return;
    
    // Calculate maze bounds for camera positioning
    const bounds = this.calculateMazeBounds();
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    
    // Calculate appropriate camera distance based on maze size
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    const size = Math.max(width, depth);
    
    // Set initial (far away) camera position
    this.initialCameraPosition = new THREE.Vector3(
      centerX - size * 4, 
      size * 4, 
      centerZ + size * 4
    );
    
    // Set final camera position (60 degree angle)
    const distance = size * 1.2;
    const angle = 60 * Math.PI / 180; // 60 degrees in radians
    this.finalCameraPosition = new THREE.Vector3(
      centerX - distance * Math.cos(angle), 
      distance * Math.sin(angle), 
      centerZ
    );
    
    // Set camera to initial position
    this.camera.position.copy(this.initialCameraPosition);
    this.camera.lookAt(centerX, 0, centerZ);
    
    if (this.controls) {
      this.controls.target.set(centerX, 0, centerZ);
      this.controls.update();
    }
    
    // Create spotlights for intro
    this.createSpotlights(centerX, centerZ, size);
    
    // Mark animation as in progress
    this.introAnimationInProgress = true;
    this.introAnimationStartTime = Date.now();
    
    // Start animation
    this.startAnimation();
  }

  /**
   * Create spotlights for the intro animation
   */
  private createSpotlights(centerX: number, centerZ: number, size: number): void {
    if (!this.scene) return;
    
    // Clear any existing spotlights
    this.spotlights.forEach(light => {
      if (light.parent) {
        this.scene!.remove(light);
      }
    });
    this.spotlights = [];
    
    // Create several spotlights in different positions
    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff];
    const spotlightCount = 5;
    
    for (let i = 0; i < spotlightCount; i++) {
      const angle = (i / spotlightCount) * Math.PI * 2;
      const radius = size * 1.5;
      
      const spotlight = new THREE.SpotLight(
        colors[i % colors.length],
        1,
        size * 3,
        Math.PI / 8,
        0.5,
        2
      );
      
      spotlight.position.set(
        centerX + Math.cos(angle) * radius,
        size * 1.5,
        centerZ + Math.sin(angle) * radius
      );
      
      spotlight.lookAt(centerX, 0, centerZ);
      
      // Enable shadows for the spotlight
      spotlight.castShadow = true;
      spotlight.shadow.mapSize.width = 1024;
      spotlight.shadow.mapSize.height = 1024;
      
      this.scene.add(spotlight);
      this.spotlights.push(spotlight);
    }
  }

  /**
   * Update the intro animation
   */
  private updateIntroAnimation(): void {
    if (!this.introAnimationInProgress || !this.camera || !this.scene || 
        !this.initialCameraPosition || !this.finalCameraPosition) return;
    
    const currentTime = Date.now();
    const elapsed = currentTime - this.introAnimationStartTime;
    const progress = Math.min(elapsed / this.introDuration, 1.0);
    
    // Get bounds for animation reference
    const bounds = this.calculateMazeBounds();
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    
    // Animate camera position (eased)
    const easeProgress = this.easeInOutCubic(progress);
    this.camera.position.lerpVectors(
      this.initialCameraPosition, 
      this.finalCameraPosition, 
      easeProgress
    );
    
    // Rotate the board/camera during intro
    if (this.controls) {
      const rotationProgress = Math.min(progress * 1.5, 1.0); // Finish rotation faster
      const rotationAngle = rotationProgress * Math.PI * 2; // Full 360 degree rotation
      
      const radius = this.controls.target.distanceTo(this.camera.position);
      const height = this.camera.position.y;
      
      // Update camera position in a circular path
      const x = centerX + Math.sin(rotationAngle) * radius;
      const z = centerZ + Math.cos(rotationAngle) * radius;
      
      this.camera.position.set(x, height, z);
      this.camera.lookAt(centerX, 0, centerZ);
      this.controls.update();
    }
    
    // Animate spotlights
    this.spotlights.forEach((spotlight, index) => {
      // Calculate spotlight movement
      const spotAngle = ((Date.now() / 500) + (index * Math.PI / 2.5)) % (Math.PI * 2);
      const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
      const radius = size * 0.7;
      
      // Move spotlight in a circular pattern
      const targetX = centerX + Math.cos(spotAngle) * radius * 0.5;
      const targetZ = centerZ + Math.sin(spotAngle) * radius * 0.5;
      
      // Point the spotlight at the target position
      spotlight.target.position.set(targetX, 0, targetZ);
      spotlight.target.updateMatrixWorld();
      
      // Fade out spotlights at the end of animation
      if (progress > 0.8) {
        const fadeOutProgress = (progress - 0.8) / 0.2;
        
        // Keep the last spotlight
        if (index < this.spotlights.length - 1) {
          spotlight.intensity = 1.0 - fadeOutProgress;
        } else {
          // Transform the last spotlight into a sun
          if (this.sunLight) {
            this.sunLight.intensity = 0.2 + (fadeOutProgress * 0.8); // Increase to full intensity
            
            // Move sun position
            const sunAngle = Math.PI / 4; // 45 degrees
            this.sunLight.position.set(
              Math.cos(sunAngle),
              1,
              Math.sin(sunAngle)
            ).normalize();
          }
        }
      }
    });
    
    // End the intro animation
    if (progress >= 1.0) {
      this.finishIntroAnimation();
    }
  }

  /**
   * Finish the intro animation and transition to normal mode
   */
  private finishIntroAnimation(): void {
    this.introAnimationInProgress = false;
    
    // Remove all spotlights except the last one
    for (let i = 0; i < this.spotlights.length - 1; i++) {
      const spotlight = this.spotlights[i];
      if (spotlight.parent) {
        this.scene!.remove(spotlight);
      }
    }
    
    // Enable user controls
    if (this.controls) {
      this.controls.enabled = true;
    }
    
    // Ensure sun light is at full intensity
    if (this.sunLight) {
      this.sunLight.intensity = 1.0;
      
      // Position sun light orthogonal to the camera view for good shadows
      const cameraDirection = new THREE.Vector3();
      this.camera!.getWorldDirection(cameraDirection);
      
      // Create orthogonal vector to camera direction
      const orthogonal = new THREE.Vector3(
        -cameraDirection.z,
        0.5,
        cameraDirection.x
      ).normalize();
      
      this.sunLight.position.copy(orthogonal);
    }
    
    // Increase ambient light for better overall lighting
    this.scene!.traverse((object) => {
      if (object instanceof THREE.AmbientLight) {
        object.intensity = 0.4;
      }
    });
    
    // If we have solved components from the maze solver, validate and raise them
    if (this.animatingPaths.length > 0) {
      const components = this.animatingPaths.map(path => path.component);
      this.validateAndRaiseSolvedComponents(components);
    }
  }

  /**
   * Easing function for smooth animation
   */
  private easeInOutCubic(t: number): number {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * Skip intro animation and go directly to the final state
   */
  skipIntroAnimation(): void {
    if (this.introAnimationInProgress) {
      this.finishIntroAnimation();
      
      // Center camera properly
      if (this.finalCameraPosition && this.camera) {
        this.camera.position.copy(this.finalCameraPosition);
        
        const bounds = this.calculateMazeBounds();
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
        
        this.camera.lookAt(centerX, 0, centerZ);
        
        if (this.controls) {
          this.controls.target.set(centerX, 0, centerZ);
          this.controls.update();
        }
      }
    }
  }

  /**
   * Validates a path to ensure each step is to an adjacent hexagon
   * and raises the component cells in the 3D view
   */
  public validateAndRaiseSolvedComponents(components: ProcessedConnComponent[]): void {
    if (!components.length || !this.hexGrid) return;
    
    console.log(`Validating and preparing ${components.length} path components for visualization`);
    
    // Sort components by path length (shortest first)
    components.sort((a, b) => a.pathLength - b.pathLength);
    
    // Validate and process each component
    components.forEach((component, componentIndex) => {
      // Skip components with no path or too short paths
      if (!component.path || component.path.length < 2) {
        console.warn('Component has no valid path:', component);
        return;
      }
      
      // Validate the path using cubic coordinates
      const isValid = this.validatePath(component.path);
      
      if (!isValid) {
        console.error('Path validation failed for component:', component);
        return;
      }
      
      // Calculate elevation based on path length and component index
      // Shorter paths are raised higher
      const elevation = 1 + (5 / (componentIndex + 1));
      
      // Find all cells in this component and raise them
      this.raiseCellsInComponent(component, elevation);
    });
  }

  /**
   * Validates a path to ensure each step moves to an adjacent hexagon
   */
  private validatePath(path: string[]): boolean {
    if (path.length < 2) return true;
    
    for (let i = 0; i < path.length - 1; i++) {
      const currentId = parseInt(path[i]);
      const nextId = parseInt(path[i + 1]);
      
      const currentAxial = this.getAxialFromLinearId(currentId);
      const nextAxial = this.getAxialFromLinearId(nextId);
      
      if (!currentAxial || !nextAxial) {
        console.error(`Failed to get axial coordinates for cells ${currentId} and ${nextId}`);
        return false;
      }
      
      // Convert to cubic coordinates (q, r, s) where s = -q-r
      const current = {
        q: currentAxial.q,
        r: currentAxial.r,
        s: -currentAxial.q - currentAxial.r
      };
      
      const next = {
        q: nextAxial.q,
        r: nextAxial.r,
        s: -nextAxial.q - nextAxial.r
      };
      
      // Calculate absolute differences in each coordinate
      const diffQ = Math.abs(current.q - next.q);
      const diffR = Math.abs(current.r - next.r);
      const diffS = Math.abs(current.s - next.s);
      
      // A valid move to an adjacent hex requires exactly two coordinates to change by 1
      // The sum of all differences should be 2 for a valid move
      if (diffQ + diffR + diffS !== 2) {
        console.error(`Invalid path step from ${currentId} to ${nextId}: not adjacent hexagons`);
        console.error(`Cubic coordinates: (${current.q},${current.r},${current.s}) to (${next.q},${next.r},${next.s})`);
        return false;
      }
    }
    
    return true;
  }

  /**
   * Raises all cells in a component to a specified elevation and updates their walls
   */
  private raiseCellsInComponent(component: ProcessedConnComponent, elevation: number): void {
    if (!this.hexGrid) return;
    
    // Get all linearIds in the component
    const cellIds = component.pixels.map(pixel => pixel.linearId);
    const cellSet = new Set(cellIds); // For faster lookup
    
    // For each cell in the component
    cellIds.forEach(linearId => {
      const axial = this.getAxialFromLinearId(linearId);
      if (!axial) return;
      
      // Find the cell in the hex grid
      const cellHash = this.hexGrid.cellToHash({
        q: axial.q,
        r: axial.r,
        s: -axial.q - axial.r
      });
      
      const cell = this.hexGrid.cells[cellHash];
      if (cell) {
        // Update the height of the cell
        cell.h = elevation;
        
        // If the cell has a corresponding tile, raise it
        if (cell.tile && cell.tile.mesh) {
          // Update the visual position
          cell.tile.position.y = elevation;
        }
      }
    });
    
    // After raising all cells, update the walls
    this.updateWallsForRaisedComponent(cellSet, elevation);
  }

  /**
   * Updates walls for a raised component to match the new elevation
   */
  private updateWallsForRaisedComponent(componentCellIds: Set<number>, elevation: number): void {
    if (!this.wallGroup || !this.pathMap) return;
    
    // Remove all existing walls
    while (this.wallGroup.children.length > 0) {
      const wall = this.wallGroup.children[0];
      this.wallGroup.remove(wall);
      if (wall instanceof THREE.Mesh) {
        wall.geometry.dispose();
        if (wall.material instanceof THREE.Material) {
          wall.material.dispose();
        }
      }
    }
    
    const wallMaterial = new THREE.MeshPhongMaterial({
      color: 0x00ff44, // Neon green
      emissive: 0x008822, // Slight glow
      specular: 0xffffff, // Strong specular highlights 
      shininess: 100,
      side: THREE.DoubleSide
    });
    
    const defaultWallHeight = 3;
    const wallThickness = 0.3;
    
    // Create a map to quickly look up cells by linearId
    const cellsById = new Map<number, PathCell>();
    this.pathMap.cells.forEach(cell => {
      cellsById.set(cell.linearId, cell);
    });
    
    // Process each cell to create walls with proper heights
    this.pathMap.cells.forEach(cell => {
      const isElevated = componentCellIds.has(cell.linearId);
      const cellHeight = isElevated ? elevation : 1;
      
      const axial = this.getAxialFromLinearId(cell.linearId);
      if (!axial) return;
      
      const cellHash = this.hexGrid.cellToHash({
        q: axial.q,
        r: axial.r,
        s: -axial.q - axial.r
      });
      
      const hexCell = this.hexGrid.cells[cellHash];
      if (!hexCell) return;
      
      // Check each direction
      for (let i = 0; i < 6; i++) {
        // Skip if there's an open path in this direction
        if (cell.openPaths.includes(i)) continue;
        
        // Calculate neighbor coordinates
        const dir = this.hexDirections[i];
        const neighborQ = hexCell.q + dir.q;
        const neighborR = hexCell.r + dir.r;
        const neighborS = hexCell.s + dir.s;
        
        // Check if neighbor exists in our grid
        const neighborHash = this.hexGrid.cellToHash({q: neighborQ, r: neighborR, s: neighborS});
        const neighborExists = !!this.hexGrid.cells[neighborHash];
        
        if (neighborExists) {
          // Find the neighbor's linear ID
          const neighborLinearId = this.hexGrid.cells[neighborHash].userData?.linearId;
          
          if (neighborLinearId) {
            const neighborIsElevated = componentCellIds.has(neighborLinearId);
            
            // Determine wall height and position based on cell elevations
            const wallHeight = defaultWallHeight;
            let wallY = 0;
            
            if (isElevated && neighborIsElevated) {
              // Both cells are elevated - wall should be at elevation
              wallY = elevation;
            } else if (isElevated) {
              // Current cell is elevated, neighbor is not
              // Wall should be at half height to connect the two levels
              wallY = elevation / 2;
            } else if (neighborIsElevated) {
              // Neighbor is elevated, current cell is not
              // Wall should be at half height to connect the two levels
              wallY = elevation / 2;
            }
            
            // Create the wall with custom height and position
            this.createWallBetweenCellsWithHeight(
              hexCell, 
              {q: neighborQ, r: neighborR, s: neighborS}, 
              i, 
              wallHeight, 
              wallThickness, 
              wallMaterial,
              wallY
            );
          }
        }
      }
    });
  }

  /**
   * Create a wall between two cells with a specified height and y-position
   */
  private createWallBetweenCellsWithHeight(
    cell1: any, 
    cell2: any, 
    direction: number, 
    height: number, 
    thickness: number, 
    material: THREE.Material,
    yPosition: number
  ): void {
    if (!this.wallGroup || !this.hexGrid) return;
    
    // Get cell positions
    const pos1 = this.hexGrid.cellToPixel(cell1);
    
    // Calculate wall position (midpoint between cells)
    const dir = this.hexDirections[direction];
    const wallPos = new THREE.Vector3(
      pos1.x + dir.q * this.hexGrid.cellSize * 0.75,
      height / 2 + yPosition, // Position the wall at the specified y position
      pos1.z + (dir.s - dir.r) * this.hexGrid.cellSize * 0.5 * vg.SQRT3
    );
    
    // Calculate wall rotation
    const angle = (direction * 60) * vg.DEG_TO_RAD;
    
    // Create wall geometry
    const wallGeo = new THREE.BoxGeometry(
      this.hexGrid.cellSize * 0.95, // Length
      height,                        // Height
      thickness                      // Thickness
    );
    
    const wallMesh = new THREE.Mesh(wallGeo, material);
    wallMesh.position.copy(wallPos);
    wallMesh.rotation.y = angle;
    
    // Enable shadows
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    
    this.wallGroup.add(wallMesh);
  }

  /**
   * Animate paths through the maze based on connected components
   * This provides the camelCase version of VisualizePaths for consistency
   * and integrates the validation step
   */
  public animatePaths(components: ProcessedConnComponent[]): void {
    // First validate the paths (even if the animation is still running)
    this.validateAndRaiseSolvedComponents(components);
    
    // Then call the original method to visualize the paths
    this.VisualizePaths(components);
  }

  /**
   * Returns whether the intro animation is currently in progress
   */
  public isIntroAnimationInProgress(): boolean {
    return this.introAnimationInProgress;
  }

  /**
   * Create a visual segment between two cells in a path
   */
  private createPathSegment(
    fromCellId: string, 
    toCellId: string, 
    meshes: THREE.Object3D[],
    color: THREE.Color
  ): void {
    if (!this.scene || !this.hexGrid) return;
    
    // Convert cell IDs to axial coordinates
    const fromAxial = this.getAxialFromLinearId(parseInt(fromCellId));
    const toAxial = this.getAxialFromLinearId(parseInt(toCellId));
    
    if (!fromAxial || !toAxial) {
      console.error(`Could not find axial coordinates for cells ${fromCellId} and ${toCellId}`);
      return;
    }
    
    // Find the cells in the hex grid
    const fromHash = this.hexGrid.cellToHash({
      q: fromAxial.q,
      r: fromAxial.r,
      s: -fromAxial.q - fromAxial.r
    });
    
    const toHash = this.hexGrid.cellToHash({
      q: toAxial.q,
      r: toAxial.r,
      s: -toAxial.q - toAxial.r
    });
    
    const fromCell = this.hexGrid.cells[fromHash];
    const toCell = this.hexGrid.cells[toHash];
    
    if (!fromCell || !toCell) {
      console.error(`Could not find cells in hex grid for ${fromCellId} and ${toCellId}`);
      return;
    }
    
    // Get positions of the cells
    const fromPos = this.hexGrid.cellToPixel(fromCell);
    const toPos = this.hexGrid.cellToPixel(toCell);
    
    // Get the height of the cells
    // If the cells have been raised as part of a component, we want to position
    // the path segment at that height
    const fromHeight = fromCell.h || 1;
    const toHeight = toCell.h || 1;
    
    // Position the path segment slightly above the cells to avoid z-fighting
    const segmentHeight = Math.max(fromHeight, toHeight) + 0.1;
    
    // Create a vector between the two points
    const direction = new THREE.Vector3(
      toPos.x - fromPos.x,
      0, // Keep the y component at 0 to make it horizontal
      toPos.z - fromPos.z
    );
    
    // Calculate the length of the path segment
    const length = direction.length();
    
    // Normalize the direction vector
    direction.normalize();
    
    // Create material for the path segment
    const material = new THREE.MeshPhongMaterial({
      color: color,
      emissive: color.clone().multiplyScalar(0.3),
      shininess: 30,
      transparent: true,
      opacity: 0.8
    });
    
    // Create a cylinder geometry for the path segment
    // We use a cylinder rotated to point from one cell to another
    const radius = this.hexGrid.cellSize * 0.15; // Adjust this to control path thickness
    const geometry = new THREE.CylinderGeometry(
      radius, // radiusTop
      radius, // radiusBottom
      length, // height (use the distance between cells)
      8,      // radialSegments (octagonal prism)
      1,      // heightSegments
      false   // openEnded
    );
    
    // Create the mesh
    const cylinder = new THREE.Mesh(geometry, material);
    
    // Position the cylinder at the midpoint between the cells
    cylinder.position.set(
      (fromPos.x + toPos.x) / 2,
      segmentHeight,
      (fromPos.z + toPos.z) / 2
    );
    
    // By default, the cylinder's axis is along the Y-axis
    // We need to rotate it to align with our direction vector
    
    // First, we rotate 90 degrees around X to make the cylinder axis along Z
    cylinder.rotateX(Math.PI / 2);
    
    // Then calculate the rotation needed to align with our direction
    const xzAngle = Math.atan2(direction.z, direction.x);
    cylinder.rotateY(xzAngle);
    
    // Enable shadows
    cylinder.castShadow = true;
    cylinder.receiveShadow = true;
    
    // Add to scene
    this.scene.add(cylinder);
    
    // Store the mesh for later cleanup
    meshes.push(cylinder);
    
    // Also store in our path meshes map with a unique key
    const key = `${fromCellId}-${toCellId}`;
    this.pathMeshes.set(key, cylinder);
  }

  /**
   * Animate the next step in the path
   */
  private animateNextPathStep(): void {
    // Implementation would go here if needed
    // This method seems to be referenced but not implemented in the existing code
  }
}


