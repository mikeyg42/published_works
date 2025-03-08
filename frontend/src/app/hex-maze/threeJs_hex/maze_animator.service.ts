// maze-animator.service.ts
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { PathMap, PathCell } from './maze-generator.service';
import { ProcessedConnComponent } from './maze-solver.service';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/examples/jsm/renderers/WebGPURenderer';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

// You'll need to include the von-grid library files
// For this example, we'll assume the vg namespace is available globally

@Injectable({
  providedIn: 'root'
})
export class MazeAnimatorService implements OnDestroy {
  // Three.js components
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: WebGPURenderer;
  private controls: OrbitControls;
  
  // Hexagon grid from von-grid
  private hexGrid: any; // this will be vg.HexGrid
  
  // Animation properties
  private animationId: number | null = null;
  private mazeContainer: HTMLElement | null = null;
  private animationSpeed = 100; // ms between steps
  
  // Maze data
  private pathMap: PathMap | null = null;
  private solutionPaths: ProcessedConnComponent[] = [];
  
  // Visual elements
  private hexMeshes: THREE.Object3D[] = [];
  private pathMeshes: THREE.Object3D[] = [];
  private animatingPaths: {
    component: ProcessedConnComponent;
    currentStep: number;
    markers: THREE.Object3D[];
  }[] = [];
  
  constructor(private ngZone: NgZone) {}
  
  async initialize(container: HTMLElement): Promise<void> {
    this.mazeContainer = container;
    
    // Set up Three.js scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121212);
    
    // Set up camera
    const width = container.clientWidth;
    const height = container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    this.camera.position.set(0, 100, 100);
    this.camera.lookAt(0, 0, 0);
    
    // Initialize WebGPU renderer
    try {
      this.renderer = new WebGPURenderer({ antialias: true });
      await this.renderer.init();
    } catch (error) {
      console.error('WebGPU not supported:', error);
      // Fallback to WebGL renderer if WebGPU is not available
      this.renderer = new THREE.WebGLRenderer({ antialias: true }) as any;
    }
    
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    
    // Add controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    
    // Add lights
    const ambientLight = new THREE.AmbientLight(0x404040);
    this.scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(1, 1, 1);
    this.scene.add(directionalLight);
    
    // Initialize hex grid
    this.hexGrid = new vg.HexGrid({
      cellSize: 5 // We'll adjust this based on the maze dimensions
    });
    
    // Start animation loop
    this.animate();
    
    // Handle window resize
    window.addEventListener('resize', this.onWindowResize.bind(this));
  }
  
  renderMaze(pathMap: PathMap): void {
    // Clear any existing maze elements
    this.clearMaze();
    
    // Store the new pathMap
    this.pathMap = pathMap;
    
    // Configure hex grid based on maze dimensions
    const cellSize = this.calculateOptimalCellSize(pathMap);
    this.hexGrid = new vg.HexGrid({
      cellSize: cellSize
    });
    
    // Create cells for each hexagon in the maze
    pathMap.cells.forEach(pathCell => {
      const cell = new vg.Cell(
        pathCell.position.col - Math.floor(pathMap.dimensions.cols / 2), 
        pathCell.position.row - Math.floor(pathMap.dimensions.rows / 2), 
        -(pathCell.position.col - Math.floor(pathMap.dimensions.cols / 2)) - 
          (pathCell.position.row - Math.floor(pathMap.dimensions.rows / 2))
      );
      
      // Store reference to original pathCell
      cell.userData.pathCell = pathCell;
      
      // Set walkable based on open paths
      cell.walkable = pathCell.openPaths.length > 0;
      
      // Add to grid
      this.hexGrid.add(cell);
    });
    
    // Create materials
    const baseMaterial = new THREE.MeshPhongMaterial({
      color: 0x3b4252,
      flatShading: true
    });
    
    const wallMaterial = new THREE.MeshPhongMaterial({
      color: 0x4c566a,
      flatShading: true
    });
    
    // Generate 3D tiles for the grid
    const tiles = this.hexGrid.generateTiles({
      tileScale: 0.95,
      material: baseMaterial,
      extrudeSettings: {
        depth: 1,
        bevelEnabled: true,
        bevelSegments: 1,
        steps: 1,
        bevelSize: cellSize / 10,
        bevelThickness: cellSize / 20
      }
    });
    
    // Add walls between cells that don't have an open path
    this.addWallsBetweenCells(pathMap, cellSize, wallMaterial);
    
    // Add all tiles to the scene
    const mazeGroup = new THREE.Group();
    tiles.forEach(tile => {
      mazeGroup.add(tile.mesh);
      this.hexMeshes.push(tile.mesh);
    });
    
    this.scene.add(mazeGroup);
    
    // Center camera on maze
    this.centerCameraOnMaze(pathMap);
  }
  
