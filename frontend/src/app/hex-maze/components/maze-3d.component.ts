// maze-visualizer.component.ts
import { Component, ElementRef, OnInit, OnDestroy, ViewChild, NgZone } from '@angular/core';
import { MazeAnimatorService } from '../services/maze_animator.service';
import { MazeGeneratorService, PathMap } from '../services/maze-generator.service';
import { MazeSolverService, ProcessedConnComponent } from '../services/maze-solver.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-maze-visualizer',
  template: `
    <div class="maze-container">
      <div #mazeCanvas class="maze-canvas"></div>
      <div class="controls" *ngIf="initialized">
        <button (click)="generateNewMaze()" [disabled]="isGenerating">
          {{ isGenerating ? 'Generating...' : 'Generate New Maze' }}
        </button>
      </div>
      <div class="status" *ngIf="statusMessage">{{ statusMessage }}</div>
    </div>
  `,
  styles: [`
    .maze-container {
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 500px;
    }
    .maze-canvas {
      width: 100%;
      height: 100%;
    }
    .controls {
      position: absolute;
      top: 20px;
      left: 20px;
      z-index: 10;
    }
    .controls button {
      background-color: rgba(0, 0, 0, 0.7);
      color: white;
      border: 1px solid #555;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
    }
    .controls button:hover:not([disabled]) {
      background-color: rgba(30, 30, 30, 0.8);
    }
    .controls button[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .status {
      position: absolute;
      bottom: 20px;
      left: 20px;
      background-color: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 10px;
      border-radius: 4px;
      max-width: 80%;
      z-index: 10;
    }
  `],
  imports: [CommonModule],
  host: { ngSkipHydration: 'true' }
})
export class MazeVisualizerComponent implements OnInit, OnDestroy {
  @ViewChild('mazeCanvas', { static: true }) mazeCanvasRef!: ElementRef;
  
  initialized = false;
  isGenerating = false;
  statusMessage: string | null = null;
  
  private pathMap: PathMap | null = null;
  private solvedComponents: ProcessedConnComponent[] = [];
  private width: number = 0;
  private height: number = 0;

  constructor(
    private mazeAnimator: MazeAnimatorService,
    private mazeGenerator: MazeGeneratorService,
    private mazeSolver: MazeSolverService,
    private ngZone: NgZone
  ) {}

  ngOnInit(): void {
    this.initializeVisualizer();
  }

  ngOnDestroy(): void {
    this.mazeAnimator.dispose();
  }

  /**
   * Initialize the 3D visualizer
   */
  initializeVisualizer(): void {
    // Get the canvas element
    const canvasElement = this.mazeCanvasRef.nativeElement;
    
    // Initialize the maze animator
    this.initialized = this.mazeAnimator.initialize(canvasElement);
    
    if (this.initialized) {
      this.statusMessage = `Renderer: ${this.mazeAnimator.isUsingWebGPU() ? 'WebGPU' : 'WebGL'}`;
      // Generate a maze automatically
      this.generateNewMaze();
    } else {
      this.statusMessage = 'Failed to initialize 3D renderer';
    }
  }

  /**
   * Generate a new maze
   */
  generateNewMaze(): void {
    if (this.isGenerating) return;
    
    this.ngZone.run(() => {
      this.isGenerating = true;
      this.statusMessage = 'Generating maze...';
    });
    
    try {
      // Get container dimensions
      const container = this.mazeCanvasRef.nativeElement;
      this.width = container.clientWidth;
      this.height = container.clientHeight;
      
      // Generate a new maze
      this.pathMap = this.mazeGenerator.generateMaze(this.width, this.height);

      // Render the maze in 3D
      if (this.pathMap) {
        this.mazeAnimator.createMaze(this.pathMap);
      }
      
      this.ngZone.run(() => {
        this.statusMessage = 'Solving maze...';
      });
      
      // Solve the maze
      this.solveMaze();
      this.ngZone.run(() => {
        this.statusMessage = 'Maze solved';
        this.isGenerating = false;
      });

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error('Maze generation error:', err);
      
      this.ngZone.run(() => {
        this.statusMessage = `Error: ${errorMessage}`;
        this.isGenerating = false;
      });
    }
  }

  /**
   * Solve the current maze
   */
  private async solveMaze(): Promise<void> {
    if (!this.pathMap) {
      this.ngZone.run(() => {
        this.statusMessage = 'No maze to solve';
        this.isGenerating = false;
      });
      return;
    }
      
    try {
      // Prepare maze data with both required properties
      const mazeData = { 
        pathMap: this.pathMap,
      };
      // Solve the maze
      this.solvedComponents = await this.mazeSolver.solveMaze(mazeData)
      
      // Visualize solutions
      this.mazeAnimator.VisualizePaths(this.solvedComponents);
        
      this.ngZone.run(() => {
        this.statusMessage = `Found ${this.solvedComponents.length} solution paths`;
        this.isGenerating = false;
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error('Maze solving error:', err);
        
      this.ngZone.run(() => {
        this.statusMessage = `Solving error: ${errorMessage}`;
        this.isGenerating = false;
      });
    }
  }
}