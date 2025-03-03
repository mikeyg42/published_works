/// <reference lib="webworker" />
// maze-solver.service.ts
import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { MazeData } from './maze-api.service';
import { BehaviorSubject, Observable, of, timeout } from 'rxjs';
import { PathCell, PathMap } from './maze-generator.service';
import Graph from 'graphology';
import { Color, formatHex8, converter, parseHex, interpolatorSplineNatural, clampGamut, fixupHueIncreasing} from 'culori';
import { environment } from '../../environments/environment';

interface SolverProgress {
  currentPath: number;
  totalPaths: number;
  pathProgress: number;
}

interface ConnComponent {
  pixels: ConnComponentCell[];
  size: number; // number of hexagons in the connComponent
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
}

interface WorkerMessage {
  type: 'progress' | 'debug' | 'error' | 'result';
  data?: any;
  message?: string;
  args?: any[];
  error?: string;
}

interface ProcessedConnComponent extends ConnComponent {
  pathLength: number;
  path:string[]; // ["1" ,"6", "27", "2", ... ]
}

interface PathStyle {
  color: string;
  borderColor: string;
  alpha: number;
  glowColor: string;
}

interface ConnComponentCell {
  linearId: number; // indexed beginning w/ one, not with zero
  position: {
    x: number; // center of hexagon relative to browser window
    y: number; // center of hexagon relative to browser window
    row: number; // row number of hexagon (these are zero indexed)
    col: number; // column number of hexagon (these are zero indexed)
  };
  neighbors: string[] | null; // e.g "1": ["6", "17", "22"]
  referenceVertex: {
    x: number;
    y: number;
  };
}
/*
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
}*/

const BASE_COLORS = ['#0a1929', '#0d47a1', '#00acc1', '#b2ebf2'];

interface WorkerData {
  edges: { from: number; to: number }[];
  cells: HexCell[];
}

interface HexCell {
  id: number;
  position: {
    x: number;
    y: number;
    row: number;
    col: number;
  };
  referenceVertex: {
    x: number;
    y: number;
  };
}

const LARGE_COMPONENT_THRESHOLD = 8;
const COMPONENT_SIZE_THRESHOLD = 7;

@Injectable({
  providedIn: 'root',
})
export class MazeSolverService {
  private worker: Worker | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cw: number = 0;
  private ch: number = 0;
  private angleOffset: number | null = null;
  private hexSize: number = 0;
  private displacementVectors: { dx: number; dy: number }[] = [];
  private totalConnComponents: number = 0;
  
