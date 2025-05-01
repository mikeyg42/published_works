// maze-solver.service.ts
import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private http: HttpClient
  ) {
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
  const ws = new WebSocket(environment.websocketUrl);

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    let connectionAttempted = false;
    let connectionTimeoutId: NodeJS.Timeout | null = null;

    const cleanup = (timerId: NodeJS.Timeout | null) => {
      if (timerId) clearTimeout(timerId);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          console.debug('Cleaning up and closing WebSocket.');
          ws.close();
      }
    };

    // Connection attempt timeout
    connectionTimeoutId = setTimeout(() => {
      connectionTimeoutId = null;
      if (!connectionAttempted) {
        console.error('WebSocket connection attempt timed out after 10 seconds');
        cleanup(timeout);
        reject(new Error('WebSocket connection attempt timed out after 10 seconds'));
      }
    }, 10000); // Increased connection timeout

    ws.onopen = () => {
      connectionAttempted = true;
      if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
      console.log('WebSocket connected successfully. Sending payload...');
      
      // Operation timeout
      timeout = setTimeout(() => {
        timeout = null;
        console.error('WebSocket operation timed out after 60 seconds (no solution received)');
        cleanup(connectionTimeoutId);
        reject(new Error('WebSocket operation timed out after 60 seconds'));
      }, 60000); 

      try {
        ws.send(payload);
        console.log('Payload sent successfully');
      } catch (err) {
        console.error('Error sending payload:', err);
        cleanup(timeout);
        cleanup(connectionTimeoutId);
        reject(err);
      }
    };

    ws.onmessage = (event) => {
      let receivedData: any;
      try {
        console.debug('Received WebSocket message:', event.data);
        receivedData = JSON.parse(event.data);

        // --- Expect only the 'solution' message type --- 
        if (typeof receivedData === 'object' && receivedData !== null && receivedData.type === 'solution') {
            if (Array.isArray(receivedData.data) && typeof receivedData.session_id === 'string') {
                const solutionPaths: string[][] = receivedData.data;
                const sessionId: string = receivedData.session_id;
                
                console.log(`Received solution for session: ${sessionId}`);
                cleanup(timeout); // Clear operation timeout
                cleanup(connectionTimeoutId); // Clear connection timeout just in case
                
                // 1. Resolve the promise with the solution paths
                resolve(solutionPaths);
                
                // 2. Trigger visualization request (fire and forget)
                const visualizeUrl = `${environment.visualizeUrl(sessionId)}`;
                console.log(`Triggering visualization GET request to: ${visualizeUrl}`);
                this.http.get(visualizeUrl, { responseType: 'blob' }) // Expecting an image/blob
                    .subscribe({
                        next: () => console.log(`Successfully triggered visualization for ${sessionId}`),
                        error: (err) => console.error(`Error triggering visualization for ${sessionId}:`, err)
                    });
                    
                // 3. Close the WebSocket (explicitly, though cleanup might already do it)
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
                return; // Processing done for this message
            } else {
                throw new Error(`Invalid 'solution' message format. Missing or incorrect 'data' or 'session_id'.`);
            }
        }
        // --- Handle other expected informational message types --- 
        else if (typeof receivedData === 'object' && receivedData !== null && receivedData.type === 'queued'){
            console.log(`Task queued - ID: ${receivedData.task_id}, Position: ${receivedData.position}`);
            // Keep waiting
        }
        else if (typeof receivedData === 'object' && receivedData !== null && receivedData.type === 'processing_started'){
            console.log(`Processing started for session: ${receivedData.session_id}`);
            // Keep waiting
        }
        // --- Handle Visualization Ready (Optional, but good practice) ---
        else if (typeof receivedData === 'object' && receivedData !== null && receivedData.type === 'visualization_ready'){
            console.log(`Visualization ready message received for session ${receivedData.session_id}. URL: ${receivedData.url}`);
            // You could potentially use receivedData.url here if needed, 
            // but we are already triggering the GET request above.
            // Close WS if not already closed
            cleanup(timeout);
            cleanup(connectionTimeoutId);
        }
         // --- Handle errors from backend --- 
        else if (typeof receivedData === 'object' && receivedData !== null && receivedData.type === 'internal_error') {
           throw new Error(`Server error: ${receivedData.error || 'Unknown error'}`);
        }
        // --- Handle visualization errors --- 
        else if (typeof receivedData === 'object' && receivedData !== null && receivedData.type === 'visualization_error') {
           console.error(`Backend reported visualization error: ${receivedData.error || 'Unknown error'}`);
           // Don't reject the main promise, just log the error.
           // Visualization might be secondary to the solution itself.
        }
        // --- Reject unexpected formats --- 
        else {
            console.warn('Received unexpected data format:', receivedData);
            // Optionally reject or just ignore, depending on requirements
            // throw new Error(`Unexpected WebSocket message format: ${JSON.stringify(receivedData)}`); 
        }

      } catch (error) {
        console.error('Error processing WebSocket message:', error);
        cleanup(timeout);
        cleanup(connectionTimeoutId);
        reject(error);
      }
    };
  
    ws.onerror = (error) => {
      // Use 'event' instead of 'error' which might not be standard
      const errorEvent = error instanceof Event ? error : null;
      console.error('WebSocket error event:', errorEvent);
      console.error('WebSocket connection failed. Check backend server and network.');
      console.error('Backend URL attempted:', environment.websocketUrl);
      cleanup(timeout);
      cleanup(connectionTimeoutId); 
      reject(new Error('WebSocket connection error. See console for details.'));
    };

    ws.onclose = (event) => {
      console.debug(`WebSocket closed: Code=${event.code}, Reason=${event.reason || 'N/A'}, Clean=${event.wasClean}`);
      // Ensure timers are cleared on close, regardless of how it closed
      cleanup(timeout);
      cleanup(connectionTimeoutId);
      // If connection was never established, reject the promise
      if (!connectionAttempted && !event.wasClean) {
           reject(new Error(`WebSocket connection closed unexpectedly: Code=${event.code}`));
      }
      // If the promise hasn't been resolved yet (e.g., closed before solution received), reject it.
      // Note: Need a flag to track if promise was resolved to avoid rejecting after success.
      // Let's assume the timeout handles the case where no solution is received.
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
