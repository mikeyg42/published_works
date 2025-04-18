import * as THREE from 'three';
import * as TWEEN from '@tweenjs/tween.js';
import { AnimationHandler, SpotlightConfig } from './animation-interfaces';
import { PathTracerService } from './pathTracing_webgpu.service';

export class LightingAnimator implements AnimationHandler {
  isActive: boolean = false;
  private scene: THREE.Scene;
  private lightsGroup: THREE.Group;
  private spotlights: THREE.SpotLight[] = [];
  private sunLight: THREE.DirectionalLight | null = null;
  private tweenGroup: TWEEN.Group;
  private center: THREE.Vector3 = new THREE.Vector3();
  private size: number = 10;
  private pathTracer: PathTracerService | null = null;

  constructor(
    scene: THREE.Scene, 
    lightsGroup: THREE.Group, 
    tweenGroup: TWEEN.Group,
    pathTracer?: PathTracerService
  ) {
    this.scene = scene;
    this.lightsGroup = lightsGroup;
    this.tweenGroup = tweenGroup;
    this.pathTracer = pathTracer || null;
    
    scene.traverse(object => {
      if (object instanceof THREE.DirectionalLight && !this.sunLight) {
        this.sunLight = object;
      }
    });
  }

  start(): void {
    this.isActive = true;
  }

  stop(): void {
    this.isActive = false;
  }

  setMazeBounds(center: THREE.Vector3, size: number): void {
    this.center = center;
    this.size = size;
  }