  /**
   * Renders the solution paths on the maze
   */
  renderSolutionPaths(solutions: ProcessedConnComponent[]): void {
    this.solutionPaths = solutions;
    
    // Clear any existing path visualization
    this.clearPaths();
    
    // Create materials for the paths
    const pathMaterial = new THREE.MeshPhongMaterial({
      color: 0x88c0d0,
      transparent: true,
      opacity: 0.7,
      flatShading: true
    });
    
    // Create animated path indicators for each solution
    this.solutionPaths.forEach(component => {
      // Skip components with no path or very short paths
      if (!component.path || component.path.length < 2) return;
      
      const markers: THREE.Object3D[] = [];
      
      // Create a marker for each step in the path (to be revealed during animation)
      component.path.forEach((nodeId, index) => {
        const cell = this.hexGrid.cells[nodeId];
        if (!cell) return;
        
        // Create a slightly elevated marker
        const marker = this.createPathMarker(cell, pathMaterial.clone());
        marker.visible = index === 0; // Only show the first one initially
        this.scene.add(marker);
        markers.push(marker);
        this.pathMeshes.push(marker);
      });
      
      // Setup animation state
      this.animatingPaths.push({
        component,
        currentStep: 0,
        markers
      });
    });
    
    // Start animating the paths
    this.animatePaths();
  }
  
  /**
   * Animated revealing of solution paths
   */
  private animatePaths(): void {
    if (this.animatingPaths.length === 0) return;
    
    let allComplete = true;
    
    this.animatingPaths.forEach(path => {
      if (path.currentStep < path.markers.length - 1) {
        allComplete = false;
        
        // Animate the next step after a delay
        setTimeout(() => {
          path.currentStep++;
          path.markers[path.currentStep].visible = true;
          
          // Create a line connecting this marker to the previous one
          if (path.currentStep > 0) {
            const prevMarker = path.markers[path.currentStep - 1];
            const currMarker = path.markers[path.currentStep];
            
            const lineMaterial = new THREE.LineBasicMaterial({
              color: 0x88c0d0,
              linewidth: 2
            });
            
            const lineGeometry = new THREE.BufferGeometry().setFromPoints([
              prevMarker.position.clone(),
              currMarker.position.clone()
            ]);
            
            const line = new THREE.Line(lineGeometry, lineMaterial);
            this.scene.add(line);
            this.pathMeshes.push(line);
          }
          
          // Continue animating if not done
          if (path.currentStep < path.markers.length - 1) {
            this.animatePaths();
          }
        }, this.animationSpeed);
      }
    });
    
    // If all animations are complete, emit an event or take further action
    if (allComplete) {
      console.log('All path animations complete');
    }
  }
  
  /**
   * Creates a visual marker for a path step
   */
  private createPathMarker(cell: any, material: THREE.Material): THREE.Object3D {
    const geometry = new THREE.SphereGeometry(this.hexGrid.cellSize * 0.3, 16, 16);
    const marker = new THREE.Mesh(geometry, material);
    
    // Position the marker at the cell's location, slightly elevated
    const pos = this.hexGrid.cellToPixel(cell);
    marker.position.set(pos.x, pos.y + this.hexGrid.cellSize * 0.5, pos.z);
    
    return marker;
  }
  
