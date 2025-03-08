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
  weight: number;
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

  private readonly MAX_HEXAGONS_PER_ROW = 60;
  private readonly MIN_HEXAGONS_PER_ROW = 9;
  private readonly MAX_RADIUS = 75;
  private readonly MIN_HEXAGON_WIDTH = 13;
  private readonly PADDING_RATIO = 3; // Padding will be this ratio of hexSize
  
  private hexSize!: number;
  private padding!: number;
  
  private grid: HexCell[][] = [];
  private rows: number = 0;
  private cols: number = 0;
  private edges: Edge[] = [];

  /**
   * Generates the maze geometry and returns a pathMap
   * containing cells, edges, and dimensions for use in MazeAnimator.
   */
  generateMaze(cw: number, ch: number): PathMap {
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error('Cannot generate maze during server-side rendering');
    }

    // Calculate minimum hex width ensuring no more than MAX_HEXAGONS_PER_ROW
    let minWidth = Math.max(this.MIN_HEXAGON_WIDTH, Math.floor(cw / this.MAX_HEXAGONS_PER_ROW));
    const tempPadding = this.MIN_HEXAGON_WIDTH * this.PADDING_RATIO;
    let maxWidth = Math.min(2 * minWidth, this.MAX_RADIUS);
    let minNumCols = Math.floor((cw - (tempPadding * 2)) / maxWidth);
    if (minNumCols < this.MIN_HEXAGONS_PER_ROW) {
      while (minNumCols < this.MIN_HEXAGONS_PER_ROW) {
        maxWidth = maxWidth * 0.9; // Reduce by 10% each iteration
        minNumCols = Math.floor((cw - (tempPadding * 2)) / maxWidth);
      }
    }

    // Randomly select a hex width within the valid range
    const hexWidth = Math.floor(Math.random() * (maxWidth - minWidth + 1)) + minWidth;
    this.hexSize = hexWidth / Math.sqrt(3);
    // Set padding (you can adjust this as needed)
    this.padding = 80;

    // Calculate grid dimensions based on selected hexSize
    const canvasWidth = cw - (this.padding * 2);
    const canvasHeight = ch - (this.padding * 2);
    const hexHeight = this.hexSize * 2;
    this.cols = Math.floor(canvasWidth / hexWidth);
    this.rows = Math.floor(canvasHeight / (hexHeight * 0.75));

    // Center the maze
    const xOffset = this.padding + (canvasWidth - (this.cols * hexWidth)) / 2;
    const yOffset = this.padding + (canvasHeight - (this.rows * hexHeight * 0.75)) / 2;

    // Generate the grid and maze paths
    this.initializeGrid(xOffset, yOffset);
    this.generateMazePaths();

    // Create and return the pathMap data structure to be used by MazeAnimator
    const pathMap = this.createPathMap();
    return pathMap;
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
        const x = xOffset + col * width + (isOddRow ? width / 2 : 0);
        const y = yOffset + row * (height * 0.75);
        
        this.grid[row][col] = {
          x, y, row, col,
          visited: false,
          walls: [true, true, true, true, true, true],
          neighbors: [],
          linearId: row * this.cols + col + 1
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

    const offsets: Record<Direction, [number, number]> = {
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
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }

  private generateMazePaths() {
    const totalCells = this.rows * this.cols;
    // Create a map of linear indices to hexagon centers
    const centerMap = new Map<number, { x: number; y: number }>();
    this.grid.forEach(row => {
      row.forEach(cell => {
        centerMap.set(cell.linearId, { x: cell.x, y: cell.y });
      });
    });

    // Generate edges using the neighbor system
    const edges = new Set<string>();
    const normalDistribution = [0, 0, 1, 1, 2, 2, 2];
    const edgeDistribution = [0, 1, 1, 1, 2, 2];
    
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row][col];
        const validNeighbors = cell.neighbors.filter(n => n !== null);
        if (validNeighbors.length === 0) continue;
        
        const distribution = validNeighbors.length <= 4 ? edgeDistribution : normalDistribution;
        const edgesToCreate = distribution[Math.floor(Math.random() * distribution.length)];
        
        const selectedNeighbors = [];
        const neighborsCopy = [...validNeighbors];
        
        for (let i = 0; i < edgesToCreate && neighborsCopy.length > 0; i++) {
          const randomIndex = Math.floor(Math.random() * neighborsCopy.length);
          const neighbor = neighborsCopy.splice(randomIndex, 1)[0]!;
          selectedNeighbors.push(neighbor);
        }
        
        selectedNeighbors.forEach(neighbor => {
          const [from, to] = [cell.linearId, neighbor.linearId].sort((a, b) => a - b);
          edges.add(`${from}-${to}`);
        });
      }
    }

    // Convert to edge objects
    this.edges = Array.from(edges).map(edge => {
      const [from, to] = edge.split('-').map(Number);
      return { from, to, weight: 1 };
    });

    // Count edges per cell
    const edgesPerCell = new Map<number, number>();
    this.grid.forEach(row => {
      row.forEach(cell => {
        edgesPerCell.set(cell.linearId, 0);
      });
    });
    
    this.edges.forEach(edge => {
      edgesPerCell.set(edge.from, (edgesPerCell.get(edge.from) || 0) + 1);
      edgesPerCell.set(edge.to, (edgesPerCell.get(edge.to) || 0) + 1);
    });

    // Process high-degree nodes by removing some edges
    const removalDistribution = [1, 2, 2];
    const highDegreeNodes = Array.from(edgesPerCell.entries())
      .filter(([_, count]) => count >= 5)
      .map(([linearId]) => linearId);
    
    highDegreeNodes.forEach(centralId => {
      const centralCell = this.getCellFromLinearId(centralId)!;
      const validNeighbors = centralCell.neighbors
          .map((neighbor, direction) => ({ neighbor, direction }))
          .filter(({ neighbor }) => neighbor !== null)
          .map(({ neighbor, direction }) => ({
              neighborId: neighbor!.linearId,
              direction
          }));
      
      const edgesToRemove = removalDistribution[
          Math.floor(Math.random() * removalDistribution.length)
      ];
      
      const shuffledNeighbors = [...validNeighbors].sort(() => Math.random() - 0.5).slice(0, edgesToRemove);
      
      shuffledNeighbors.forEach(({ neighborId }) => {
        const [minId, maxId] = [centralId, neighborId].sort((a, b) => a - b);
        const edgeExists = this.edges.some(edge => edge.from === minId && edge.to === maxId);
        if (edgeExists) {
          this.edges = this.edges.filter(edge => !(edge.from === minId && edge.to === maxId));
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
  }

  private getCellFromLinearId(linearId: number): HexCell | null {
    const row = Math.floor((linearId - 1) / this.cols);
    const col = (linearId - 1) % this.cols;
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      console.warn(`Invalid cell coordinates from linearId ${linearId}: row ${row}, col ${col}`);
      return null;
    }
    return this.grid[row]?.[col] ?? null;
  }

  /**
   * Constructs a path map which includes:
   * - cells: positions and open paths for each hexagon
   * - edges: the connections between cells
   * - dimensions: overall maze dimensions
   *
   * This data is intended for use by the new MazeAnimator (three.js) project.
   */
  private createPathMap(): PathMap {
    // Since we are no longer using a canvas, we set offsets to zero.
    const canvasLeft = 0;
    const canvasTop = 0;
    
    // Build an adjacency list from the edges
    const adjacencyList: { [key: string]: string[] } = {};
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row][col];
        adjacencyList[cell.linearId.toString()] = [];
      }
    }
    
    this.edges.forEach(edge => {
      const fromId = edge.from.toString();
      const toId = edge.to.toString();
      adjacencyList[fromId].push(toId);
      adjacencyList[toId].push(fromId);
    });

    const cells: PathCell[] = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row][col];
        const angle = (Math.PI / 180) * 30;
        const vertexX = cell.x + this.hexSize * Math.cos(angle);
        const vertexY = cell.y + this.hexSize * Math.sin(angle);
        
        const cellId = cell.linearId.toString();
        const openPaths: number[] = [];
        adjacencyList[cellId].forEach(neighborId => {
          for (let dir = 0; dir < 6; dir++) {
            if (this.getNeighborLinearId(cell.linearId, dir as Direction)?.toString() === neighborId) {
              openPaths.push(dir);
              break;
            }
          }
        });
        
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
    // Reset grid and edges if needed.
    this.grid = [];
    this.edges = [];
  }
}