  createSpotlights(colors: number[] = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff]): void {
    this.clearSpotlights();
    const spotlightCount = colors.length;
    for (let i = 0; i < spotlightCount; i++) {
      const angle = (i / spotlightCount) * Math.PI * 2;
      const radius = this.size * 1.5;
      const spotlight = new THREE.SpotLight(
        colors[i % colors.length],
        1,
        this.size * 3,
        Math.PI / 8,
        0.5,
        2
      );
      
      // Enhanced for path tracing
      spotlight.castShadow = true;
      spotlight.shadow.mapSize.width = 1024;
      spotlight.shadow.mapSize.height = 1024;
      spotlight.shadow.bias = -0.0001;
      spotlight.shadow.radius = 4;
      spotlight.decay = 2; // Physical light decay
      
      spotlight.position.set(
        this.center.x + Math.cos(angle) * radius,
        this.size * 1.5,
        this.center.z + Math.sin(angle) * radius
      );
      spotlight.target.position.set(this.center.x, 0, this.center.z);
      this.lightsGroup.add(spotlight.target);
      
      this.lightsGroup.add(spotlight);
      this.spotlights.push(spotlight);
    }
    
    // Notify path tracer of scene changes if available
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
    }
  }

  clearSpotlights(): void {
    this.spotlights.forEach(spotlight => {
      if (spotlight.parent) { spotlight.parent.remove(spotlight); }
      if (spotlight.target.parent) { spotlight.target.parent.remove(spotlight.target); }
    });
    this.spotlights = [];
    
    // Notify path tracer of scene changes if available
    if (this.pathTracer) {
      this.pathTracer.resetRendering();
    }
  }

  update(time: number, delta: number): void {
    if (!this.isActive || this.spotlights.length === 0) return;
    
    let sceneChanged = false;
    
    this.spotlights.forEach((spotlight, index) => {
      const primaryFreq = 0.5 + (index * 0.1);
      const secondaryFreq = 1.7 + (index * 0.2);
      const tertiaryFreq = 2.3 + (index * 0.15);
      const primaryAngle = time * 0.001 * primaryFreq;
      const secondaryOsc = Math.sin(time * 0.001 * secondaryFreq) * 0.3;
      const tertiaryOsc = Math.cos(time * 0.001 * tertiaryFreq) * 0.2;
      const combinedAngle = primaryAngle + secondaryOsc + tertiaryOsc;
      const radius = this.size * 0.7;
      const xOffset = Math.sin(combinedAngle * 2) * radius * 0.3;
      const zOffset = Math.cos(combinedAngle * 3) * radius * 0.3;
      const targetX = this.center.x + Math.cos(combinedAngle) * radius * 0.5 + xOffset;
      const targetY = Math.abs(Math.sin(combinedAngle)) * 5;
      const targetZ = this.center.z + Math.sin(combinedAngle) * radius * 0.5 + zOffset;
      
      // Only set position if it's changed significantly to avoid path tracer reset
      const targetPos = spotlight.target.position;
      const posDist = Math.hypot(
        targetPos.x - targetX,
        targetPos.y - targetY,
        targetPos.z - targetZ
      );
      
      if (posDist > 0.5) {
        spotlight.target.position.set(targetX, targetY, targetZ);
        spotlight.target.updateMatrixWorld();
        sceneChanged = true;
      }
    });
    
    // Only reset path tracer if scene changes are significant
    if (sceneChanged && this.pathTracer && (time % 500 < 16)) {
      this.pathTracer.resetRendering();
    }
  }

  transitionToNormalLighting(cameraDirection: THREE.Vector3): Promise<void> {
    return new Promise(resolve => {
      while (this.spotlights.length > 1) {
        const spotlight = this.spotlights.shift();
        if (spotlight?.parent) { spotlight.parent.remove(spotlight); }
        if (spotlight?.target.parent) { spotlight.target.parent.remove(spotlight.target); }
      }
      
      if (this.sunLight) {
        const orthogonal = new THREE.Vector3(-cameraDirection.z, 0.5, cameraDirection.x).normalize();
        
        // Enhanced sunlight for path tracing
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 0.5;
        this.sunLight.shadow.camera.far = 500;
        this.sunLight.shadow.bias = -0.0001;
        
        // Customize shadow camera size for better quality
        const shadowCamSize = this.size * 2;
        this.sunLight.shadow.camera.left = -shadowCamSize;
        this.sunLight.shadow.camera.right = shadowCamSize;
        this.sunLight.shadow.camera.top = shadowCamSize;
        this.sunLight.shadow.camera.bottom = -shadowCamSize;
        
        new TWEEN.Tween({ intensity: this.sunLight.intensity }, this.tweenGroup)
          .to({ intensity: 1.0 }, 1000)
          .easing(TWEEN.Easing.Cubic.Out)
          .onUpdate(obj => { this.sunLight!.intensity = obj.intensity; })
          .start();
          
        const sunPos = this.sunLight.position.clone();
        new TWEEN.Tween({ x: sunPos.x, y: sunPos.y, z: sunPos.z }, this.tweenGroup)
          .to({ x: orthogonal.x, y: orthogonal.y, z: orthogonal.z }, 1000)
          .easing(TWEEN.Easing.Cubic.Out)
          .onUpdate(obj => {
            this.sunLight!.position.set(obj.x, obj.y, obj.z).normalize();
          })
          .start();
      }
      
      this.scene.traverse(object => {
        if (object instanceof THREE.AmbientLight) {
          new TWEEN.Tween({ intensity: object.intensity }, this.tweenGroup)
            .to({ intensity: 0.4 }, 1000)
            .easing(TWEEN.Easing.Cubic.Out)
            .onUpdate(obj => { object.intensity = obj.intensity; })
            .start();
        }
      });
      
      // Enhanced ambient occlusion for path tracing
      if (this.pathTracer) {
        new TWEEN.Tween({ intensity: 0.2 }, this.tweenGroup)
          .to({ intensity: 0.8 }, 1500)
          .easing(TWEEN.Easing.Cubic.Out)
          .onUpdate(obj => {
            this.pathTracer?.updateEnvironmentIntensity(obj.intensity);
          })
          .start();
      }
      
      setTimeout(() => {
        this.clearSpotlights();
        if (this.pathTracer) {
          this.pathTracer.resetRendering();
        }
        resolve();
      }, 1000);
    });
  }
}
