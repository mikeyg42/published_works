import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

interface HexCell {
  x: number;
  y: number;
  row: number;
  col: number;
  visited: boolean;
  walls: boolean[];  // [NE, E, SE, SW, W, NW]
  neighbors: (HexCell | null)[];
  linearId: number;  // 1-based linear index
}

export interface Edge {
  from: number;
  to: number;
  weight: number;  // Add weight property to match usage
}

export interface PathMap {
  cells: PathCell[];
  edges: Edge[];
  dimensions: MazeDimensions;
}

export interface PathCell {
  position: {
    row: number;
    col: number;
    x: number;    // center x
    y: number;    // center y
  };
  linearId: number;
  openPaths: number[];

  referenceVertex: {
    x: number;
    y: number;
  };
}

export interface MazeDimensions {
  rows: number;
  cols: number;
  hexWidth: number;
  hexHeight: number;
  padding: {
    horizontal: number;
    vertical: number;
  };
}

interface HexagonCenter {
  x: number;
  y: number;
}

enum Direction {
  NE = 0, 
  E = 1,
  SE = 2,
  SW = 3,
  W = 4,
  NW = 5
}

@Injectable({
  providedIn: 'root'
})
export class MazeGeneratorService {
  constructor(@Inject(PLATFORM_ID) private platformId: Object) {}

  private readonly MAX_HEXAGONS_PER_ROW = 70;
  private readonly MIN_HEXAGONS_PER_ROW = 9;
  private readonly MAX_RADIUS = 75;
  private readonly MIN_HEXAGON_WIDTH = 7;
  private readonly PADDING_RATIO = 3; // Padding will be this ratio of hexSize
  
  private ctx: CanvasRenderingContext2D | null = null;

  private hexSize!: number;
  private padding!: number;
  
  private grid: HexCell[][] = [];
  private rows: number = 0;
  private cols: number = 0;
  private edges: Edge[] = [];


  generateMaze(
    ctx: CanvasRenderingContext2D,
    cw: number,
    ch: number
  ): { imageData: ImageData; pathMap: PathMap } {
    this.ctx = ctx;
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error('Cannot generate maze during server-side rendering');
    }
    // Initialize canvas
    ctx.fillStyle = '#000000';  // Pure black background
    ctx.fillRect(0, 0, cw, ch);
    
    // Set maze line properties
    ctx.strokeStyle = '#ffffff';  // Pure white lines
    ctx.lineWidth = 1.5;  // Slightly thinner lines for better clarity

    // Calculate minimum hex size that ensures no more than MAX_HEXAGONS_PER_ROW
    let minWidth = Math.max(this.MIN_HEXAGON_WIDTH,Math.floor((cw / (this.MAX_HEXAGONS_PER_ROW))));
    // First calculate a temporary padding based on minimum hex size
    const tempPadding = this.MIN_HEXAGON_WIDTH * this.PADDING_RATIO;

    // Ensure maximum hex size comply's with minimum hexagons requirements
    let maxWidth = Math.min(2 *minWidth, this.MAX_RADIUS);
    let minNumCols = Math.floor((cw - (tempPadding * 2)) / maxWidth);
    if (minNumCols < this.MIN_HEXAGONS_PER_ROW) {
      while (minNumCols < this.MIN_HEXAGONS_PER_ROW) {
        maxWidth = maxWidth * 0.9; // Reduce by 10% each iteration
        minNumCols = Math.floor((cw - (tempPadding* 2)) / maxWidth);
      }
    }

    // Randomly select a size within the valid range
    const hexWidth = Math.floor(Math.random() * (maxWidth - minWidth + 1)) + minWidth;
    this.hexSize = hexWidth/Math.sqrt(3);
    this.padding =80; //this.hexSize*this.PADDING_RATIO;

    console.log('Hex size calculations:', {
      minWidth,
      maxWidth,
      selectedHexWidth: hexWidth,
      selectedHexSize: this.hexSize,
      padding: this.padding,
      cols: this.cols,
      rows: this.rows,
      canvasWidth: cw,
      canvasHeight: ch
    });

    // Calculate grid dimensions based on selected hexSize
    const canvasWidth = cw - (this.padding * 2);
    const canvasHeight = ch - (this.padding * 2);
    
    const hexHeight = this.hexSize * 2;
    
