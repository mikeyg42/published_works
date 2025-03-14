// hex-maze.component.ts
import {
  Component,
  ViewChild,
  ElementRef,
  OnDestroy,
  AfterViewInit,
  PLATFORM_ID,
  Inject,
  Renderer2,
} from '@angular/core';
import { MazeSolverService } from '../services/maze-solver.service';
import { MazeApiService } from '../services/maze-api.service';
import { MazeAnimatorService } from '../services/maze_animator.service';
import { firstValueFrom } from 'rxjs';
import { isPlatformBrowser } from '@angular/common';
import { PathMap, PathCell, Edge } from '../services/maze-generator.service';
import { fromEvent } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { ProcessedConnComponent } from '../services/maze-solver.service';
interface ApiPathMap {
  cells: Map<string, number[]>;
  edges: Map<string, number[]>;
  dimensions: {
    rows: number;
    cols: number;
    hexWidth: number;
    hexHeight: number;
    padding: { horizontal: number; vertical: number };
  };
}

@Component({
  selector: 'app-hex-maze',
  templateUrl: './hex-maze.component.html',
  styleUrls: ['./hex-maze.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
  ],
  providers: [MazeSolverService, MazeApiService],
  host: { ngSkipHydration: 'true' }
})

export class HexMazeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mazeCanvas') private canvasRef!: ElementRef<HTMLCanvasElement>;
  private ctx!: CanvasRenderingContext2D;
  private resizeTimeout: any = null;
  private isGenerating = false;
  public currentMazeSize = { width: 0, height: 0 };
  public lastWindowSize = { width: 0, height: 0 };
  public canvasWidth = 0;

    // Store the API-based map
  private apiPathMap?: ApiPathMap;

  // Maze generator expects this shape
  private solverPathMap?: PathMap;
  public isLoading = false;
  public isAnimating = false;
  private animationFrameId: number | null = null;

  // Add back the property (near the top with other properties)
  private mazeData?: any; // Or use proper type from maze-api.service

  private solvedComponents: ProcessedConnComponent[] = [];

  constructor(
    private mazeApi: MazeApiService,
    private mazeSolver: MazeSolverService,
    private renderer: Renderer2,
    @Inject(PLATFORM_ID) private platformId: Object,
    private mazeAnimator: MazeAnimatorService,
    private mazeAnimatorService: MazeAnimatorService
  ) {
    this.mazeSolver.progress$.subscribe(progress => {
      console.log(`Solving progress: ${progress.currentPath}/${progress.totalPaths} - ${progress.pathProgress * 100}%`);
      // Update UI with progress
    });
  }

  ngAfterViewInit() {
    if (isPlatformBrowser(this.platformId)) {
      this.initializeCanvas();
      this.generateNewMaze();
      
      // Start solving the maze immediately, don't wait for the animation
      // This ensures the websocket communication happens early
      setTimeout(() => {
        if (this.mazeData) {
          this.mazeSolver.solveMaze(this.mazeData)
            .then(processedConnComponents => {
              // Store the result for later use
              this.solvedComponents = processedConnComponents;
              
              // If the intro animation is already complete, show the paths
              if (!this.mazeAnimatorService.isIntroAnimationInProgress()) {
                this.mazeAnimatorService.animatePaths(processedConnComponents);
              }
            })
            .catch(error => {
              console.error('Error solving maze:', error);
            });
        }
      }, 100); // Small delay to ensure maze data is available
    }
    // Store initial window size
    if (isPlatformBrowser(this.platformId)) {
      this.lastWindowSize = {
        width: window.innerWidth,
        height: window.innerHeight
      };
    } else {
      this.lastWindowSize = {
        width: 0,
        height: 0
      };
    }
    // Debounced window resize handler
    if (isPlatformBrowser(this.platformId)) {
      fromEvent(window, 'resize')
        .pipe(
          debounceTime(500),
          distinctUntilChanged()
        )
        .subscribe(() => {
          // Only trigger regeneration if we're not currently generating
          // and the window size has significantly changed
          if (!this.isGenerating && this.hasWindowSizeSignificantlyChanged()) {
            this.handleWindowResize();
          }
        });
    }
  }

  ngOnDestroy() {
    // Cancel any pending animation frames
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }
  }

  private hasWindowSizeSignificantlyChanged(): boolean {
    const significantDifference = 100; // pixels
    const widthDiff = Math.abs(window.innerWidth - this.lastWindowSize.width);
    const heightDiff = Math.abs(window.innerHeight - this.lastWindowSize.height);
    return widthDiff > significantDifference || heightDiff > significantDifference;
  }

  private initializeCanvas() {
    if (!this.canvasRef) {
      console.warn('Canvas reference not available');
      return;
    }
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d')!;

    // Set initial canvas size
    this.setCanvasSize();

    // Set canvas container style for scrolling
    const container = canvas.parentElement;
    if (container) {
      this.renderer.setStyle(container, 'overflow', 'auto');
      this.renderer.setStyle(container, 'position', 'relative');
    }

    console.log('Canvas initialized:', {
      width: canvas.width,
      height: canvas.height,
      context: !!this.ctx
    });
  }

  private setCanvasSize() {
    if (!isPlatformBrowser(this.platformId)) return;
    
    const canvas = this.canvasRef.nativeElement;
    this.canvasWidth = window.innerWidth;
    
    if (!this.isGenerating) {
      // Only update canvas size if we're not currently generating
      this.currentMazeSize = {
        width: window.innerWidth,
        height: window.innerHeight
      };
    }

    // Set canvas size to current maze size
    canvas.width = this.currentMazeSize.width;
    canvas.height = this.currentMazeSize.height;

    // Set minimum size on canvas container
    const container = canvas.parentElement;
    if (container) {
      this.renderer.setStyle(container, 'min-width', `${this.currentMazeSize.width}px`);
      this.renderer.setStyle(container, 'min-height', `${this.currentMazeSize.height}px`);
    }
  }

  private handleWindowResize() {
    if (!isPlatformBrowser(this.platformId)) return;
    
    this.lastWindowSize = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    // Clear existing timeout if any
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }

    // Start new maze generation
    this.generateNewMaze();
  }

  async generateNewMaze() {
    if (!isPlatformBrowser(this.platformId) || !this.ctx) return;

    if (this.isGenerating) {
        console.log('Maze generation already in progress, skipping...');
        return;
    }

    try {
        this.isGenerating = true;
        
        // Clear the canvas
        this.ctx.clearRect(0, 0, this.currentMazeSize.width, this.currentMazeSize.height);
        
        // Convert Observable to Promise using firstValueFrom
        const mazeData = await firstValueFrom(this.mazeApi.getMazeData(
            this.currentMazeSize.width,
            this.currentMazeSize.height
        ));
        
        console.log('Received maze data:', mazeData);  // Debug log
        
        if ('imageData' in mazeData && 'pathMap' in mazeData) {
            this.ctx.putImageData(mazeData.imageData as ImageData, 0, 0);
            this.apiPathMap = this.convertToApiPathMap(mazeData.pathMap);
            
            if (this.apiPathMap) {
                this.solverPathMap = this.convertToSolverPathMap(this.apiPathMap);
                console.log('PathMap conversion:', {
                    apiPathMap: this.apiPathMap,
                    solverPathMap: this.solverPathMap
                });
            } else {
                throw new Error('API path map is undefined');
            }
        } else {
            console.error('Invalid maze data structure:', mazeData);
            return;
        }

        // Wait a bit to ensure maze is drawn
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (!this.solverPathMap) {
            throw new Error('Failed to convert path map');
        }

        // solve maze with new worker implementation
        try {
            const processedConnComponents = await this.mazeSolver.solveMaze(
                mazeData
            );
            this.mazeAnimator.animatePaths(processedConnComponents);
        } catch (error) {
            console.error('Maze solving error:', error);
        }

        // In generateNewMaze(), store mazeData in the property
        this.mazeData = mazeData;

    } catch (error) {
        console.error('Error generating maze:', error);
    } finally {
        this.isGenerating = false;
    }
  }

  private convertToApiPathMap(pathMap: PathMap): ApiPathMap {
    // Convert cells array to Map<string, number[]>
    const cellsMap = new Map<string, number[]>();
    pathMap.cells.forEach(cell => {
        // Get connections from edges
        const connections = pathMap.edges
            .filter(edge => edge.from === cell.linearId || edge.to === cell.linearId)
            .map(edge => edge.from === cell.linearId ? edge.to : edge.from);
        cellsMap.set(cell.linearId.toString(), connections);
    });

    // Convert edges array to Map<string, number[]>
    const edgesMap = new Map<string, number[]>();
    pathMap.edges.forEach(edge => {
        const key = `${edge.from}-${edge.to}`;
        edgesMap.set(key, [edge.from, edge.to]);
    });

    return {
        cells: cellsMap,
        edges: edgesMap,
        dimensions: {
            rows: pathMap.dimensions.rows,
            cols: pathMap.dimensions.cols,
            hexWidth: pathMap.dimensions.hexWidth,
            hexHeight: pathMap.dimensions.hexHeight,
            padding: pathMap.dimensions.padding
        }
    };
  }

  private convertToSolverPathMap(apiMap: ApiPathMap): PathMap {
    const cells: PathCell[] = Array.from(apiMap.cells.entries()).map(([id, connections]) => {
        // Calculate row and col first
        const row = Math.floor(parseInt(id) / apiMap.dimensions.cols);
        const col = parseInt(id) % apiMap.dimensions.cols;
        const isOddRow = row % 2;
        
        // Calculate x and y
        const x = apiMap.dimensions.padding.horizontal + 
            (col * apiMap.dimensions.hexWidth) + 
            (isOddRow ? apiMap.dimensions.hexWidth/2 : 0);
        const y = apiMap.dimensions.padding.vertical + 
            (row * apiMap.dimensions.hexHeight * 0.75);
            
        // Calculate reference vertex (top vertex)
        const angle = (Math.PI / 180) * 30; // 30 degrees
        const referenceVertex = {
            x: x + (apiMap.dimensions.hexWidth/2) * Math.cos(angle),
            y: y + (apiMap.dimensions.hexHeight/2) * Math.sin(angle)
        };

        return {
            linearId: parseInt(id),
            connections,
            position: {
                row,
                col,
                x,
                y
            },
            openPaths: [],
            referenceVertex  // Include the reference vertex in the initial creation
        };
    });

    // Convert Map<string, number[]> to Edge[]
    const edges: Edge[] = Array.from(apiMap.edges.entries()).map(([key, value]) => ({
        from: parseInt(key.split('-')[0]),
        to: parseInt(key.split('-')[1]),
        weight: 1
    }));

    return {
        cells,
        edges,
        dimensions: {
            rows: apiMap.dimensions.rows,
            cols: apiMap.dimensions.cols,
            hexWidth: apiMap.dimensions.hexWidth,
            hexHeight: apiMap.dimensions.hexHeight,
            padding: apiMap.dimensions.padding
        }
    };
  }
  
  async onClick() {
    if (this.isAnimating || this.isLoading) return;
    
    try {
      this.isLoading = true;
      await this.generateNewMaze();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.isLoading = false;
    }
  }

  async solveMaze() {
    if (!isPlatformBrowser(this.platformId)) {
      console.error('Canvas not ready or not in browser');
      return;
    }

    if (!this.solverPathMap) {
      console.error('No path map available');
      return;
    }

    try {
      if (!this.mazeData) {
        console.error('No maze data available');
        return;
      }
      
      const processedConnComponents = await this.mazeSolver.solveMaze(
        this.mazeData
      );
     
      this.mazeAnimatorService.animatePaths(processedConnComponents);
    
    
    } catch (error) {
      this.handleError(error);
    }

  }

  private handleError(error: any) {
    console.error('Maze generation error:', error);
    this.isLoading = false;
    this.isAnimating = false;
  }
}