  /**
   * Calculate optimal cell size based on maze dimensions
   */
  private calculateOptimalCellSize(pathMap: PathMap): number {
    const maxDimension = Math.max(pathMap.dimensions.rows, pathMap.dimensions.cols);
    // Scale inversely with maze size, with reasonable bounds
    return Math.max(2, Math.min(10, 40 / maxDimension));
  }
  
  /**
   * Add walls between cells that don't have an open path
   */
  private addWallsBetweenCells(pathMap: PathMap, cellSize: number, material: THREE.Material): void {
    const wallHeight = cellSize * 1.5;
    
    // Create a map of connections between cells
    const connections = new Map<string, number[]>();
    
    pathMap.cells.forEach(cell => {
      connections.set(cell.linearId.toString(), cell.openPaths);
    });
    
    // For each cell, check all 6 directions
    pathMap.cells.forEach(pathCell => {
      const cell = this.hexGrid.cells[pathCell.linearId];
      if (!cell) return;
      
      // Check each direction
      for (let dir = 0; dir < 6; dir++) {
        // Skip if there's an open path in this direction
        if (pathCell.openPaths.includes(dir)) continue;
        
        // Create a wall in this direction
        const wallGeometry = new THREE.BoxGeometry(
          cellSize * 0.1, 
          wallHeight, 
          cellSize * 0.8
        );
        
        const wall = new THREE.Mesh(wallGeometry, material);
        
        // Position the wall between this cell and the neighbor in this direction
        const pos = this.hexGrid.cellToPixel(cell);
        wall.position.set(pos.x, pos.y + wallHeight / 2, pos.z);
        
        // Rotate the wall to align with the hex direction
        wall.rotation.y = (dir * Math.PI / 3) + Math.PI / 6;
        
        // Move the wall to the edge of the hex
        wall.translateZ(cellSize * 0.85);
        
        this.scene.add(wall);
        this.hexMeshes.push(wall);
      }
    });
  }
  
  /**
   * Center the camera on the maze
   */
  private centerCameraOnMaze(pathMap: PathMap): void {
    // Find the center of the maze
    const maxDimension = Math.max(pathMap.dimensions.rows, pathMap.dimensions.cols);
    const distance = maxDimension * this.hexGrid.cellSize * 3;
    
    // Position camera to view the entire maze
    this.camera.position.set(distance, distance, distance);
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  }
  
  /**
   * Clear the current maze
   */
  private clearMaze(): void {
    // Remove all hex meshes from the scene
    this.hexMeshes.forEach(mesh => {
      this.scene.remove(mesh);
      if (mesh instanceof THREE.Mesh) {
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else if (mesh.material) {
          mesh.material.dispose();
        }
      }
    });
    
    this.hexMeshes = [];
    
    // Reset hex grid
    if (this.hexGrid) {
      this.hexGrid.dispose();
    }
    
    // Clear paths as well
    this.clearPaths();
  }
  
  /**
   * Clear the current solution paths
   */
  private clearPaths(): void {
    // Remove all path meshes from the scene
    this.pathMeshes.forEach(mesh => {
      this.scene.remove(mesh);
      if (mesh instanceof THREE.Mesh) {
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else if (mesh.material) {
          mesh.material.dispose();
        }
      }
    });
    
    this.pathMeshes = [];
    this.animatingPaths = [];
  }
  
  /**
   * Main animation loop
   */
  private animate(): void {
    this.ngZone.runOutsideAngular(() => {
      this.animationId = requestAnimationFrame(() => this.animate());
      
      // Update controls
      if (this.controls) {
        this.controls.update();
      }
      
      // Render the scene
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }
    });
  }
  
  /**
   * Handle window resize
   */
  private onWindowResize(): void {
    if (!this.mazeContainer || !this.camera || !this.renderer) return;
    
    const width = this.mazeContainer.clientWidth;
    const height = this.mazeContainer.clientHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setSize(width, height);
  }
  
  /**
   * Clean up resources when service is destroyed
   */
  ngOnDestroy(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    
    window.removeEventListener('resize', this.onWindowResize);
    
    this.clearMaze();
    
    if (this.renderer && this.mazeContainer) {
      this.mazeContainer.removeChild(this.renderer.domElement);
    }
    
    this.renderer?.dispose();
  }
}