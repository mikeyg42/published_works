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
import { MazeSolverService, ProcessedConnComponent } from '../services/maze-solver.service';
import { MainAnimation } from '../services/main_animation';
import { MazeGeneratorService, PathMap } from '../services/maze-generator.service';
import { Subscription, fromEvent } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { VonGridService } from '../services/von-grid.service';
import { PathTracerService } from '../services/pathTracing_webgpu.service';

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

  // Maze data and conversion maps
  private pathMap: PathMap | null = null;

  // Animation and solved paths
  private solvedComponents: ProcessedConnComponent[] = [];
  private sessionId: string | null = null;

  private animationFrameId: number | null = null;

  // Window resize handling
  private resizeTimeout: any = null;
  private resizeSubscription?: Subscription;

  // Main animation controller
  private mazeAnimator: MainAnimation | null = null;

  constructor(
    //private mazeApi: MazeApiService,
    private mazeSolver: MazeSolverService,
    private mazeGenerator: MazeGeneratorService,
    private ngZone: NgZone,
    private vonGridService: VonGridService,
    public pathTracerService: PathTracerService,
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
    
    // Create MainAnimation instance - it will create its own canvas via MazeSceneManager
    this.ngZone.runOutsideAngular(() => {
      this.mazeAnimator = new MainAnimation(
        container,
        this.ngZone,
        this.vonGridService,
        this.pathTracerService
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

      // Generate maze locally using MazeGeneratorService
      this.pathMap = await this.mazeGenerator.generateMaze(
        this.width, 
        this.height
      );
    
      console.log('Received data from maze generator:', this.pathMap);

      // Short delay to allow the maze to be drawn (if needed)
      await new Promise(resolve => setTimeout(resolve, 400));

      // Start both operations in parallel and wait for them to finish
      await Promise.all([
        this.mazeAnimator.createMaze(this.pathMap), // Render the 3D maze
        this.solveMaze()                             // Solve the maze
      ]);

      // Now that the maze is drawn and solutions are ready, animate them.
      this.isAnimating = true; // Maybe set this before or after animation starts? Depends on desired UI behavior.
      this.statusMessage = 'Animating solution...';
      await this.animateMaze(); // Animate the solution paths.

      // Animation finished (or started, if animateMaze doesn't block until done)
      this.isAnimating = false; // Set to false when animation is complete
      this.statusMessage = 'animation finished!';

      
    } finally {
      this.isGenerating = false;
      this.isLoading = false;
    }
    
  }

  /**
   * Solve the current maze.
   */
  private async solveMaze(): Promise<void> {
    
    try {
      // Create the proper maze data structure expected by the solver
      if (!this.pathMap || !this.mazeAnimator) {
        this.statusMessage = 'No maze to solve';
        this.isGenerating = false;
        return;
      }
      
      // Solve the maze.
      const [solvedComponents, sessionId] = await this.mazeSolver.solveMaze(this.pathMap);
      this.solvedComponents = solvedComponents;
      this.sessionId = sessionId;
    
      this.statusMessage = `Found ${this.solvedComponents.length} solution path(s) for session ${sessionId}`;
      return ;
    } catch (error) {
      console.error('Maze solving error:', error);
      this.statusMessage = `Solving error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
  private async animateMaze(): Promise<void> {
    // 1) Fast guard clauses
    if (!this.mazeAnimator) {
      this.statusMessage = 'Renderer not ready';
      return;
    }
    if (!this.solvedComponents?.length) {
      this.statusMessage = 'No maze to animate';
      return;
    }

    // 2) Do the animation
    try {
      await this.mazeAnimator.animatePaths(this.solvedComponents);
    } catch (error) {
      console.error('Maze animation error:', error);
      this.statusMessage =
        `Animation error: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
