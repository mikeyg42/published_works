import { Injectable, NgZone } from '@angular/core';

/**
 * ImageDisplayManager - Simple image display for GPU-rendered maze images
 *
 * This class replaces the complex MazeSceneManager for displaying
 * pre-rendered images from the Cloud Run GPU renderer.
 */
@Injectable({
  providedIn: 'root'
})
export class ImageDisplayManager {
  private container: HTMLElement | null = null;
  private imageElement: HTMLImageElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private initialized: boolean = false;

  constructor(private ngZone: NgZone) {}

  /**
   * Initialize the image display with a container element
   */
  async initialize(container: HTMLElement): Promise<boolean> {
    try {
      console.log('Initializing ImageDisplayManager...');
      this.container = container;

      // Clear any existing content
      container.innerHTML = '';

      // Create image element
      this.imageElement = document.createElement('img');
      this.imageElement.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        background: #0a0a12;
      `;

      container.appendChild(this.imageElement);

      // Set up resize observer
      this.setupResizeObserver();

      this.initialized = true;
      console.log('ImageDisplayManager initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize ImageDisplayManager:', error);
      return false;
    }
  }

  /**
   * Display a GPU-rendered maze image
   */
  async displayImage(imageUrl: string): Promise<void> {
    if (!this.imageElement) {
      throw new Error('ImageDisplayManager not initialized');
    }

    return new Promise((resolve, reject) => {
      if (!this.imageElement) {
        reject(new Error('No image element'));
        return;
      }

      this.imageElement.onload = () => {
        console.log('GPU-rendered image loaded successfully');
        resolve();
      };

      this.imageElement.onerror = (error) => {
        console.error('Failed to load GPU-rendered image:', error);
        reject(new Error('Failed to load image'));
      };

      console.log('Loading GPU-rendered image:', imageUrl);
      this.imageElement.src = imageUrl;
    });
  }

  /**
   * Show a placeholder or loading state
   */
  showPlaceholder(message: string = 'Generating maze...'): void {
    if (!this.container) return;

    // Create loading placeholder
    const placeholder = document.createElement('div');
    placeholder.style.cssText = `
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0a0a12;
      color: #ccccff;
      font-family: Arial, sans-serif;
      font-size: 18px;
      text-align: center;
    `;
    placeholder.textContent = message;

    // Replace content with placeholder
    this.container.innerHTML = '';
    this.container.appendChild(placeholder);
  }

  /**
   * Set up resize observer
   */
  private setupResizeObserver(): void {
    if (!this.container) return;

    const resizeHandler = () => {
      if (this.imageElement && this.container) {
        // Image will automatically scale due to CSS object-fit: contain
        console.log(`Image container resized to: ${this.container.clientWidth}x${this.container.clientHeight}`);
      }
    };

    this.resizeObserver = new ResizeObserver(resizeHandler);
    this.resizeObserver.observe(this.container);
  }

  /**
   * Check if the display manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    // Remove resize observer
    if (this.resizeObserver && this.container) {
      this.resizeObserver.unobserve(this.container);
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Clear container
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }

    // Clear references
    this.imageElement = null;
    this.initialized = false;

    console.log('ImageDisplayManager disposed');
  }
}