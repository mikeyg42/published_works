// Standalone TypeScript maze generator - extracted from Angular service
// Preserving original logic exactly as requested

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

interface Edge {
  from: number;
  to: number;
  weight: number;
}

interface PathMap {
  cells: PathCell[];
  edges: Edge[];
  dimensions: MazeDimensions;
}

interface PathCell {
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

interface MazeDimensions {
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

class MazeGenerator {
  private readonly MAX_HEXAGONS_PER_ROW = 60;
  private readonly MIN_HEXAGONS_PER_ROW = 9;
  private readonly MAX_RADIUS = 75;
  private readonly MIN_HEXAGON_WIDTH = 15;
  private readonly PADDING_RATIO = 2; // Padding will be this ratio of hexSize

  private hexSize!: number;
  private padding!: number;

  private grid: HexCell[][] = [];
  private rows: number = 0;
  private cols: number = 0;
  private edges: Edge[] = [];

  /**
   * Generates a hex maze and returns the pathMap for 3D visualization
   * @param cwOrRows Canvas/container width or rows
   * @param chOrCols Canvas/container height or columns
   * @param usePresetDimensions Whether to use preset dimensions
   * @returns PathMap object containing maze data
   */
  generateMaze(cwOrRows: number, chOrCols: number, usePresetDimensions: boolean = false): PathMap {
    // If using preset dimensions
    if (usePresetDimensions) {
      this.rows = cwOrRows;
      this.cols = chOrCols;

      // Set reasonable hex size
      this.hexSize = this.MIN_HEXAGON_WIDTH / Math.sqrt(3);
      const hexWidth = this.hexSize * Math.sqrt(3);

      // Simple padding
      this.padding = 1;

      console.log('Using preset dimensions:', {
        rows: this.rows,
        cols: this.cols,
        hexSize: this.hexSize
      });

      // Generate maze with preset dimensions
      const xOffset = this.padding;
      const yOffset = this.padding;

      this.initializeGrid(xOffset, yOffset);
      this.generateMazePaths();

      return this.createPathMap();
    }

    // Original canvas-based dimension calculation
    const cw = cwOrRows;
    const ch = chOrCols;

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
    //this.padding = this.hexSize * this.PADDING_RATIO; // now that we have the final hexWidth, we toss tempPadding and caluclate real padding
    this.padding = 1; // we don't really care about this any longer

    console.log('Hex size calculations:', {
      minWidth,
      maxWidth,
      selectedHexWidth: hexWidth,
      selectedHexSize: this.hexSize,
      padding: this.padding
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

    // Create and return the pathMap
    return this.createPathMap();
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
          linearId: row * this.cols + col + 1  // 1-based linear index
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

    // Offset patterns for hexagonal grid
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
    console.log('Starting maze generation with:', {
      nRows: this.rows,
      nCols: this.cols
    });

    // Create a map of linear indices to hexagon centers
    const centerMap = new Map<number, HexagonCenter>();
    this.grid.forEach(row => {
      row.forEach(cell => {
        centerMap.set(cell.linearId, { x: cell.x, y: cell.y });
      });
    });

    // Generate edges using the neighbor system
    const edges = new Set<string>();

    // Distribution arrays for edge count selection
    const normalDistribution = [0, 0, 1, 2, 3];
    const edgeDistribution = [0, 1, 1,  2];

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row][col];

        // Get valid neighbors
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
      return { from, to, weight: 1 };
    });

    // Count edges per cell
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

    // Distribution for how many edges to remove from high-degree nodes
    const removalDistribution = [0, 1, 2, 3];
    while (true) {
      // Find all hexagons with degree 5 or 6
      const highDegreeNodes = Array.from(edgesPerCell.entries())
        .filter(([_, count]) => count >= 5)
        .map(([linearId]) => linearId);

      if (highDegreeNodes.length > 0) {
        console.log(`Found ${highDegreeNodes.length} high-degree nodes to process`);
      } else {
        break;
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

            // Update counts
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
  }

  private getCellFromLinearId(linearId: number): HexCell | null {
    const row = Math.floor((linearId - 1) / this.cols);
    const col = (linearId - 1) % this.cols;

    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      console.warn(`Invalid cell coordinates calculated from linearId ${linearId}:`,
        { row, col, maxRows: this.rows, maxCols: this.cols });
      return null;
    }

    return this.grid[row]?.[col] ?? null;
  }

  private createPathMap(): PathMap {
    // Create adjacency list from edges
    const adjacencyList: { [key: string]: string[] } = {};

    // Initialize adjacency list
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        adjacencyList[this.grid[row][col].linearId.toString()] = [];
      }
    }

    // Populate adjacency list using edges
    this.edges.forEach(edge => {
      const fromId = edge.from.toString();
      const toId = edge.to.toString();
      adjacencyList[fromId].push(toId);
      adjacencyList[toId].push(fromId);
    });

    const cells: PathCell[] = [];

    // Process cells
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row][col];
        const angle = (Math.PI / 180) * 30;
        const vertexX = cell.x + this.hexSize * Math.cos(angle);
        const vertexY = cell.y + this.hexSize * Math.sin(angle);

        // Get connected directions
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
            x: cell.x,
            y: cell.y
          },
          linearId: cell.linearId,
          openPaths,
          referenceVertex: {
            x: vertexX,
            y: vertexY
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

// Main execution when run as script
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: ts-node maze-generator.ts <width> <height> [rows] [cols]');
    process.exit(1);
  }

  const width = parseInt(args[0]);
  const height = parseInt(args[1]);
  const rows = args[2] ? parseInt(args[2]) : undefined;
  const cols = args[3] ? parseInt(args[3]) : undefined;

  const generator = new MazeGenerator();
  let pathMap: PathMap;

  if (rows !== undefined && cols !== undefined) {
    // Use preset dimensions
    pathMap = generator.generateMaze(rows, cols, true);
  } else {
    // Use canvas dimensions
    pathMap = generator.generateMaze(width, height, false);
  }

  // Output the result as JSON
  console.log(JSON.stringify(pathMap));
}

// Run main if this file is executed directly
if (require.main === module) {
  main();
}