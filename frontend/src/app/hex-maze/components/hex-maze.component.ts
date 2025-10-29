// hex-maze.component.ts
import {
  Component,
  ViewChild,
  ElementRef,
  OnInit,
  OnDestroy,
  AfterViewInit,
  NgZone,
  Inject,
  Injector
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MainAnimationGPU } from '../services/main_animation_gpu';
import { Subscription, fromEvent } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

@Component({
  selector: 'app-hex-maze',
  templateUrl: './hex-maze.component.html',
  styleUrls: ['./hex-maze.component.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule],
  host: { ngSkipHydration: 'true' }
})
export class HexMazeComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mazeCanvas', { static: true }) mazeCanvasRef!: ElementRef;

  initialized = false;
  isGenerating = false;
  isLoading = false;
  isAnimating = false;
  canvasWidth = 800;
  statusMessage: string | null = null;
  useLocalGeneration = false; // Toggle between API and local generation

  private width: number = 0;
  private height: number = 0;
  private lastWindowSize: { width: number; height: number } = { width: 0, height: 0 };

  // Maze data will come from backend via WebSocket
  private mazeData: any = null;

  // Animation and session management
  private sessionId: string | null = null;
  private animationWs: WebSocket | null = null;
  private isProcessingFrame = false;
  private frameBuffer: Blob[] = [];
  private maxBufferSize = 5; // Buffer up to 5 frames

  private animationFrameId: number | null = null;

  // Window resize handling
  private resizeTimeout: any = null;
  private resizeSubscription?: Subscription;

  // Main animation controller
  private mazeAnimator: MainAnimationGPU | null = null;

  constructor(
    private ngZone: NgZone,
    private injector: Injector
  ) {}

  ngOnInit(): void {

    this.initialize3DVisualizer();
    
    // Subscribe to window resize events
    this.resizeSubscription = fromEvent(window, 'resize')
      .pipe(
        debounceTime(500),
        distinctUntilChanged()
      )
      .subscribe(() => {
        if (!this.isGenerating && this.hasWindowSizeSignificantlyChanged()) {
          this.handleWindowResize();
        }
      });
  }


  ngAfterViewInit(): void {
    
    // Store initial window size
    this.lastWindowSize = {
      width: window.innerWidth,
      height: window.innerHeight
    };
  }
  showWebGPUError(msg: string) {
    // You can use Angular Material Snackbar, a modal, or just set a variable for the template
    alert('WebGPU Error: ' + msg);
  }
  ngOnDestroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }
    if (this.resizeSubscription) {
      this.resizeSubscription.unsubscribe();
    }
    if (this.animationWs) {
      this.animationWs.close();
    }
    // Clear frame buffer
    this.frameBuffer = [];
    this.mazeAnimator?.dispose();
  }

  /**
   * Initialize the 3D visualizer by creating a new MainAnimation instance
   * CRASH PREVENTION: Prevents duplicate initialization
   */
  async initialize3DVisualizer(): Promise<void> {
    // CRASH PREVENTION: Prevent duplicate initialization
    if (this.mazeAnimator) {
      console.warn('3D visualizer already initialized, skipping...');
      return;
    }
    
    const container = this.mazeCanvasRef.nativeElement;
    
    // Create MainAnimationGPU instance - supports both GPU and Three.js rendering
    this.ngZone.runOutsideAngular(() => {
      this.mazeAnimator = new MainAnimationGPU(
        container,
        this.ngZone
      );
      
      // Wait for the underlying SceneManager to finish initialization
      this.mazeAnimator.initializedPromise.then(() => {
      this.initialized = this.mazeAnimator?.isInitialized() || false;
        if (this.initialized) {
          // Now that everything is ready, generate the maze
          this.ngZone.run(() => this.generateNewMaze());
        }
      }).catch(error => {
        console.error('Failed to initialize 3D visualizer:', error);
        // CRASH PREVENTION: Clean up on failure
        if (this.mazeAnimator) {
          this.mazeAnimator.dispose();
          this.mazeAnimator = null;
    }
      });
    });
  }

  /**
   * Generate a new maze.
   * This method uses the MazeApiService to obtain maze data, converts it,
   * renders the 3D maze, and then solves it.
   */
  async generateNewMaze(): Promise<void> {
    if (!this.mazeCanvasRef || !this.mazeAnimator) return;
    if (this.isGenerating) {
      console.log('Maze generation already in progress, skipping...');
      return;
    }

    try {
      this.isGenerating = true;
      this.isLoading = true;
      this.isAnimating = false;
      this.statusMessage = 'Generating 3D maze and solving...';

      const container = this.mazeCanvasRef.nativeElement;
      this.width = container.clientWidth;
      this.height = container.clientHeight;

      // Maze generation now handled by backend
      // Just request maze generation and solution via WebSocket

      console.log('🧩 Step 2: Starting dual WebSocket animation...');
      this.isAnimating = true;
      this.statusMessage = 'Connecting to animation streams...';
      await this.startDualWebSocketAnimation(); // Connect to both backends
      console.log('✅ Step 2 complete: Animation streaming started');

      
    } finally {
      this.isGenerating = false;
      this.isLoading = false;
    }
    
  }

  /**
   * Start dual WebSocket animation using stateless backend approach
   */
  private async startDualWebSocketAnimation(): Promise<void> {
    try {
      // Generate session ID
      this.sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

      // Start WebSocket #1: Maze solving (Backend #1) - this will generate the maze too
      this.connectToMazeSolver();

      // Start WebSocket #2: Animation streaming (Backend #2)
      this.connectToAnimationStream();

    } catch (error) {
      console.error('WebSocket connection error:', error);
      this.statusMessage = `Connection error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
  /**
   * Connect to Backend #1 for maze solving via WebSocket
   */
  private connectToMazeSolver(): void {
    const wsUrl = 'ws://localhost:8000/api/maze-solver';
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to maze solver WebSocket');
      // Request maze generation and solution with device fingerprint
      ws.send(JSON.stringify({
        session_id: this.sessionId,
        canvas_width: this.width,
        canvas_height: this.height,
        device_fingerprint: 'frontend_client',
        user_agent: navigator.userAgent,
        accept_language: navigator.language
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'processing_started') {
        this.statusMessage = 'Generating maze and solving...';
      } else if (data.type === 'solution') {
        this.statusMessage = `Found ${data.solution_paths?.length || 0} solution paths`;
        this.mazeData = data.maze_data; // Store maze data received from backend
        console.log('Received maze and solution from Backend #1:', data);

        // Now create the 3D visualization from backend maze data
        if (this.mazeAnimator && this.mazeData) {
          this.mazeAnimator.createMaze(this.mazeData);
        }
      } else if (data.type === 'visualization_ready') {
        this.statusMessage = 'Visualization ready, starting animation stream...';
        console.log('Visualization ready from Backend #1');
      }
    };

    ws.onerror = (error) => {
      console.error('Maze solver WebSocket error:', error);
      this.statusMessage = 'Failed to connect to maze solver';
    };

    ws.onclose = () => {
      console.log('Maze solver WebSocket closed');
    };
  }

  /**
   * Connect to Backend #2 for animation frame streaming via WebSocket
   */
  private connectToAnimationStream(): void {
    const wsUrl = 'ws://localhost:3030/stream';
    this.animationWs = new WebSocket(wsUrl);

    this.animationWs.onopen = () => {
      console.log('Connected to animation stream WebSocket');
      // Send session ID to start streaming
      this.animationWs!.send(JSON.stringify({
        session_id: this.sessionId
      }));
    };

    this.animationWs.onmessage = (event) => {
      if (event.data instanceof Blob) {
        // Check if this is a small JSON message (pong) disguised as binary
        if (event.data.size < 1000) {
          // Small blobs might be JSON messages sent as binary
          event.data.text().then(text => {
            try {
              const data = JSON.parse(text);
              if (data.type === 'pong') {
                console.log('Received pong from animation server');
              } else if (data.type === 'ping') {
                this.animationWs!.send(JSON.stringify({ type: 'pong' }));
              }
            } catch (e) {
              // Not JSON, treat as frame data
              this.frameBuffer.push(event.data);
              this.manageFrameBuffer();
            }
          });
        } else {
          // Large blob, definitely a frame
          this.frameBuffer.push(event.data);
          this.manageFrameBuffer();
        }
      } else {
        // Text message (ping/pong or status)
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ping') {
            this.animationWs!.send(JSON.stringify({ type: 'pong' }));
          } else if (data.type === 'pong') {
            console.log('Received pong from animation server');
          }
        } catch (e) {
          console.log('Received non-JSON text from animation server:', event.data);
        }
      }
    };

    this.animationWs.onerror = (error) => {
      console.error('Animation stream WebSocket error:', error);
      this.statusMessage = 'Failed to connect to animation stream';
    };

    this.animationWs.onclose = () => {
      console.log('Animation stream WebSocket closed');
      this.isAnimating = false;
      this.statusMessage = 'Animation stream ended';
      this.animationWs = null;
    };
  }

  /**
   * Process frames from buffer sequentially
   */
  private manageFrameBuffer(): void {
    // If buffer is too large, remove oldest frame
    if (this.frameBuffer.length > this.maxBufferSize) {
      console.log(`Buffer overflow, dropping oldest frame (buffer size: ${this.frameBuffer.length})`);
      this.frameBuffer.shift();
    }

    // Start processing if not already processing
    if (!this.isProcessingFrame) {
      this.processFrameBuffer();
    }
  }

  private async processFrameBuffer(): Promise<void> {
    if (this.isProcessingFrame || this.frameBuffer.length === 0) {
      return;
    }

    this.isProcessingFrame = true;

    while (this.frameBuffer.length > 0) {
      const frameBlob = this.frameBuffer.shift()!;

      try {
        // Create blob URL and display frame
        const frameUrl = URL.createObjectURL(frameBlob);

        // Update the maze animator with the new frame
        if (this.mazeAnimator) {
          await this.mazeAnimator.displayGpuImage(frameUrl);
        }

        // Clean up the blob URL
        URL.revokeObjectURL(frameUrl);
      } catch (error) {
        console.error('Frame processing error:', error);
        // Continue processing remaining frames despite error
      }
    }

    this.isProcessingFrame = false;
  }

  /**
   * Legacy method - now redirects to buffer processing
   */
  private async handleAnimationFrame(frameBlob: Blob): Promise<void> {
    // This method is kept for backward compatibility
    // All frame handling now goes through the buffer
    this.frameBuffer.push(frameBlob);
    if (!this.isProcessingFrame) {
      this.processFrameBuffer();
    }
  }
  

  /**
   * Returns whether the window size has changed significantly.
   */
  private hasWindowSizeSignificantlyChanged(): boolean {
    const significantDifference = 100; // pixels
    const widthDiff = Math.abs(window.innerWidth - this.lastWindowSize.width);
    const heightDiff = Math.abs(window.innerHeight - this.lastWindowSize.height);
    return widthDiff > significantDifference || heightDiff > significantDifference;
  }

  /**
   * Handle window resize by updating the stored size and generating a new maze.
   */
  private handleWindowResize(): void {
    
    // Use ngZone to optimize resize handling
    this.ngZone.runOutsideAngular(() => {
      this.lastWindowSize = {
        width: window.innerWidth,
        height: window.innerHeight
      };
      
      if (this.resizeTimeout) {
        clearTimeout(this.resizeTimeout);
      }
      
      this.resizeTimeout = setTimeout(() => {
        this.ngZone.run(() => {
          this.generateNewMaze();
        });
      }, 100);
    });
  }

  /**
   * Button click handler to generate a new maze
   */
  onClick(): void {
    this.generateNewMaze();
  }
}
