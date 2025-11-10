import * as THREE from 'three';
import * as TWEEN from '@tweenjs/tween.js';
import { AnimationHandler } from './animation-interfaces';

export class CameraAnimator implements AnimationHandler {
  isActive: boolean = false;
  private camera: THREE.Camera;
  private tweenGroup: TWEEN.Group;
  private activeTween: TWEEN.Tween<any> | null = null;

  constructor(camera: THREE.Camera, tweenGroup: TWEEN.Group) {
    this.camera = camera;
    this.tweenGroup = tweenGroup;
  }

  start(): void {
    this.isActive = true;
  }

  stop(): void {
    this.isActive = false;
    if (this.activeTween) {
      this.activeTween.stop();
      this.activeTween = null;
    }
  }

  update(time: number, delta: number): void {
    // Camera animations are driven by tweens
  }

  spiralPath(
    startPos: THREE.Vector3,
    endPos: THREE.Vector3,
    lookAt: THREE.Vector3,
    duration: number,
    onComplete?: () => void
  ): void {
    if (this.activeTween) { this.activeTween.stop(); }
    const spiralPoints: THREE.Vector3[] = [];
    const numPoints = 60;
    const initialDistance = startPos.distanceTo(lookAt);
    const revolutions = 1.5;
    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints;
      const angle = t * Math.PI * 2 * revolutions;
      const radius = initialDistance * (1 - t * 0.8);
      const height = startPos.y - (startPos.y - endPos.y) * t;
      spiralPoints.push(new THREE.Vector3(
        lookAt.x + Math.cos(angle) * radius,
        height,
        lookAt.z + Math.sin(angle) * radius
      ));
    }
    spiralPoints.push(endPos.clone());
    const progress = { t: 0 };
    this.activeTween = new TWEEN.Tween(progress, this.tweenGroup)
      .to({ t: 1 }, duration)
      .easing(TWEEN.Easing.Cubic.InOut)
      .onUpdate(() => {
        const index = Math.min(Math.floor(progress.t * numPoints), numPoints);
        const fraction = progress.t * numPoints - index;
        const currentPoint = spiralPoints[index];
        const nextPoint = spiralPoints[Math.min(index + 1, spiralPoints.length - 1)];
        const x = currentPoint.x + (nextPoint.x - currentPoint.x) * fraction;
        const y = currentPoint.y + (nextPoint.y - currentPoint.y) * fraction;
        const z = currentPoint.z + (nextPoint.z - currentPoint.z) * fraction;
        this.camera.position.set(x, y, z);
        const lookAheadIndex = Math.min(Math.floor(progress.t * numPoints) + 3, numPoints);
        const lookPoint = spiralPoints[lookAheadIndex];
        const lookTarget = new THREE.Vector3(
          lookAt.x + (lookPoint.x - lookAt.x) * 0.2,
          0,
          lookAt.z + (lookPoint.z - lookAt.z) * 0.2
        );
        this.camera.lookAt(lookTarget);
      })
      .onComplete(() => {
        this.camera.lookAt(lookAt);
        this.activeTween = null;
        if (onComplete) { onComplete(); }
      })
      .start();
  }

  focusOn(target: THREE.Vector3, distance: number, duration: number = 1000): Promise<void> {
    return new Promise(resolve => {
      if (this.activeTween) { this.activeTween.stop(); }
      const startPos = this.camera.position.clone();
      const angle = Math.PI / 4;
      const endPos = new THREE.Vector3(
        target.x - distance * Math.cos(angle),
        distance * Math.sin(angle),
        target.z
      );
      const position = { x: startPos.x, y: startPos.y, z: startPos.z };
      this.activeTween = new TWEEN.Tween(position, this.tweenGroup)
        .to({ x: endPos.x, y: endPos.y, z: endPos.z }, duration)
        .easing(TWEEN.Easing.Cubic.InOut)
        .onUpdate(() => {
          this.camera.position.set(position.x, position.y, position.z);
          this.camera.lookAt(target);
        })
        .onComplete(() => {
          this.camera.lookAt(target);
          this.activeTween = null;
          resolve();
        })
        .start();
    });
  }
  
  orbitCameraAround(target: THREE.Vector3, distance: number = 50, duration: number = 5000): void {
    if (!this.camera) return;
    
    // Create tween for orbit animation
    const orbitTween = { angle: 0 };
    new TWEEN.Tween(orbitTween, this.tweenGroup)
      .to({ angle: Math.PI * 2 }, duration)
      .easing(TWEEN.Easing.Linear.None)
      .onUpdate(() => {
        const x = target.x + Math.cos(orbitTween.angle) * distance;
        const z = target.z + Math.sin(orbitTween.angle) * distance;
        this.camera.position.set(x, this.camera.position.y, z);
        this.camera.lookAt(target);
      })
      .start();
  }
  
  flyThroughPath(path: THREE.Vector3[], duration: number = 10000): void {
    if (path.length < 2) return;
    
    const lookAheadOffset = 2; // How many points to look ahead
    const curvePoints = path.map(p => new THREE.Vector3(p.x, p.y + 2, p.z)); // Elevate camera
    const curve = new THREE.CatmullRomCurve3(curvePoints);
    
    const progress = { t: 0 };
    
    new TWEEN.Tween(progress, this.tweenGroup)
      .to({ t: 1 }, duration)
      .easing(TWEEN.Easing.Linear.None)
      .onUpdate(() => {
        // Position on curve
        const position = curve.getPointAt(progress.t);
        this.camera.position.copy(position);
        
        // Look ahead on the curve
        const lookT = Math.min(progress.t + lookAheadOffset / path.length, 1);
        const lookTarget = curve.getPointAt(lookT);
        this.camera.lookAt(lookTarget);
      })
      .start();
  }
}