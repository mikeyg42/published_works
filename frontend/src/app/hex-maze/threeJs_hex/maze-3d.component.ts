// maze-3d.component.ts
import { Component, ElementRef, OnInit, AfterViewInit, OnDestroy, ViewChild } from '@angular/core';
import { MazeGeneratorService } from './maze-generator.service';
import { MazeSolverService } from './maze-solver.service';
import { MazeAnimatorService } from './maze-animator.service';
import { MazeApiService } from './maze-api.service';

@Component({
  selector: 'app-maze-3d',
  template: `
    <div class="maze-container">
      <div #mazeCanvas class="maze-canvas"></div>
      <div class="controls">
        <button (click)="generateNewMaze()">Generate New Maze</button>
        <button (click)="solveMaze()" [disabled]="!mazeGenerated">Solve Maze</button>
      </div>
    </div>
  `,
  styles: [`
    .maze-container {
      width: 100%;
      height: 80vh;
      position: relative;
      background-color: #121212;
    }
    
    .maze-canvas {
      width: 100%;
      height: 100%;
    }
    
    .controls {
      position: absolute;
      bottom: 20px;
      left: 20px;
      z-index: 10;
    }
    
    button {
      padding: 10px 15px;
      margin-right: 10px;
      background-color: #4c566a;
      color: #eceff4;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    
    button:hover {
      background-color: #5e81ac;
    }
    
    button:disabled {
      background-color: #2e3440;
      cursor: not-allowed;
    }
  `]
})
export class Maze3DComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mazeCanvas', { static: true }) mazeCanvasRef!: ElementRef;
  
  private mazeData: any;
  mazeGenerated = false;
  
  constructor(
    private mazeGeneratorService: MazeGeneratorService,
    private mazeSolverService: MazeSolverService,
    private mazeAnimatorService: MazeAnimatorService,
    private mazeApiService: MazeApiService
  ) {}
  
  ngOnInit(): void {
    // Initialization logic
  }
  
  async ngAfterViewInit(): Promise<void> {
    // Initialize the 3D renderer
    await this.mazeAnimatorService.initialize(this.mazeCanvasRef.nativeElement);
    
    // Generate initial maze
    this.generateNewMaze();
  }
  
  generateNewMaze(): void {
    const container = this.mazeCanvasRef.nativeElement;
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Generate maze using your existing service
    const pathMap = this.mazeGeneratorService.generateMaze(width, height);
    
    // Store the maze data for later use
    this.mazeData = {
      pathMap: pathMap
    };
    
    // Render the maze using the 3D animator
    this.mazeAnimatorService.renderMaze(pathMap);
    
    this.mazeGenerated = true;
  }
  
  async solveMaze(): Promise<void> {
    if (!this.mazeData) return;
    
    // Solve the maze using your existing service
    try {
      const solutions = await this.mazeSolverService.solveMaze(this.mazeData);
      
      // Render the solutions
      this.mazeAnimatorService.renderSolutionPaths(solutions);
    } catch (error) {
      console.error('Failed to solve maze:', error);
    }
  }
  
  ngOnDestroy(): void {
    // Cleanup will be handled by the service's ngOnDestroy method
  }
}