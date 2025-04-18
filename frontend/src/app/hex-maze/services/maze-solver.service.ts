// maze-solver.service.ts
import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { PathCell, PathMap } from './maze-generator.service';
import Graph from 'graphology';
import { Color, formatHex8, converter, parseHex, interpolatorSplineNatural, clampGamut, fixupHueIncreasing} from 'culori';
import { environment } from '../../../environments/environment';

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

export interface ProcessedConnComponent extends ConnComponent {
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

const COMPONENT_SIZE_THRESHOLD = 8

@Injectable({
  providedIn: 'root',
})
export class MazeSolverService {
  private hexSize: number = 0;
  private totalConnComponents: number = 0;
  
  private progressSubject = new BehaviorSubject<SolverProgress>({
    currentPath: 0,
    totalPaths: 0,
    pathProgress: 0,
  });
  progress$ = this.progressSubject.asObservable();

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
  }

  async solveMaze(
    pathMap: PathMap
  ): Promise<ProcessedConnComponent[]> {

    // Find connected connComponents once
    const graph = new Graph({ type: 'undirected', multi: false});
          // Add nodes 
    pathMap.cells.forEach(cell => {
      graph.addNode(cell.linearId.toString());
    });
      
    // Add edges
    pathMap.edges.forEach(edge => {
      graph.addEdge(edge.from.toString(), edge.to.toString());
    });

    // Find connected connComponents
    const connComponents = this.findConnectedConnComponents(graph, pathMap.cells);
    
    const allConnComponents = this.analyzeConnComponents(connComponents, graph).allConnComponents;
    
    const remoteResults = allConnComponents?.length > 0
      ? await this.solveRemotely(allConnComponents.map(comp => ({ adjacencyList: comp.adjacencyList })), pathMap)
      : [];

    const processedConnComponents: ProcessedConnComponent[] = [];

    remoteResults.forEach(path => {
      if (path.length === 0) return;

      const firstNode = path[0];

      // Find the connected component containing the first node of the path
      const matchingComponent = connComponents.find(cc =>
        cc.pixels.some(pixel => pixel.linearId.toString() === firstNode)
      );

      if (!matchingComponent) {
        console.warn(`No matching component found for path starting with node ${firstNode}`);
        return;
      }

      // Merge path data into the matching component
      const procConnComponent: ProcessedConnComponent = {
        ...matchingComponent,
        path: path,
        pathLength: path.length
      };

      processedConnComponents.push(procConnComponent);
    });

    return processedConnComponents;
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

// This function analyzes the connComponents in the pathMap and returns a list of large and small connComponents
  private analyzeConnComponents(connComponents: ConnComponent[], graph: Graph): { 
    allConnComponents: { 
      connComponent: ConnComponent, 
      size: number, 
      adjacencyList: Record<string, { 
        neighbors: string[], 
        position: { row: number, col: number } 
      }>, 
      graph: Graph 
    }[],
  } {
    const allConnComponents: any[] = [];

    connComponents.forEach(connComponent => {
      if (connComponent.size < COMPONENT_SIZE_THRESHOLD) {
        return;
      }
      const subgraph = this.createSubgraph(connComponent.pixels.map(c => c.linearId.toString()), graph);
      
      // Create enhanced adjacency list with position information
      const adjacencyList: Record<string, { 
        neighbors: string[], 
        position: { row: number, col: number } 
      }> = {};

      connComponent.pixels.forEach(pixel => {
        adjacencyList[pixel.linearId.toString()] = {
          neighbors: subgraph.neighbors(pixel.linearId.toString()),
          position: {
            row: pixel.position.row,
            col: pixel.position.col
          }
        };
      });
    
      allConnComponents.push({
          connComponent: connComponent,
          size: connComponent.size,
          adjacencyList: adjacencyList,
          graph: subgraph
      });
    });

    return { allConnComponents };
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
  connComponents: { 
    adjacencyList: Record<string, { 
      neighbors: string[], 
      position: { row: number, col: number } 
    }> 
  }[], pathMap: PathMap
): Promise<string[][]> {
  // Format the payload for the backend
  const payload = JSON.stringify({
    largeComponents: connComponents.map(comp => {
      // Convert enhanced adjacency list back to simple format expected by backend
      const simpleAdjList: Record<string, string[]> = {};
      Object.entries(comp.adjacencyList).forEach(([nodeId, data]) => {
        simpleAdjList[nodeId] = data.neighbors;
      });
      return simpleAdjList;
    }),
    dimensions: pathMap.dimensions
  });
  
  console.log('Attempting to connect to WebSocket at:', environment.websocketUrl);
  console.log('Current origin:', window.location.origin);
  console.log('Protocol:', window.location.protocol);
  
  // Create WebSocket without any extra parameters that might cause issues
  const ws = new WebSocket(environment.websocketUrl);

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    let taskId: string | null = null;
    
    let connectionAttempted = false;
    let connectionTimeoutId: NodeJS.Timeout;

    // Set a timeout for the initial connection attempt
    connectionTimeoutId = setTimeout(() => {
      if (!connectionAttempted) {
        console.error('WebSocket connection attempt timed out after 5 seconds');
        console.error('No connection events were triggered');
        console.error('WebSocket URL:', environment.websocketUrl);
        console.error('Current origin:', window.location.origin);
        console.error('Protocol:', window.location.protocol);
        ws.close();
        reject(new Error('WebSocket connection attempt timed out after 5 seconds'));
      }
    }, 5000);

    ws.onopen = () => {
      connectionAttempted = true;
      clearTimeout(connectionTimeoutId);
      console.log('WebSocket connected successfully');
      console.log('Sending payload to server...');
      
      timeout = setTimeout(() => {
        console.error('WebSocket operation timed out after 30 seconds');
        console.error('No response received from server');
        ws.close();
        reject(new Error('WebSocket operation timed out after 30 seconds'));
      }, 30000); // 30 seconds timeout

      try {
        ws.send(payload);
        console.log('Payload sent successfully');
      } catch (err) {
        console.error('Error sending payload:', err);
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
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
        
        // Handle queue status message
        if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'queued') {
          console.log(`Task queued - ID: ${data.task_id}, Position: ${data.position}`);
          taskId = data.task_id;
          // Continue waiting for the actual result
          return;
        }
        
        // Handle results message
        if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'results' && 'paths' in data) {
          // Extract paths from results object
          if (Array.isArray(data.paths)) {
            clearTimeout(timeout);
            ws.close();
            resolve(data.paths);
            return;
          }
          throw new Error(`Invalid paths data in results: ${typeof data.paths}`);
        }

        // Handle solution message directly from _solve_maze_internal
        if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'solution' && 'data' in data) {
          if (Array.isArray(data.data)) {
            clearTimeout(timeout);
            ws.close();
            resolve(data.data);
            return;
          }
          throw new Error(`Invalid solution data: ${typeof data.data}`);
        }
        
        // If we receive an array directly (old server format), use it
        if (Array.isArray(data)) {
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
          return;
        }
        
        console.error('Received unexpected data format:', data);
        throw new Error(`Unexpected response format: ${typeof data}`);
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      if (!connectionAttempted) {
        console.error('Failed to connect to WebSocket. Check if the backend server is running and accessible.');
        console.error('If using HTTPS for the backend, make sure to use WSS for WebSocket connections.');
        console.error('Backend URL:', environment.websocketUrl);
        console.error('Current origin:', window.location.origin);
        console.error('Protocol:', window.location.protocol);
        reject(new Error('WebSocket connection failed. Check console for details.'));
      }
    };

    ws.onclose = (event) => {
      console.debug('WebSocket closed:', event.code, event.reason);
      clearTimeout(timeout);
      if (!connectionAttempted) {
        console.error('WebSocket connection closed with code:', event.code);
        console.error('Reason:', event.reason || 'No reason provided');
        console.error('Was clean:', event.wasClean);
        reject(new Error(`WebSocket connection closed: ${event.code} - ${event.reason}`));
      }
    };
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
