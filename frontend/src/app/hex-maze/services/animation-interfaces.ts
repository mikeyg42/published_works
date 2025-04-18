import * as THREE from 'three';

export enum AnimationState {
  IDLE = 'idle',
  INTRO = 'intro',
  TRANSITION = 'transition',
  PATHS = 'paths'
}

export interface AnimationHandler {
  isActive: boolean;
  update(time: number, delta: number): void;
  start(): void;
  stop(): void;
}

// Animation manager interface
export interface IAnimationManager {
  start(): void;
  stop(): void;
  register(name: string, animation: AnimationHandler): void;
  unregister(name: string): void;
  getTweenGroup(name: string): any;
  setState(state: AnimationState): void;
  getState(): AnimationState;
  dispose(): void;
}

// Path animation configuration
export interface PathAnimationConfig {
  color: number;
  height: number;
  scene: any;
  hexGrid: any;
  useMarker?: boolean;
}

// Light animation configuration
export interface SpotlightConfig {
  color: number;
  intensity: number;
  distance: number;
  duration: number;
}

// Path animator interface
export interface IPathAnimator extends AnimationHandler {
  queuePathAnimation(component: any, color: THREE.Color): void;
  processNextPathInQueue(): void;
  preparePathCells(path: string[], color: THREE.Color): any[];
  raiseCellsInComponent(component: any, elevation: number, color: number | THREE.Color): void;
  pulseCell(cellId: number, color: number | THREE.Color): void;
}

// Lighting animator interface
export interface ILightingAnimator extends AnimationHandler {
  setMazeBounds(center: THREE.Vector3, size: number): void;
  createSpotlights(colors?: number[]): void;
  clearSpotlights(): void;
  transitionToNormalLighting(cameraDirection: THREE.Vector3): Promise<void>;
}

// Camera animator interface
export interface ICameraAnimator extends AnimationHandler {
  spiralPath(startPos: THREE.Vector3, endPos: THREE.Vector3, lookAt: THREE.Vector3, duration: number, onComplete?: () => void): void;
  focusOn(target: THREE.Vector3, distance: number, duration?: number): Promise<void>;
  orbitCameraAround(target: THREE.Vector3, distance?: number, duration?: number): void;
  flyThroughPath?(path: THREE.Vector3[], duration?: number): void;
}