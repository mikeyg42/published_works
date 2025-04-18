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
    private pathTracerService: PathTracerService,
    private injector: Injector
  ) {}

  ngOnInit(): void {

    this.initializeVisualizer();
    
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
    
    this.generateNewMaze();
  
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
   */
  async initializeVisualizer(): Promise<void> {
    const container = this.mazeCanvasRef.nativeElement;
    
    // Create a canvas element for MainAnimation
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
    
    // Create MainAnimation instance with the canvas
    this.ngZone.runOutsideAngular(() => {
      this.mazeAnimator = new MainAnimation(
        canvas,
        container,
        this.ngZone,
        this.vonGridService,
        this.pathTracerService
      );
      
      this.initialized = this.mazeAnimator?.isInitialized() || false;
    });
    
    if (this.initialized && this.mazeAnimator) {
      this.statusMessage = `Renderer: ${this.mazeAnimator.isUsingWebGPU() ? 'WebGPU' : 'WebGL'}`;
    } else {
      this.statusMessage = 'Failed to initialize 3D renderer';
    }
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
      this.statusMessage = 'Generating maze...';

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

      // Render the 3D maze.
      await this.mazeAnimator.createMaze(this.pathMap);

      this.statusMessage = 'Solving maze...';
      
      // Solve the maze.
      await this.solveMaze();

      // Animate the solution paths.
      await this.animateMaze();
      
    } finally {
      this.isGenerating = false;
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
      this.solvedComponents = await this.mazeSolver.solveMaze(this.pathMap);
    
      this.statusMessage = `Found ${this.solvedComponents.length} solution path(s)`;
      return ;
    } catch (error) {
      console.error('Maze solving error:', error);
      this.statusMessage = `Solving error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
  private async animateMaze(): Promise<void> {
    if (!this.solvedComponents || !this.mazeAnimator) {
      this.statusMessage = 'No maze to animate';
      return;
    }
    try {
      if (this.isGenerating) {
        await this.mazeAnimator.animatePaths(this.solvedComponents);
      } else {
        this.statusMessage = 'Maze is not generating';
        console.error('Maze is not generating');
      }
    } catch (error) {
        console.error('Maze animation error:', error);
        this.statusMessage = `Animation error: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
