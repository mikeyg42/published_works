// main_animation.ts
import { MazeSceneManager } from './maze-scene-manager';
import { NgZone, Injectable, Inject } from '@angular/core';
import { VonGridService } from './von-grid.service';
import { PathMap } from './maze-generator.service';
import { ProcessedConnComponent } from './maze-solver.service';
import * as THREE from 'three';
import { PathTracerService } from './pathTracing_webgpu.service';

/**
 * MainAnimation - Handles animation loop, DOM interactions, and delegates to MazeSceneManager
 * 
 * This class is responsible for:
 * 1. Setting up and managing the animation loop
 * 2. Handling DOM events (resize, etc.)
 * 3. Delegating scene management to MazeSceneManager
 */
@Injectable()
export class MainAnimation {
  private sceneManager: MazeSceneManager;
  private animationFrameId: number | null = null;
  private lastTime: number = 0;
  private isRunning: boolean = false;
  private resizeObserver: ResizeObserver | null = null;
  private ngZone: NgZone;
  private containerElement: HTMLElement;

  /**
   * Creates an animation controller that manages the scene lifecycle
   * @param canvas The canvas element to render to
   * @param containerElement The container for resize observations
   * @param ngZone Angular zone for running outside Angular
   * @param vonGridService Von-grid service for maze generation
   * @param PathTracerService Path tracing service for WebGPU rendering
   */
  constructor(
    canvas: HTMLCanvasElement, 
    containerElement: HTMLElement,
    ngZone: NgZone,
    vonGridService: VonGridService,
    pathTracerService: PathTracerService
  ) {
    this.ngZone = ngZone;
    this.containerElement = containerElement;
    
    // Create the scene manager with all required dependencies
    this.sceneManager = new MazeSceneManager(ngZone, vonGridService, pathTracerService);
    
    // Set up resize observer
    this.setupResizeObserver(containerElement);
    
    // Initialize the scene manager
    this.initializeScene(containerElement);
  }

  /**
   * Initialize the scene with the container
   */
  private async initializeScene(containerElement: HTMLElement): Promise<void> {
    await this.sceneManager.initialize(containerElement);
    this.handleResize(containerElement);
  }

  /**
   * Start the animation loop
   */
  public start(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.isRunning) {
        resolve();
        return;
      }
      
      console.log('Starting animation loop');
      this.isRunning = true;
      this.lastTime = 0;
      
      this.ngZone.runOutsideAngular(() => {
        this.animate(0);
        setTimeout(resolve, 100); // Give time for first few frames
      });
    });
  }

  /**
   * Stop the animation loop
   */
  public stop(): void {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Animation frame callback
   */
  private animate = (time: number): void => {
    if (!this.isRunning) return;
    
    this.animationFrameId = requestAnimationFrame(this.animate);
    
    // The update method is no longer needed as the scene manager has its own animation loop
    // We just need to ensure it's running
    try {
      // We don't need to call update as the service manages its own animation
    } catch (error) {
      console.error("Animation error:", error);
    }
  }

  /**
   * Set up the resize observer
   */
  private setupResizeObserver(containerElement: HTMLElement): void {
    this.resizeObserver = new ResizeObserver(() => this.handleResize(containerElement));
    this.resizeObserver.observe(containerElement);
  }

  /**
   * Handle resize events
   */
  private handleResize(containerElement: HTMLElement): void {
    if (this.sceneManager) {
      const width = containerElement.clientWidth;
      const height = containerElement.clientHeight;
      
      // The service is observing the container directly
    }
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    this.stop();
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    if (this.sceneManager) {
      this.sceneManager.dispose();
    }
  }

  // ----- Public proxies to SceneManager methods -----
  
  /**
   * Create a new maze from a path map
   */
  public async createMaze(pathMap: PathMap): Promise<void> {
    return this.sceneManager.createMaze(pathMap);
  }
  
  /**
   * Animate solution paths through the maze
   */
  public async animatePaths(components: ProcessedConnComponent[]): Promise<void> {
    return this.sceneManager.animatePaths(components);
  }
  
  /**
   * Skip the intro animation
   */
  public async skipIntroAnimation(): Promise<void> {
    return this.sceneManager.skipIntroAnimation();
  }
  
  /**
   * Check if WebGPU is being used
   */
  public isUsingWebGPU(): boolean {
    return this.sceneManager.isUsingWebGPU();
  }
  
  /**
   * Check if intro animation is in progress
   */
  public isIntroAnimationInProgress(): boolean {
    return this.sceneManager.isIntroAnimationInProgress();
  }
  
  /**
   * Check if the scene manager is initialized
   */
  public isInitialized(): boolean {
    return this.sceneManager.isInitialized();
  }
  
  /**
   * Focus camera on a specific point using CameraAnimator
   */
  public focusCameraOn(position: THREE.Vector3, distance?: number, duration?: number): Promise<void> {
    return this.sceneManager.focusCameraOn(position, distance, duration);
  }
  
  /**
   * Toggle shadows
   */
  public toggleShadows(enabled: boolean): void {
    this.sceneManager.toggleShadows(enabled);
  }
  
  /**
   * Export screenshot as data URL
   */
  public exportScreenshot(): string {
    return this.sceneManager.exportScreenshot();
  }
  
  /**
   * Reset camera to default position
   */
  public resetCamera(): void {
    this.sceneManager.resetCamera();
  }
}