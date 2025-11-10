import * as TWEEN from '@tweenjs/tween.js';
import { AnimationState, AnimationHandler, IAnimationManager } from './animation-interfaces';

/**
 * Shared animation manager that maintains tween groups and registered animations
 */
export class AnimationManager implements IAnimationManager {
  private state: AnimationState = AnimationState.IDLE;
  private animations: Map<string, AnimationHandler> = new Map();
  private tweenGroups: Record<string, TWEEN.Group> = {};
  private isRunning: boolean = false;
  private lastTime: number = 0;
  private frameId: number | null = null;

  constructor() {
    this.tweenGroups = {
      camera: new TWEEN.Group(),
      lights: new TWEEN.Group(),
      paths: new TWEEN.Group(),
      intro: new TWEEN.Group()
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = 0;
    const animate = (time: number) => {
      if (!this.isRunning) return;
      this.frameId = requestAnimationFrame(animate);
      const delta = this.lastTime ? (time - this.lastTime) / 1000 : 0;
      this.lastTime = time;
      try {
        this.update(time, delta);
      } catch (error) {
        console.error("Animation error:", error);
      }
    };
    this.frameId = requestAnimationFrame(animate);
  }

  stop(): void {
    this.isRunning = false;
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  private update(time: number, delta: number): void {
    Object.values(this.tweenGroups).forEach(group => group.update(time));
    this.animations.forEach(animation => {
      if (animation.isActive) {
        animation.update(time, delta);
      }
    });
  }

  register(name: string, animation: AnimationHandler): void {
    this.animations.set(name, animation);
  }

  unregister(name: string): void {
    this.animations.delete(name);
  }

  getTweenGroup(name: string): TWEEN.Group {
    return this.tweenGroups[name] || this.tweenGroups['intro'];
  }

  setState(state: AnimationState): void {
    this.state = state;
  }

  getState(): AnimationState {
    return this.state;
  }

  dispose(): void {
    this.stop();
    this.animations.clear();
  }
} 