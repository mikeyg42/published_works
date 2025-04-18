import * as THREE from 'three';
import * as TWEEN from '@tweenjs/tween.js';
import { IPathAnimator } from './animation-interfaces';
import { PathTracerService } from './pathTracing_webgpu.service';

/**
 * PathAnimator - Handles queuing and tweening of path animations for maze routes
 */
export class PathAnimator implements IPathAnimator {
  isActive: boolean = false;
  private hexGrid: any;
  private scene: THREE.Scene;
  private internalPathAnimator: any;
  private animationQueue: any;
  private getAxialFromLinearId: (id: number) => { q: number; r: number } | undefined;
  private tweenGroup: TWEEN.Group;
  private pathTracer: PathTracerService | null = null;
  private updateTimeout: any = null;
  private sceneGroups: {
    tiles: THREE.Group;
    walls: THREE.Group;
    paths: THREE.Group;
    lights: THREE.Group;
    effects: THREE.Group;
  };

  constructor(
    scene: THREE.Scene,
    hexGrid: any,
    internalPathAnimator: any,
    animationQueue: any,
    tweenGroup: TWEEN.Group,
    getAxialFromLinearId: (id: number) => { q: number; r: number } | undefined,
    pathTracer?: PathTracerService,
    sceneGroups?: {
      tiles: THREE.Group;
      walls: THREE.Group;
      paths: THREE.Group;
      lights: THREE.Group;
      effects: THREE.Group;
    }
  ) {
    this.scene = scene;
    this.hexGrid = hexGrid;
    this.internalPathAnimator = internalPathAnimator;
    this.animationQueue = animationQueue;
    this.tweenGroup = tweenGroup;
    this.getAxialFromLinearId = getAxialFromLinearId;
    this.pathTracer = pathTracer || null;
    this.sceneGroups = sceneGroups || {
      tiles: new THREE.Group(),
      walls: new THREE.Group(),
      paths: new THREE.Group(),
      lights: new THREE.Group(),
      effects: new THREE.Group()
    };
  }

  start(): void {
    this.isActive = true;
  }

  stop(): void {
    this.isActive = false;
    while (this.animationQueue && this.animationQueue.length > 0) {
      this.animationQueue.shift();
    }
  }

  update(time: number, delta: number): void {
    throw new Error('Path animations are handled internally via tweens.');
  }

  queuePathAnimation(component: any, color: THREE.Color): void {
    if (!component.path || component.path.length < 2) return;
    const pathItem = {
      component,
      color,
      uniqueID: window.vg.LinkedList.generateID(),
      cells: []
    };
    this.animationQueue.add(pathItem);
    if (this.animationQueue.length === 1) {
      this.processNextPathInQueue();
    }
  }

