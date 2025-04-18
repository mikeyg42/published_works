// WebGPURenderer typing for Three.js
// This is required because Three.js doesn't export WebGPURenderer type properly yet

import * as THREE from 'three';

// Extend THREE namespace to include WebGPURenderer
declare module 'three' {
  export class WebGPURenderer {
    constructor(parameters?: {
      canvas?: HTMLCanvasElement;
      context?: WebGLRenderingContext;
      alpha?: boolean;
      antialias?: boolean;
    });
    shadowMap: { enabled: boolean; type: number; };
    domElement: HTMLCanvasElement;
    render(scene: THREE.Scene, camera: THREE.Camera): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setClearColor(color: THREE.Color | string | number, alpha?: number): void;
    dispose(): void;
  }
} 