  private progressSubject = new BehaviorSubject<SolverProgress>({
    currentPath: 0,
    totalPaths: 0,
    pathProgress: 0,
  });
  progress$ = this.progressSubject.asObservable();

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    if (isPlatformBrowser(this.platformId)) {
      this.worker = new Worker(
        new URL('./maze-worker.worker', import.meta.url)
      );
      if (this.worker) {
        this.setupWorkerHandlers(this.worker);
      }
    }
  }

  async solveMaze(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    mazeData: MazeData
  ): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      console.warn('Maze solving is not available during server-side rendering');
      return;
    }

    this.ctx = ctx;
    this.cw = width;
    this.ch = height;
    
    // Find connected connComponents once
    const graph = new Graph({ type: 'undirected', multi: false});
          // Add nodes 
    mazeData.pathMap.cells.forEach(cell => {
      graph.addNode(cell.linearId.toString());
    });
      
    // Add edges
    mazeData.pathMap.edges.forEach(edge => {
      graph.addEdge(edge.from.toString(), edge.to.toString());
    });

    // Find connected connComponents
    const connComponents = this.findConnectedConnComponents(graph, mazeData.pathMap.cells);
    
    const { largeConnComponents, smallConnComponents } = this.analyzeConnComponents(connComponents, graph);
        
    // Create a pool of workers for local solving:
    const workerCount = Math.min(4, navigator.hardwareConcurrency || 2);
    const workerPool: Worker[] = [];
    const busyWorkers = new Set<Worker>();
    
    const remoteResults = largeConnComponents.length > 0 
      ? await this.solveRemotely(largeConnComponents.map(comp => ({ adjacencyList: comp.adjacencyList })))
      : [];

    const componentIndexByNode = new Map<string, number>();
    connComponents.forEach((cc, index) => {
      cc.pixels.forEach(pixel => {
        componentIndexByNode.set(pixel.linearId.toString(), index);
      });
    });

    const processedLargeComponents: ProcessedConnComponent[] = [];
    // For each result path, find its component using the first node
    remoteResults.forEach(path => {
      if (path.length === 0) return;
      
      const firstNode = path[0];
      const componentIndex = componentIndexByNode.get(firstNode);
      
      if (componentIndex === undefined) {
        return;
      }

      // Store the path in its matching component
      const procConnComponent = connComponents[componentIndex] as ProcessedConnComponent;
      procConnComponent.path = path as ProcessedConnComponent['path'];
      procConnComponent.pathLength = path.length as ProcessedConnComponent['pathLength'];
      processedLargeComponents.push(procConnComponent);
    });

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('./maze-worker.worker', import.meta.url));
      this.setupWorkerHandlers(worker);
      workerPool.push(worker);
    }

    const getAvailableWorker = async (): Promise<Worker> => {
      const worker = workerPool.find(w => !busyWorkers.has(w));
      if (worker) {
        busyWorkers.add(worker);
        return worker;
      }
      // Wait for a worker to become available
      return new Promise(resolve => {
        const interval = setInterval(() => {
          const worker = workerPool.find(w => !busyWorkers.has(w));
          if (worker) {
            clearInterval(interval);
            busyWorkers.add(worker);
            resolve(worker);
          }
        }, 30);
      });
    };

    let processedConnComponents: ProcessedConnComponent[] = [];
    try {
      // Launch local solvers in parallel:
      const localPromises = await Promise.all(smallConnComponents.map(async connComponent => {
        const worker = await getAvailableWorker();
        const result = await this.solveLocally(connComponent.connComponent, connComponent.graph, worker);
        busyWorkers.delete(worker);
        return result;
      }));

     const localSmallResults = await Promise.all(localPromises);


    processedConnComponents = [...localSmallResults, ...processedLargeComponents];
      // Combine the results from both local and remote solvers:
      
    } catch (error) {
      console.error('Error in solving:', error);
      throw error;
    } finally {
      // Clean up workers
      workerPool.forEach(worker => worker.terminate());
    }
    if (processedConnComponents.length > 0) {
      this.animatePath(processedConnComponents, mazeData.pathMap);
    }
  }


  // Update worker handler setup to accept specific worker
  private setupWorkerHandlers(worker: Worker) {
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      switch (data.type) {
        case 'progress':
          if (data.data) {
            this.progressSubject.next({
              currentPath: data.data.currentPath,
              totalPaths: data.data.totalPaths,
              pathProgress: data.data.pathProgress,
            });
          }
          break;
        case 'debug':
          console.debug('[Maze Worker]', data.message, ...(data.args || []));
          break;
        case 'error':
          console.error('[Maze Worker Error]', data.error);
          break;
      }
    };
  }

  private findConnectedConnComponents(graph: Graph, cells: PathCell[]): ConnComponent[] {
    const visited = new Set<string>();
    const connComponents: ConnComponent[] = [];
    
    // Create a map for quick cell lookups
    const cellMap = new Map(cells.map(cell => [cell.linearId.toString(), cell]));
    
    // Helper to get connected neighbors
    const getValidNeighbors = (nodeId: string): string[] => {
      const currentCell = cellMap.get(nodeId);
      if (!currentCell) return [];
      
      return graph.neighbors(nodeId).filter(neighborId => {
        const neighborCell = cellMap.get(neighborId);
        return neighborCell && this.areHexagonsAdjacent(currentCell, neighborCell);
      });
    };
    
    // Use DFS for connComponent finding
    const exploreConnComponent = (startNode: string): Set<string> => {
      const connComponent = new Set<string>();
      const stack = [startNode];
      
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        
        visited.add(current);
        connComponent.add(current);
        
        // Add all unvisited valid neighbors to stack
        const neighbors = getValidNeighbors(current);
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }
      
      return connComponent;
    };
    
    // Find all connComponents
    for (const node of graph.nodes()) {
      if (!visited.has(node)) {
        const nodeSet = exploreConnComponent(node);
        if (nodeSet.size > 0) {
          // Convert node IDs to ConnComponentCells
          const connComponentCells = Array.from(nodeSet)
            .map(id => {
              const cell = cellMap.get(id);
              if (!cell) return undefined;
              const connCell: Omit<PathCell, 'openPaths'> & { neighbors: string[] } = {
                ...cell,
                neighbors: graph.neighbors(cell.linearId.toString())
              };
              return connCell;
            })
            .filter((cell): cell is Omit<PathCell, 'openPaths'> & { neighbors: string[] } => cell !== undefined);

          connComponents.push({
            pixels: connComponentCells,
            size: nodeSet.size,
            bounds: this.calculateBounds(connComponentCells.map(c => c.position.x), connComponentCells.map(c => c.position.y))
          });
        }
      }
    }
    
    // Update totalConnComponents with count of connComponents size 7 or greater
    this.totalConnComponents = connComponents.filter(c => c.pixels.length >= COMPONENT_SIZE_THRESHOLD).length;
    
    console.debug('ConnComponent sizes:', connComponents.map(c => c.pixels.length));
    console.debug('Total connComponents of size 7 or greater:', this.totalConnComponents);

    return connComponents;
  }

  private areHexagonsAdjacent(cell1: PathCell, cell2: PathCell): boolean {
    // Get the row and column differences
    const rowDiff = cell2.position.row - cell1.position.row;
    const colDiff = cell2.position.col - cell1.position.col;

    // For pointy-top hexagons:
    // - Same row: columns must differ by 1
    // - Adjacent rows: column offset depends on row parity
    if (rowDiff === 0) {
      return Math.abs(colDiff) === 1;
    } else if (Math.abs(rowDiff) === 1) {
      if (cell1.position.row % 2 === 0) {
        // Even row: neighbor in next/prev row can be at same col or col-1
        return colDiff === 0 || colDiff === -1;
      } else {
        // Odd row: neighbor in next/prev row can be at same col or col+1
        return colDiff === 0 || colDiff === 1;
      }
    }

    return false;
  }

  private drawHexagon(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number
  ): void {
    const numberOfSides = 6;
    const angle = (2 * Math.PI) / numberOfSides;

    ctx.beginPath();
    for (let i = 0; i <= numberOfSides; i++) {
      const anglePoint = angle * i;
      const pointX = x + size * Math.cos(anglePoint - Math.PI / 2);
      const pointY = y + size * Math.sin(anglePoint - Math.PI / 2);

      if (i === 0) {
        ctx.moveTo(pointX, pointY);
      } else {
        ctx.lineTo(pointX, pointY);
      }
    }
    ctx.closePath();
  }

  private async animatePath(
    connComponents: ProcessedConnComponent[],
    pathMap: PathMap
  ): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    // Store the initial maze state
    let mazeState = ctx.getImageData(0, 0, this.cw, this.ch);

    // Sort by path length but don't limit the number
    const sortedConnComponents = connComponents.sort(
      (a, b) => a.pathLength - b.pathLength
    ); // Ascending order by size

    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    this.hexSize = (pathMap.dimensions.hexWidth) / Math.sqrt(3);
    const hexSize = (1.05 * this.hexSize);

    // Ensure we have enough styles for all paths
    const PATH_STYLES = createInterpolatedStyles(BASE_COLORS, sortedConnComponents.length, 0.8);

    // How many extra frames we want after the path is "complete"
    // to let the ring fade out
    const FADE_FRAMES = 35;
    const FADE_RATE = 0.1; // the factor in 1 - ((i - pxIndex) * FADE_RATE)

    // Add size scaling calculations
    const maxConnComponentSize = Math.max(
      ...connComponents.map((c) => c.pathLength)
    );
    const minConnComponentSize = Math.min(
      ...connComponents.map((c) => c.pathLength)
    );

    // Helper function to calculate hex size multiplier
    const getHexSizeMultiplier = (connComponentSize: number) => {
      // Define bounds for the multiplier
      const MIN_MULTIPLIER = 0.25; // Smallest hexagons (for largest connComponents)
      const MAX_MULTIPLIER = 0.5; // Largest hexagons (for smallest connComponents)

      // Linear interpolation between min and max multiplier
      const sizeRange = maxConnComponentSize - minConnComponentSize;
      const scale =
        sizeRange === 0 ? 1 : (maxConnComponentSize - connComponentSize) / sizeRange;
      return MIN_MULTIPLIER + (MAX_MULTIPLIER - MIN_MULTIPLIER) * scale;
    };

    for (let pathIndex = 0; pathIndex < sortedConnComponents.length; pathIndex++) {
      const connComponent = sortedConnComponents[pathIndex];
      const style = PATH_STYLES[pathIndex];
      const sizeMultiplier = getHexSizeMultiplier(
        connComponent.pathLength
      );

      ctx.putImageData(mazeState, 0, 0);

      // draw the  utline of the current connComponent  // draw the outline of the current connComponent
      await this.drawConnComponentOutline(connComponent, style);

      // Draw ALL previous connComponents' backgrounds first
      for (let i = 0; i < pathIndex; i++) {
        const prevComp = sortedConnComponents[i];
        const prevStyle = PATH_STYLES[i];
        const prevSizeMultiplier = getHexSizeMultiplier(
          prevComp.pathLength
        );

        // Draw small hexagons
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = prevStyle.color;
        prevComp.pixels.forEach((cell) => {
          this.drawHexagon(
            ctx,
            cell.position.x,
            cell.position.y,
            hexSize * prevSizeMultiplier
          );
          ctx.fill();
        });

        // Draw solution paths
        ctx.globalAlpha = 0.75;
        prevComp.pixels.forEach((pixel) => {
          ctx.fillStyle = prevStyle.color;
          this.drawHexagon(ctx, pixel.position.x, pixel.position.y, hexSize);
          ctx.fill();
          ctx.strokeStyle = prevStyle.borderColor;
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      }

      // Draw current connComponent background
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = style.color;
      connComponent.pixels.forEach((cell) => {
        this.drawHexagon(
          ctx,
          cell.position.x,
          cell.position.y,
          hexSize * sizeMultiplier
        );
        ctx.fill();
      });

      // Store this state including all backgrounds
      const stateWithBackgrounds = ctx.getImageData(0, 0, this.cw, this.ch);

      await delay(1200); // Pause to show connComponent

      // Animation loop
      const totalIterations = connComponent.pixels.length + FADE_FRAMES;
      for (let i = 1; i <= totalIterations; i++) {
        const drawLength = Math.min(i, connComponent.pixels.length);
        const currentPixels = connComponent.pixels.slice(0, drawLength);

        // Start with state that includes all backgrounds
        ctx.putImageData(stateWithBackgrounds, 0, 0);

        // Draw current animating path
        currentPixels.forEach((pixel, pixelIndex) => {
          const recentness = 1 - (i - pixelIndex) * FADE_RATE;
          const ringAlpha = Math.max(0, Math.min(1, recentness));

          // Fill
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = style.color;
          this.drawHexagon(ctx, pixel.position.x, pixel.position.y, hexSize);
          ctx.fill();

          // Border
          ctx.lineWidth = 2;
          ctx.strokeStyle = style.borderColor;
          ctx.stroke();

          // Inner glow
          const glowcolor = parseHex(style.glowColor);
          glowcolor.alpha = ringAlpha * 0.8;

          ctx.lineWidth = 4;
          ctx.strokeStyle = glowcolor.toString();
          this.drawHexagon(
            ctx,
            pixel.position.x,
            pixel.position.y,
            hexSize * 0.75
          );
          ctx.stroke();
        });

        await delay(30);
      }

      // Store final state of this connComponent for next iteration
      mazeState = ctx.getImageData(0, 0, this.cw, this.ch);

      await delay(500); // Pause before next path
    }

    // Final progress
    this.progressSubject.next({
      currentPath: sortedConnComponents.length,
      totalPaths: sortedConnComponents.length,
      pathProgress: 1,
    });
  }

  getProgress(): Observable<SolverProgress> {
    return this.progress$;
  }


  /**
 * Find shared vertices between hexagonal cells using a spatial hash for efficiency
 */
private findSharedVertices(
  cells: ConnComponentCell[],
): { doubles: [number, number][]; triples: [number, number, number][] } {
  // Validate input
  if (!cells?.length) {
    throw new Error('No cells provided to findSharedVertices');
  }

  // Filter out invalid cells
  const validCells = cells.filter(
    (cell) => cell?.position && typeof cell.position.x === 'number' && typeof cell.position.y === 'number'
  );

  if (validCells.length !== cells.length) {
    console.warn(`Filtered out ${cells.length - validCells.length} invalid cells`);
  }

  // Calculate vertices for the first cell to initialize the angle offset
  this.calculateVertices(cells[0]);
  
  // The tolerance for considering vertices as coincident - adjust based on your coordinate scale
  const TOLERANCE = 0.5;
  
  // Create a spatial hash with cell size equal to tolerance
  const spatialHash = new SpatialHash(TOLERANCE);
  
  // Add all vertices to the spatial hash
  cells.forEach((cell) => {
    if (this.angleOffset === null) {
      throw new Error('Angle offset is not set');
    }

    // Calculate the vertices for this cell
    const vertices = this.calculateVerticesFromCenter(
      cell.position.x,
      cell.position.y,
    );
    
    // Add each vertex to the spatial hash
    vertices.forEach((vertex, vertexIndex) => {
      spatialHash.add(vertex.x, vertex.y, cell.linearId, vertexIndex);
    });
  });
  
  // Use a "disjoint-set" (Union-Find) algorithm to group nearby vertices
  const allVertices = spatialHash.getAllVertices();
  
  // Create a unique ID for each vertex for use in the disjoint-set
  const vertexIds = new Map<string, number>();
  allVertices.forEach((vertex, index) => {
    const id = `${vertex.cellId}-${vertex.vertexIndex}`;
    vertexIds.set(id, index);
  });
  
  // Initialize disjoint-set
  const parent = new Array(allVertices.length).fill(0).map((_, i) => i);
  const rank = new Array(allVertices.length).fill(0);
  
  // Find operation for disjoint-set (with path compression)
  const find = (x: number): number => {
    if (parent[x] !== x) {
      parent[x] = find(parent[x]);
    }
    return parent[x];
  };
  
  // Union operation for disjoint-set (with rank)
  const union = (x: number, y: number): void => {
    const rootX = find(x);
    const rootY = find(y);
    
    if (rootX === rootY) return;
    
    if (rank[rootX] < rank[rootY]) {
      parent[rootX] = rootY;
    } else if (rank[rootX] > rank[rootY]) {
      parent[rootY] = rootX;
    } else {
      parent[rootY] = rootX;
      rank[rootX]++;
    }
  };
  
  // Group nearby vertices using the spatial hash and disjoint-set
  for (let i = 0; i < allVertices.length; i++) {
    const v1 = allVertices[i];
    const nearby = spatialHash.findNearby(v1.x, v1.y, TOLERANCE);
    
    for (const v2 of nearby) {
      const id1 = `${v1.cellId}-${v1.vertexIndex}`;
      const id2 = `${v2.cellId}-${v2.vertexIndex}`;
      
      const index1 = vertexIds.get(id1)!;
      const index2 = vertexIds.get(id2)!;
      
      union(index1, index2);
    }
  }
  
  // Group vertices by their root in the disjoint-set
  const groups = new Map<number, Set<number>>();
  
  for (let i = 0; i < allVertices.length; i++) {
    const vertex = allVertices[i];
    const root = find(i);
    
    if (!groups.has(root)) {
      groups.set(root, new Set());
    }
    
    groups.get(root)!.add(vertex.cellId);
  }
  
  // Extract doubles and triples
  const doubles: [number, number][] = [];
  const triples: [number, number, number][] = [];
  const vertexDistribution = new Map<number, number>();
  
  groups.forEach((cellIds) => {
    // Update distribution count
    vertexDistribution.set(
      cellIds.size,
      (vertexDistribution.get(cellIds.size) || 0) + 1
    );
    
    // Convert Set to Array
    const cellIdsArray = Array.from(cellIds);
    
    // Add to appropriate result array based on number of shared vertices
    if (cellIdsArray.length === 2) {
      doubles.push([cellIdsArray[0], cellIdsArray[1]] as [number, number]);
    } else if (cellIdsArray.length === 3) {
      triples.push([cellIdsArray[0], cellIdsArray[1], cellIdsArray[2]] as [number, number, number]);
    }
  });

  console.log('Vertex sharing distribution:', Object.fromEntries(vertexDistribution.entries()));
  console.log('Found shared vertices:', { doubles: doubles.length, triples: triples.length });

  return { doubles, triples };
}

  private async drawConnComponentOutline(
    connComponent: ProcessedConnComponent, 
    style: PathStyle
  ): Promise<void> {
    if (!connComponent || !connComponent.pixels) {
      console.warn('Invalid connComponent data:', connComponent);
      return;
    }

    // Validate all cells have required properties
    const validCells = connComponent.pixels.filter(cell => 
      cell && 
      cell.position && 
      cell.referenceVertex &&
      typeof cell.position.x === 'number' &&
      typeof cell.position.y === 'number' &&
      typeof cell.referenceVertex.x === 'number' &&
      typeof cell.referenceVertex.y === 'number'
    );

    if (validCells.length === 0) {
      console.warn('No valid cells in connComponent');
      return;
    }

   const { doubles, triples } = this.findSharedVertices(validCells);
    
    if (!this.ctx) return;

    this.ctx.save();
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 5;
    this.ctx.globalAlpha = 0.9;

    // Process each cell in the connComponent
    connComponent.pixels.forEach(cell => {
        // Get vertices for this cell in order (clockwise or counterclockwise)
        const vertices = this.calculateVerticesFromCenter(
            cell.position.x,
            cell.position.y,
        );

        // Iterate through vertices to draw edges
        for (let i = 0; i < vertices.length; i++) {
            const currentVertex = vertices[i];
            const nextVertex = vertices[(i + 1) % vertices.length];

            // Skip if current vertex is in triples list
            if (this.isPointInList(currentVertex.x, currentVertex.y, triples)) {
                continue;
            }

            // Skip if next vertex is in triples list
            if (this.isPointInList(nextVertex.x, nextVertex.y, triples)) {
                i++; // Skip next iteration as this edge won't be drawn
                continue;
            }

            // Check if both vertices are in doubles list
            const currentInDoubles = this.isPointInList(currentVertex.x, currentVertex.y, doubles);
            const nextInDoubles = this.isPointInList(nextVertex.x, nextVertex.y, doubles);

            if (currentInDoubles && nextInDoubles) {
                i++; // Skip next iteration as this edge and the next are internal
                continue;
            }

            if (!this.ctx) return;
            // If we get here, this edge should be drawn
            this.ctx.beginPath();
            this.ctx.moveTo(currentVertex.x, currentVertex.y);
            this.ctx.lineTo(nextVertex.x, nextVertex.y);
            this.ctx.stroke();
        }
    });

    this.ctx.restore();
}


  private isPointInList(x: number, y: number, list: number[][]): boolean {
    const TOLERANCE = 0.05;

    return list.some(([vx, vy]) => {
      return Math.abs(vx - x) < TOLERANCE && Math.abs(vy - y) < TOLERANCE;
    });
  }

  private calculateVertices(
    cell: ConnComponentCell
  ): { x: number; y: number }[] {
    if (!cell?.position || !cell.referenceVertex) {
      throw new Error(`Missing position or reference vertex for cell: ${cell?.linearId}`);
    }

    const dx = cell.referenceVertex.x - cell.position.x;
    const dy = cell.referenceVertex.y - cell.position.y;
    
    // Calculate angle from center to reference vertex
    this.angleOffset = Math.atan2(dy, dx);

    // Calculate and cache the displacement vectors if not already done
    if (this.displacementVectors.length === 0) {
      for (let k = 0; k < 6; k++) {
        const angle = this.angleOffset + (k * Math.PI) / 3;
        const dx = this.hexSize * Math.cos(angle);
        const dy = this.hexSize * Math.sin(angle);
        this.displacementVectors.push({ dx, dy });
      }
    }

    return this.calculateVerticesFromCenter(
      cell.position.x,
      cell.position.y
    );
  }
  private calculateVerticesFromCenter(
    centerX: number,
    centerY: number
  ): { x: number; y: number }[] {
    // Simply add the displacement vectors to the center coordinates
    return this.displacementVectors.map(({ dx, dy }) => ({
      x: centerX + dx,
      y: centerY + dy
    }));
  }

// This function analyzes the connComponents in the pathMap and returns a list of large and small connComponents
  private analyzeConnComponents(connComponents: ConnComponent[], graph: Graph): { 
    largeConnComponents: { connComponent: ConnComponent, size: number, adjacencyList: Record<string, string[]>, graph: Graph }[],
    smallConnComponents: { connComponent: ConnComponent, size: number, adjacencyList: Record<string, string[]>, graph: Graph }[]
  } {

    const largeConnComponents: {  connComponent: ConnComponent, size: number, adjacencyList: Record<string, string[]>, graph: Graph }[] = [];
    const smallConnComponents: {  connComponent: ConnComponent, size: number, adjacencyList: Record<string, string[]>, graph: Graph }[] = [];

    connComponents.forEach(connComponent => {
      const subgraph = this.createSubgraph(connComponent.pixels.map(c => c.linearId.toString()), graph);
      
      // Create adjacency list
      const adjacencyList: Record<string, string[]> = {};

      subgraph.forEachNode((node) => {
        adjacencyList[node] = subgraph.neighbors(node);
      });
    
      if (connComponent.size > 2100) {
        console.log('component is TOO LARGE, must abort:', connComponent.size);
        return;
      } else if (connComponent.size >= LARGE_COMPONENT_THRESHOLD) {
        largeConnComponents.push({
          connComponent: connComponent,
          size: connComponent.size,
          adjacencyList: adjacencyList,
          graph: subgraph
        });
      } else {
        smallConnComponents.push({
          connComponent: connComponent,
          size: connComponent.size,
          adjacencyList,
          graph: subgraph
        });
      }
    });

    return { largeConnComponents, smallConnComponents };
  }

  private calculateBounds(xCoords: number[], yCoords: number[]): ConnComponent['bounds'] {
    const minX = Math.min(...xCoords)-this.hexSize*0.866;
    const maxX = Math.max(...xCoords)+this.hexSize*0.866;
    const minY = Math.min(...yCoords)-this.hexSize;
    const maxY = Math.max(...yCoords)+this.hexSize;
    return { minX, maxX, minY, maxY };
  }


  private createSubgraph(nodeList: string[], graph: Graph): Graph {
    // Create an empty subgraph
    const subgraph = new Graph();
    const subgraphNodes = new Set(nodeList);

    // Iterate over nodes:
    graph.forEachNode((node, attributes) => {
      if (subgraphNodes.has(node)) {
        subgraph.addNode(node, attributes);
      }
    });

    // Iterate over edges:
    graph.forEachEdge((edge, attr, source, target) => {
      // Only add the edge if both endpoints are in the subgraph
      if (subgraphNodes.has(source) && subgraphNodes.has(target)) {
        subgraph.addEdgeWithKey(edge, source, target, attr);
      }
    });
    return subgraph;
  }

private async solveRemotely(
  connComponents: { adjacencyList: Record<string, string[]> }[]
): Promise<string[][]> {
  // Format the adjacency lists as the Python backend expects
  const payload = {
    largeComponents: connComponents.map(comp => comp.adjacencyList)
  };
  
  const ws = new WebSocket(environment.websocketUrl);

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;

    ws.onopen = () => {
      console.debug('WebSocket connected');
      console.debug('Payload structure:', {
        fullPayload: payload,
        type: typeof payload,
        largeComponentsType: typeof payload.largeComponents,
        firstComponent: payload.largeComponents[0]
      });
      
      timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket operation timed out'));
      }, 30000); // 6 seconds

      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      try {
        console.debug('Received WebSocket message:', event.data);
        
        // Parse the response
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (error) {
          const parseError = error as Error;
          console.error('Failed to parse WebSocket response:', event.data);
          throw new Error(`Invalid JSON response: ${parseError.message}`);
        }
        
        // Check for server error response
        if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'internal_error') {
          throw new Error(`Server error: ${data.error}`);
        }
        
        // Validate that we received an array
        if (!Array.isArray(data)) {
          console.error('Received non-array data:', data);
          throw new Error(`Expected array of paths from server, got ${typeof data}`);
        }
        
        // Validate each path is an array
        const paths: string[][] = data.filter((path, index) => {
          if (!Array.isArray(path)) {
            console.warn(`Path at index ${index} is not an array:`, path);
            return false;
          }
          return true;
        });
        
        if (paths.length !== data.length) {
          console.warn(`Filtered out ${data.length - paths.length} invalid paths`);
        }
        
        if (paths.length === 0) {
          console.warn('No valid paths found in response');
        }
        
        clearTimeout(timeout);
        ws.close();
        
        resolve(paths);
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    ws.onclose = (event) => {
      console.debug('WebSocket closed:', event);
      clearTimeout(timeout);
      if (!event.wasClean) {
        reject(new Error(`WebSocket connection closed unexpectedly: ${event.code}`));
      }
    };
  });
}

  private async solveLocally(
    connComponent: ConnComponent,
    graph: Graph,
    worker: Worker
  ): Promise<ProcessedConnComponent> {
    // Prepare data for worker
    const workerData: WorkerData = {
      edges: graph.mapEdges((edge, attributes, source, target) => {
        return { from: parseInt(source), to: parseInt(target) };
      }),
      cells: connComponent.pixels.map(cell => ({
        id: cell.linearId,
        position: {
          x: cell.position.x,
          y: cell.position.y,
          row: cell.position.row,
          col: cell.position.col
        },
        referenceVertex: {
          x: cell.referenceVertex.x,
          y: cell.referenceVertex.y
        }
      }))
    };

    // Send message to worker and wait for response
    worker.postMessage(workerData);

    return new Promise((resolve, reject) => {
      const messageHandler = ({ data }: MessageEvent<WorkerMessage>) => {
        if (data.type === 'result') {
          worker.removeEventListener('message', messageHandler);
          resolve({
            ...connComponent,
            pathLength: data.data.path.length,
            path: data.data.path
          });
        } else if (data.type === 'error') {
          worker.removeEventListener('message', messageHandler);
          reject(new Error(data.error));
        }
      };
      worker.addEventListener('message', messageHandler);
    });
  }
}