  processNextPathInQueue(): void {
    if (this.animationQueue.length === 0) return;
    const pathItem = this.animationQueue.shift();
    const cells = this.preparePathCells(pathItem.component.path, pathItem.color);
    this.internalPathAnimator.animatePath(cells, {
      color: pathItem.color.getHex(),
      height: 1.5,
      scene: this.scene,
      hexGrid: this.hexGrid,
      useMarker: true
    });
    const self = this;
    this.internalPathAnimator.signal.addOnce(function(event: string) {
      if (event === 'complete' || event === 'cancelled') {
        setTimeout(() => { self.processNextPathInQueue(); }, 500);
      }
    });
    
    // Reset path tracer to account for new objects
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
      // Wait a moment for all path objects to be created
      setTimeout(() => {
        this.pathTracer?.buildSceneFromMaze({
          tiles: this.sceneGroups.tiles.children as THREE.Mesh[],
          walls: this.sceneGroups.walls.children as THREE.Mesh[],
          center: new THREE.Vector3(),
          size: 100,
          floorY: 0
        });
      }, 100);
    }
  }

  preparePathCells(path: string[], color: THREE.Color): any[] {
    const cells = [];
    for (let i = 0; i < path.length; i++) {
      try {
        const cellId = parseInt(path[i]);
        const axial = this.getAxialFromLinearId(cellId);
        if (axial) {
          const cellHash = this.hexGrid.cellToHash({
            q: axial.q,
            r: axial.r,
            s: -axial.q - axial.r
          });
          const hexCell = this.hexGrid.cells[cellHash];
          if (hexCell) {
            hexCell.uniqueID = hexCell.uniqueID || window.vg.LinkedList.generateID();
            cells.push(hexCell);
            if (hexCell.tile && hexCell.tile.mesh) {
              hexCell.h = 1.5;
              hexCell.tile.position.y = 1.5;
              
              // Enhanced lighting for path tracer
              if (hexCell.tile.mesh.material && !hexCell.tile.mesh.userData['enhancedForPathTracing']) {
                hexCell.tile.mesh.castShadow = true;
                hexCell.tile.mesh.receiveShadow = true;
                
                // Create a glowing effect for traced paths
                const emissiveColor = new THREE.Color(color).multiplyScalar(0.3);
                if (hexCell.tile.mesh.material instanceof THREE.MeshStandardMaterial) {
                  hexCell.tile.mesh.material.emissive = emissiveColor;
                  hexCell.tile.mesh.material.emissiveIntensity = 0.5;
                  hexCell.tile.mesh.userData['enhancedForPathTracing'] = true;
                }
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error processing path cell ${i}:`, error);
      }
    }
    return cells;
  }

  raiseCellsInComponent(component: any, elevation: number, color: number | THREE.Color): void {
    if (!component.pixels || !this.hexGrid) return;
    const cellIds = component.pixels.map((pixel: any) => pixel.linearId);
    
    let sceneChanged = false;
    
    cellIds.forEach((linearId: number) => {
      const axial = this.getAxialFromLinearId(linearId);
      if (!axial) return;
      const cellHash = this.hexGrid.cellToHash({
        q: axial.q,
        r: axial.r,
        s: -axial.q - axial.r
      });
      const cell = this.hexGrid.cells[cellHash];
      if (cell) {
        cell.h = elevation;
        if (cell.tile && cell.tile.mesh) {
          const startY = cell.tile.position.y || 0;
          new TWEEN.Tween({ y: startY }, this.tweenGroup)
            .to({ y: elevation }, 1000)
            .easing(TWEEN.Easing.Elastic.Out)
            .onUpdate(obj => { 
              cell.tile.position.y = obj.y; 
              sceneChanged = true;
            })
            .start();
            
          // Enhanced materials for path tracing
          if (cell.tile.mesh.material && !cell.tile.mesh.userData['enhancedForPathTracing']) {
            cell.tile.mesh.castShadow = true;
            cell.tile.mesh.receiveShadow = true;
            
            // Create a subtle glow for components
            const colorObj = color instanceof THREE.Color ? color : new THREE.Color(color);
            const emissiveColor = colorObj.clone().multiplyScalar(0.15);
            
            if (cell.tile.mesh.material instanceof THREE.MeshStandardMaterial) {
              // Create reflections and glow for path traced components
              cell.tile.mesh.material = cell.tile.mesh.material.clone();
              cell.tile.mesh.material.emissive = emissiveColor;
              cell.tile.mesh.material.emissiveIntensity = 0.3;
              cell.tile.mesh.material.roughness = 0.1;  // More reflective
              cell.tile.mesh.material.metalness = 0.8;  // More metallic
              cell.tile.mesh.userData['enhancedForPathTracing'] = true;
            }
          }
        }
        setTimeout(() => { this.pulseCell(linearId, color); }, 500);
      }
    });
    
    // Update path tracing scene if significant changes occurred
    if (sceneChanged && this.pathTracer) {
      // Debounce scene updates to avoid too frequent rebuilds
      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
      }
      
      this.updateTimeout = setTimeout(() => {
        this.pathTracer?.resetRendering();
        this.pathTracer?.buildSceneFromMaze({
          tiles: this.sceneGroups.tiles.children as THREE.Mesh[],
          walls: this.sceneGroups.walls.children as THREE.Mesh[],
          center: new THREE.Vector3(),
          size: 100,
          floorY: 0
        });
        this.updateTimeout = null;
      }, 500);
    }
  }

  pulseCell(cellId: number, color: number | THREE.Color): void {
    const axial = this.getAxialFromLinearId(cellId);
    if (!axial || !this.hexGrid) return;
    const cellHash = this.hexGrid.cellToHash({
      q: axial.q,
      r: axial.r,
      s: -axial.q - axial.r
    });
    const hexCell = this.hexGrid.cells[cellHash];
    if (hexCell && hexCell.tile && hexCell.tile.pulseLight) {
      hexCell.tile.pulseLight(this.scene, {
        color: color instanceof THREE.Color ? color.getHex() : color,
        intensity: 1.5,
        distance: 30,
        duration: 300
      });
      
      // Reset path tracer to capture the lighting effect
      if (this.pathTracer) {
        this.pathTracer.resetRendering();
      }
    }
  }
}
