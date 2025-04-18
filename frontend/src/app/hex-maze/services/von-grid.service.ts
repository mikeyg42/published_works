import { Injectable } from '@angular/core';
import VG, {
  VGScene,
  VGHexGrid,
  VGBoard,
  VGPathAnimator,
  VGLinkedList,
  VGTools,
} from '../../../assets/js/hex-grid/index';
import * as THREE from 'three';
import * as TWEEN from '@tweenjs/tween.js';


declare global {
  interface Window {
    TWEEN: typeof TWEEN;
    vg: VG;
  }
}

@Injectable({
  providedIn: 'root'
})
export class VonGridService {
  constructor() {
     window.TWEEN = TWEEN;
     window.vg = VG;
  }

  public renderer?: THREE.WebGLRenderer | THREE.WebGPURenderer;
  // Indicates whether the bundled script has been loaded.
  private scriptsLoaded = false;

  /**
   * Check if the von-grid library is loaded.
   */
  public isLoaded(): boolean {
    return typeof window.vg !== 'undefined';
  }
  
  /**
   * Returns the von-grid version.
   */
  public getVersion(): string {
    return window.vg?.VERSION || 'not loaded';
  }
  
  /**
   * Create a new HexGrid instance.
   */
  public createHexGrid(config: any): VGHexGrid {
    if (!this.isLoaded() || !window.vg.HexGrid) {
      throw new Error('HexGrid not available. Ensure the bundled von-grid library is loaded.');
    }
    return new window.vg.HexGrid(config);
  }
  
  /**
   * Create a new Board instance.
   */
  public createBoard(hexGrid: VGHexGrid, config: any): VGBoard {
    if (!this.isLoaded() || !window.vg.Board) {
      throw new Error('Board not available. Ensure the bundled von-grid library is loaded.');
    }
    return new window.vg.Board(hexGrid, config);
  }
  
  /**
   * Create a new Scene instance.
   */
  public createScene(sceneConfig: any, cameraConfig?: any): VGScene {
    if (!this.isLoaded() || !window.vg.Scene) {
      throw new Error('Scene not available. Ensure the bundled von-grid library is loaded.');
    }
    return new window.vg.Scene(sceneConfig, cameraConfig);
  }
  
  /**
   * Create a new PathAnimator instance.
   */
  public createPathAnimator(config: any): VGPathAnimator {
    if (!this.isLoaded() || !window.vg.PathAnimator) {
      throw new Error('PathAnimator not available. Ensure the bundled von-grid library is loaded.');
    }
    return new window.vg.PathAnimator(config);
  }
  
  /**
   * Initialize the Loader.
   */
  public initLoader(renderer: THREE.WebGLRenderer | THREE.WebGPURenderer): void {
    if (!this.isLoaded() || !window.vg.Loader) {
      throw new Error('Loader not available. Ensure the bundled von-grid library is loaded.');
    }
    this.renderer = renderer;
    window.vg.Loader.init(false, this.renderer);
  }
  
  /**
   * Create a new LinkedList instance.
   */
  public createLinkedList(): VGLinkedList {
    if (!this.isLoaded() || !window.vg.LinkedList) {
      throw new Error('LinkedList not available. Ensure the bundled von-grid library is loaded.');
    }
    return new window.vg.LinkedList();
  }
  
  /**
   * Access utility functions from Tools.
   */
  public getTools(): VGTools {
    if (!this.isLoaded() || !window.vg.Tools) {
      throw new Error('Tools not available. Ensure the bundled von-grid library is loaded.');
    }
    return window.vg.Tools;
  }
  
  /**
   * Get math constants.
   */
  public constants = {
    get PI(): number { return window.vg?.PI || Math.PI; },
    get TAU(): number { return window.vg?.TAU || (Math.PI * 2); },
    get DEG_TO_RAD(): number { return window.vg?.DEG_TO_RAD || 0.0174532925; },
    get RAD_TO_DEG(): number { return window.vg?.RAD_TO_DEG || 57.2957795; },
    get SQRT3(): number { return window.vg?.SQRT3 || Math.sqrt(3); }
  };

  /**
   * Loads the bundled von-grid library script.
   * Adjust the path to match your bundled file location.
   */
  public async loadScripts(): Promise<boolean> {
    if (this.scriptsLoaded) return true;
    
    // Ensure WebGPURenderer is defined
    if (typeof navigator !== 'undefined' && !!navigator.gpu && typeof (window as any).WebGPURenderer === 'undefined') {
      console.log('Defining WebGPURenderer before loading von-grid script');
      // Create a simple WebGPURenderer class if it doesn't exist
      (window as any).WebGPURenderer = class WebGPURenderer {
        constructor(parameters?: any) {
          console.log('WebGPURenderer constructor called with parameters:', parameters);
          this.parameters = parameters || {};
          this.domElement = document.createElement('canvas');
          this.shadowMap = { enabled: false, type: 0 };
        }
        
        parameters: any;
        domElement: HTMLCanvasElement;
        shadowMap: { enabled: boolean; type: number };
        
        render(scene: any, camera: any) {
          console.log('WebGPURenderer render called');
        }
        
        setSize(width: number, height: number, updateStyle?: boolean) {
          console.log('WebGPURenderer setSize called:', width, height, updateStyle);
          this.domElement.width = width;
          this.domElement.height = height;
          if (updateStyle) {
            this.domElement.style.width = width + 'px';
            this.domElement.style.height = height + 'px';
          }
        }
        
        setClearColor(color: any, alpha?: number) {
          console.log('WebGPURenderer setClearColor called:', color, alpha);
        }
        
        dispose() {
          console.log('WebGPURenderer dispose called');
        }
      };
    }
    
    const bundledScript = '/assets/js/hex-grid/src/vongrid.bundled.js';
    
    try {
      await this.loadScript(bundledScript);
      this.scriptsLoaded = true;
      return true;
    } catch (error) {
      console.error('Failed to load bundled von-grid script:', error);
      return false;
    }
  }

  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = (e) => reject(e);
      document.body.appendChild(script);
    });
  }
}