export type LchColor = Color & {
  mode: 'lch';
  l: number;
  c: number;
  h: number;
  alpha: number;
};
/**
 * Uses natural spline interpolation in LCH space to produce `total` colors.
 * Fixes up the hue so each consecutive hue is >= the previous.
 * Clamps each interpolated color to the sRGB gamut.
 * Then creates border colors by increasing lightness by +20 (capped at 100).
 */
export function createInterpolatedStyles(
  baseHexColors: string[],
  total: number,
  alpha: number = 0.8
): PathStyle[] {
  if (baseHexColors.length < 2) {
    throw new Error('Need at least two base colors to interpolate.');
  }
  if (total < 2) {
    throw new Error('Total interpolated colors must be at least 2.');
  }

  // 1. Convert each hex color to LCH.
  const toLch = converter('lch');
  const lchArray: LchColor[] = baseHexColors.map(hex => {
    const parsed = parseHex(hex);
    if (!parsed) {
      throw new Error(`Invalid hex color: ${hex}`);
    }
    const converted = toLch(parsed);
    if (!converted) {
      throw new Error(`Conversion to LCH failed for ${hex}`);
    }
    // Force the type to LchColor and add alpha
    return { ...converted, mode: 'lch', alpha } as LchColor;
  });

  // 2. Ensure each successive hue is >= the previous hue
  //    by using fixupHueIncreasing. This prevents
  //    e.g. jumping from 359 back down to 0.
  const hues = lchArray.map((c) => c.h);
  const fixedHues = fixupHueIncreasing(hues); 
  for (let i = 0; i < lchArray.length; i++) {
    lchArray[i].h = fixedHues[i];
  }

  // 3. Separate L, C, and H channels into arrays for the spline
  const lArr = lchArray.map(c => c.l);
  const cArr = lchArray.map(c => c.c);
  const hArr = lchArray.map(c => c.h);

  // 4. Build a natural spline for each channel
  const splineL = interpolatorSplineNatural(lArr);
  const splineC = interpolatorSplineNatural(cArr);
  const splineH = interpolatorSplineNatural(hArr);

  // 5. Interpolate and reassemble into LCH
  const result: LchColor[] = [];
  const clamper = clampGamut('lch');

  for (let i = 0; i < total; i++) {
    const t = i / (total - 1);

    const L = splineL(t);
    const C = splineC(t);
    let H = splineH(t);

    const interpolatedColor: LchColor = {
      mode: 'lch',
      l: L,
      c: C,
      h: H,
      alpha
    };

    // Clamp to sRGB so channels remain valid
    const clamped = clamper(interpolatedColor) as LchColor;
    result.push(clamped);
  }

  // Convert the main interpolated colors to hex
  const colorHex = result.map((color: LchColor) => formatHex8(color));

  // 6. Create border colors by increasing lightness by 20 (capped at 100)
  const borderColors: LchColor[] = result.map((color: LchColor) => {
    return {
      ...color,
      l: Math.min(100, color.l + 20),
      mode: 'lch'
    } as LchColor;
  });

  const borderHex = borderColors.map(color => formatHex8(color));

  // 7. Build the final PathStyle array
  const styles: PathStyle[] = colorHex.map((clr, index) => ({
    color: clr,
    borderColor: borderHex[index],
    alpha,
    glowColor: '#f0f4ff'
  }));

  return styles;
}