    this.cols = Math.floor(canvasWidth / hexWidth);
    this.rows = Math.floor(canvasHeight / (hexHeight * 0.75));

    console.log('Grid dimensions:', { 
      rows: this.rows, 
      cols: this.cols,
      hexSize: this.hexSize 
    });

    // Center the maze
    const xOffset = this.padding + (canvasWidth - (this.cols * hexWidth)) / 2;
    const yOffset = this.padding + (canvasHeight - (this.rows * hexHeight * 0.75)) / 2;

    // Generate maze
    this.initializeGrid(xOffset, yOffset);
    this.generateMazePaths();
    
    // Render maze
    this.renderMaze(ctx);

    const imageData = ctx.getImageData(0, 0, cw, ch);
    const pathMap = this.createPathMap();

    return { imageData, pathMap };
  }

  private initializeGrid(xOffset: number, yOffset: number) {
    this.grid = [];
    this.edges = [];
    
    // For a pointy-top hexagon:
    const radius = this.hexSize;
    const width = radius * Math.sqrt(3);
    const height = radius * 2;
    
    // Initialize cells with IDs
    for (let row = 0; row < this.rows; row++) {
        this.grid[row] = [];
        for (let col = 0; col < this.cols; col++) {
            // For odd rows, shift right by half a hex width
            const isOddRow = row % 2;
            const x = xOffset + col * width + (isOddRow ? width/2 : 0);
            const y = yOffset + row * (height * 0.75); // Overlap hexagons vertically
            
            this.grid[row][col] = {
                x, y, row, col,
                visited: false,
                walls: [true, true, true, true, true, true],
                neighbors: [],
                linearId: row * this.cols + col + 1  // Matches getCellFromLinearId
            };
        }
    }
    
    // Connect neighbors
    for (let row = 0; row < this.rows; row++) {
        for (let col = 0; col < this.cols; col++) {
            this.connectNeighbors(this.grid[row][col]);
        }
    }
  }

  private connectNeighbors(cell: HexCell) {
    cell.neighbors = Object.values(Direction)
      .filter((dir): dir is Direction => typeof dir === 'number')
      .map(dir => {
        const neighborId = this.getNeighborLinearId(cell.linearId, dir);
        return neighborId ? this.getCellFromLinearId(neighborId) : null;
      });
  }

  private getNeighborLinearId(linearId: number, direction: Direction): number | null {
    const row = Math.floor((linearId - 1) / this.cols);
    const col = (linearId - 1) % this.cols;
    const isEvenRow = row % 2 === 0;

    // Corrected offset patterns
    const offsets: Record<Direction, [number, number]> = {
      // [rowDelta, colDelta]
      [Direction.NE]: [-1, isEvenRow ? 0 : 1],
      [Direction.E]:  [0, 1],
      [Direction.SE]: [1, isEvenRow ? 0 : 1],
      [Direction.SW]: [1, isEvenRow ? -1 : 0],
      [Direction.W]:  [0, -1],
      [Direction.NW]: [-1, isEvenRow ? -1 : 0]
    };

    const [rowDelta, colDelta] = offsets[direction];
    const newRow = row + rowDelta;
    const newCol = col + colDelta;

    if (!this.isValidCell(newRow, newCol)) {
        return null;
    }

    return newRow * this.cols + newCol + 1;
  }

  private isValidCell(row: number, col: number): boolean {
    return row >= 0 && row < this.rows && 
           col >= 0 && col < this.cols;
  }

  private generateMazePaths() {
    const totalCells = this.rows * this.cols;
    console.log('Starting maze generation with:', {
        totalCells,
        rows: this.rows,
        cols: this.cols
    });
    
    // Create a map of linear indices to hexagon centers
    const centerMap = new Map<number, HexagonCenter>();
    this.grid.forEach(row => {
      row.forEach(cell => {
        centerMap.set(cell.linearId, { x: cell.x, y: cell.y });
      });
    });

    // Generate edges using the new neighbor system
    const edges = new Set<string>();
    
    // Distribution arrays for edge count selection
    const normalDistribution = [0, 0, 1, 1, 2, 2, 2];
    const edgeDistribution = [0, 1, 1, 1, 2,2];
    
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row][col];
        
        // Get valid neighbors using the new neighbor system
        const validNeighbors = cell.neighbors.filter(n => n !== null);
        if (validNeighbors.length === 0) continue;
        
        // Determine how many edges to create
        const distribution = validNeighbors.length <= 4 ? edgeDistribution : normalDistribution;
        const edgesToCreate = distribution[Math.floor(Math.random() * distribution.length)];
        
        // Randomly select distinct neighbors
        const selectedNeighbors = [];
        const neighborsCopy = [...validNeighbors];
        
        for (let i = 0; i < edgesToCreate && neighborsCopy.length > 0; i++) {
          const randomIndex = Math.floor(Math.random() * neighborsCopy.length);
          const neighbor = neighborsCopy.splice(randomIndex, 1)[0]!;
          selectedNeighbors.push(neighbor);
        }
        
        // Create edges with selected neighbors
        selectedNeighbors.forEach(neighbor => {
          const [from, to] = [cell.linearId, neighbor.linearId].sort((a, b) => a - b);
          edges.add(`${from}-${to}`);
        });
      }
    }

    // Convert back to array of edge objects
    this.edges = Array.from(edges).map(edge => {
      const [from, to] = edge.split('-').map(Number);
      return { from, to, weight: 1 }; // Add default weight
    });

    // After generating edges, count edges per cell
    const edgesPerCell = new Map<number, number>();
    
    // Initialize counts for all cells
    this.grid.forEach(row => {
      row.forEach(cell => {
        edgesPerCell.set(cell.linearId, 0);
      });
    });
    
    // Count edges for each cell
    this.edges.forEach(edge => {
      edgesPerCell.set(edge.from, (edgesPerCell.get(edge.from) || 0) + 1);
      edgesPerCell.set(edge.to, (edgesPerCell.get(edge.to) || 0) + 1);
    });
    
    // Log statistics
    const counts = Array.from(edgesPerCell.values());
    const stats = {
      min: Math.min(...counts),
      max: Math.max(...counts),
      average: counts.reduce((a, b) => a + b, 0) / counts.length,
      distribution: counts.reduce((acc, curr) => {
        acc[curr] = (acc[curr] || 0) + 1;
        return acc;
      }, {} as Record<number, number>)
    };
    
    console.log('Edge count statistics:', stats);
    
    // Optionally, flag cells with too many or too few connections
    const problematicCells = Array.from(edgesPerCell.entries())
      .filter(([_, count]) => count < 1 || count > 3)
      .map(([linearId, count]) => {
        const cell = this.getCellFromLinearId(linearId)!;
        return {
          linearId,
          position: { row: cell.row, col: cell.col },
          edgeCount: count
        };
      });
    
    if (problematicCells.length > 0) {
      console.warn('Cells with unusual number of connections:', problematicCells);
    }

    // Distribution for how many edges to remove from high-degree nodes
    const removalDistribution = [1, 2, 2];
    
    // Find all hexagons with degree 5 or 6
    const highDegreeNodes = Array.from(edgesPerCell.entries())
        .filter(([_, count]) => count >= 5)
        .map(([linearId]) => linearId);
    
    if (highDegreeNodes.length > 0) {
        console.log(`Found ${highDegreeNodes.length} high-degree nodes to process`);
    }
    
    // Process each high degree node
    highDegreeNodes.forEach(centralId => {
        const centralCell = this.getCellFromLinearId(centralId)!;
        
        // Get all valid neighbors
        const validNeighbors = centralCell.neighbors
            .map((neighbor, direction) => ({ neighbor, direction }))
            .filter(({neighbor}) => neighbor !== null)
            .map(({neighbor, direction}) => ({
                neighborId: neighbor!.linearId,
                direction
            }));
        
        // Randomly select how many edges to remove
        const edgesToRemove = removalDistribution[
            Math.floor(Math.random() * removalDistribution.length)
        ];
        
        // Randomly select which neighbors to disconnect from
        const shuffledNeighbors = [...validNeighbors]
            .sort(() => Math.random() - 0.5)
            .slice(0, edgesToRemove);
        
        // Remove selected edges
        shuffledNeighbors.forEach(({neighborId}) => {
            // Find and remove the edge
            const [minId, maxId] = [centralId, neighborId].sort((a, b) => a - b);
            const edgeExists = this.edges.some(edge => 
                edge.from === minId && edge.to === maxId
            );
            
            if (edgeExists) {
                this.edges = this.edges.filter(edge => 
                    !(edge.from === minId && edge.to === maxId)
                );
                
                // Only update counts if we actually removed an edge
                const currentCount = edgesPerCell.get(centralId) || 0;
                const neighborCount = edgesPerCell.get(neighborId) || 0;
                
                if (currentCount > 0) {
                    edgesPerCell.set(centralId, currentCount - 1);
                }
                if (neighborCount > 0) {
                    edgesPerCell.set(neighborId, neighborCount - 1);
                }
            }
        });
    });
    
    // Log final statistics after edge removal
    const finalCounts = Array.from(edgesPerCell.values());
    const finalStats = {
        min: Math.min(...finalCounts),
        max: Math.max(...finalCounts),
        average: finalCounts.reduce((a, b) => a + b, 0) / finalCounts.length,
        distribution: finalCounts.reduce((acc, curr) => {
            acc[curr] = (acc[curr] || 0) + 1;
            return acc;
        }, {} as Record<number, number>)
    };
    
    console.log('Final edge count statistics after high-degree processing:', finalStats);

    console.log('Generated edges:', this.edges.slice(0, 5));
  }

  private getCellFromLinearId(linearId: number): HexCell | null {
    const row = Math.floor((linearId - 1) / this.cols);
    const col = (linearId - 1) % this.cols;
    
    // Add bounds checking
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
        console.warn(`Invalid cell coordinates calculated from linearId ${linearId}:`, 
            { row, col, maxRows: this.rows, maxCols: this.cols });
        return null;
    }
    
    return this.grid[row]?.[col] ?? null;
  }

  private renderMaze(ctx: CanvasRenderingContext2D) {

    // Draw complete hexagonal grid
    this.drawCompleteGrid(ctx);
    
    // Draw paths by masking out walls
    this.drawPaths(ctx);
    
    // draw all cell labels
    this.drawCellLabels(ctx);
  }

  private drawCompleteGrid(ctx: CanvasRenderingContext2D) {
    // Draw all hexagons as complete cells
    for (let row = 0; row < this.rows; row++) {
        for (let col = 0; col < this.cols; col++) {
            const cell = this.grid[row][col];
            const radius = this.hexSize;
            const angles = [30, 90, 150, 210, 270, 330];
            
            // Draw complete hexagon
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            // Draw first point
            const startAngle = (Math.PI / 180) * angles[0];
            ctx.moveTo(
                cell.x + radius * Math.cos(startAngle),
                cell.y + radius * Math.sin(startAngle)
            );
            
            // Draw remaining points
            for (let i = 1; i < 6; i++) {
                const angleRad = (Math.PI / 180) * angles[i];
                ctx.lineTo(
                    cell.x + radius * Math.cos(angleRad),
                    cell.y + radius * Math.sin(angleRad)
                );
            }
            
            // Close the path back to first point
            ctx.closePath();
            ctx.stroke();
            
            // Draw cell ID
            // Save the text to draw later
            (cell as HexCell & { textInfo: { text: string, x: number, y: number } }).textInfo = {
              text: cell.linearId.toString(),
              x: cell.x,
              y: cell.y
            };
        }
    }
  }

  private drawPaths(ctx: CanvasRenderingContext2D) {
    // Create center point map
    const centerMap = new Map<number, HexagonCenter>();
    this.grid.forEach(row => {
      row.forEach(cell => {
        centerMap.set(cell.linearId, { x: cell.x, y: cell.y });
      });
    });

    // For each edge, draw a black rectangle that "knocks out" the wall
    ctx.fillStyle = 'black';
    
    this.edges.forEach(edge => {
      const center1 = centerMap.get(edge.from);
      const center2 = centerMap.get(edge.to);
      
      if (!center1 || !center2) return;

      // Calculate the line between centers
      const dx = center2.x - center1.x;
      const dy = center2.y - center1.y;
      const angle = Math.atan2(dy, dx);

      // Calculate perpendicular angle
      const perpAngle = angle + Math.PI/2;
      
      // Wall length is hexagon side length (this.hexSize)
      const wallWidth = this.hexSize;
      
      // Calculate the four corners of the rectangle
      const halfWidth = wallWidth/2;
      const corners = [
        { // Top left
          x: center1.x + Math.cos(perpAngle) * halfWidth,
          y: center1.y + Math.sin(perpAngle) * halfWidth
        },
        { // Top right
          x: center2.x + Math.cos(perpAngle) * halfWidth,
          y: center2.y + Math.sin(perpAngle) * halfWidth
        },
        { // Bottom right
          x: center2.x - Math.cos(perpAngle) * halfWidth,
          y: center2.y - Math.sin(perpAngle) * halfWidth
        },
        { // Bottom left
          x: center1.x - Math.cos(perpAngle) * halfWidth,
          y: center1.y - Math.sin(perpAngle) * halfWidth
        }];

        let dx_prime = Math.abs(center2.x-center1.x);
        let dy_prime = Math.abs(center2.y-center1.y);

        // Check distance between centers is not too large
        const distance = Math.sqrt(dx_prime * dx_prime + dy_prime * dy_prime);
        if (distance > 1.1* 2 * this.hexSize) {
          console.warn('Centers too far apart:', {
            distance,
            maxAllowed: 2 * this.hexSize,
            from: edge.from,
            to: edge.to
          });
          return;
        }
      

      // Draw the rectangle
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      corners.slice(1).forEach(corner => {
        ctx.lineTo(corner.x, corner.y);
      });
      ctx.closePath();
      ctx.fill();
    });
  }

  // keep this for debugging
  private drawCellLabels(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = 'white';
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    this.grid.forEach(row => {
        row.forEach(cell => {
            if ('textInfo' in cell) {
                const textInfo = (cell as HexCell & { textInfo: { text: string, x: number, y: number } }).textInfo;
                ctx.fillText(textInfo.text, textInfo.x, textInfo.y);
            }
        });
    });
  }
  private createPathMap(): PathMap {
    const canvasRect = this.ctx?.canvas.getBoundingClientRect();
    const canvasLeft = canvasRect?.left ?? 0;
    const canvasTop = canvasRect?.top ?? 0;
    
    // Create adjacency list from edges
    const adjacencyList: { [key: string]: string[] } = {};
    
    // Initialize adjacency list with empty arrays
    const initCallback = (cell: HexCell) => {
      adjacencyList[cell.linearId.toString()] = [];
    };
    
    // Process each row
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        initCallback(this.grid[row][col]);
      }
    }
    
    // Populate adjacency list using edges with a single callback
    const edgeCallback = (edge: Edge) => {
      const fromId = edge.from.toString();
      const toId = edge.to.toString();
      adjacencyList[fromId].push(toId);
      adjacencyList[toId].push(fromId);
    };
    
    this.edges.forEach(edgeCallback);

    const cells: PathCell[] = [];
    
    // Process cells with a single callback to avoid nesting
    const processCell = (cell: HexCell) => {
      const angle = (Math.PI / 180) * 30;
      const vertexX = cell.x + this.hexSize * Math.cos(angle);
      const vertexY = cell.y + this.hexSize * Math.sin(angle);
      
      // Get connected directions
      const cellId = cell.linearId.toString();
      const openPaths: number[] = [];
      
      // Use a single callback for neighbor processing
      const neighborCallback = (neighborId: string) => {
        for (let dir = 0; dir < 6; dir++) {
          if (this.getNeighborLinearId(cell.linearId, dir as Direction)?.toString() === neighborId) {
            openPaths.push(dir);
            break;
          }
        }
      };
      
      adjacencyList[cellId].forEach(neighborCallback);

      cells.push({
        position: {
          row: cell.row,
          col: cell.col,
          x: cell.x - canvasLeft,
          y: cell.y - canvasTop
        },
        linearId: cell.linearId,
        openPaths,
        referenceVertex: {
          x: vertexX - canvasLeft,
          y: vertexY - canvasTop
        }
      });
    };

    // Process all cells
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        processCell(this.grid[row][col]);
      }
    }

    return {
      cells,
      edges: this.edges,
      dimensions: {
        rows: this.rows,
        cols: this.cols,
        hexWidth: this.hexSize * Math.sqrt(3),
        hexHeight: this.hexSize * 2,
        padding: {
          horizontal: this.padding,
          vertical: this.padding
        }
      }
    };
  }
  

  cleanup() {
    this.ctx = null;
  }
}