/**
 * A spatial hash implementation for efficiently finding nearby points in 2D space
 */
class SpatialHash {
  private cells: Map<string, Array<{ x: number; y: number; cellId: number; vertexIndex: number }>> = new Map();
  private cellSize: number;

  /**
   * Create a new spatial hash
   * @param cellSize The size of each cell in the hash grid
   */
  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  /**
   * Add a point to the spatial hash
   */
  add(x: number, y: number, cellId: number, vertexIndex: number): void {
    const key = this.getCellKey(x, y);
    if (!this.cells.has(key)) {
      this.cells.set(key, []);
    }
    this.cells.get(key)!.push({ x, y, cellId, vertexIndex });
  }

  /**
   * Get the key for a grid cell containing the given point
   */
  private getCellKey(x: number, y: number): string {
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    return `${cellX},${cellY}`;
  }

  /**
   * Find all points within tolerance distance of a given point
   */
  findNearby(x: number, y: number, tolerance: number): Array<{ x: number; y: number; cellId: number; vertexIndex: number }> {
    const minCellX = Math.floor((x - tolerance) / this.cellSize);
    const maxCellX = Math.floor((x + tolerance) / this.cellSize);
    const minCellY = Math.floor((y - tolerance) / this.cellSize);
    const maxCellY = Math.floor((y + tolerance) / this.cellSize);
    
    const result: Array<{ x: number; y: number; cellId: number; vertexIndex: number }> = [];
    
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = `${cellX},${cellY}`;
        const pointsInCell = this.cells.get(key);
        
        if (pointsInCell) {
          for (const point of pointsInCell) {
            const dx = point.x - x;
            const dy = point.y - y;
            const distanceSquared = dx * dx + dy * dy;
            
            if (distanceSquared <= tolerance * tolerance) {
              result.push(point);
            }
          }
        }
      }
    }
    
    return result;
  }

  /**
   * Get all vertices in the spatial hash
   */
  getAllVertices(): Array<{ x: number; y: number; cellId: number; vertexIndex: number }> {
    const result: Array<{ x: number; y: number; cellId: number; vertexIndex: number }> = [];
    for (const [_, vertices] of this.cells) {
      result.push(...vertices);
    }
    return result;
  }
}