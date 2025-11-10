// maze-solver.service.ts
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
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

export interface ProcessedConnComponent{
  pathLength: number;
  path:string[]; // ["1" ,"6", "27", "2", ... ]
  connComponent: ConnComponent;
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

interface OutgoingPayload {
  components: Record<string, string[]>[];
  dimensions: {
    rows: number;
    cols: number;
  };
}

interface ReturnedPayload {
  session_id: string;
  data: string[][];
}

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
  ) {}

  /* ────────────────────────────────────────────────────────────────────────── */
  /* PUBLIC API                                                                */
  /* ────────────────────────────────────────────────────────────────────────── */
  async solveMaze(pathMap: PathMap): Promise<[ProcessedConnComponent[], string]> {
    // build graphology graph from pathMap
    const graph = new Graph({ type: 'undirected', multi: false});
    pathMap.cells.forEach(c => graph.addNode(c.linearId.toString()));
    pathMap.edges.forEach(e => graph.addEdge(e.from.toString(), e.to.toString()));

    const connComponents = this.findConnectedComponents(graph, pathMap.cells);
    const allForBackend = connComponents.map(c => ({ adjacencyList: this.toAdj(c) }));

    const payload: OutgoingPayload = {
      components: allForBackend.map(c => c.adjacencyList),
      dimensions: pathMap.dimensions
    };

    // Fetch the full payload including session_id and data
    const returnedPayload = await (environment.preferWebsocket ? this.tryWebsocketThenRest(payload) : this.solveViaRest(payload));

    const processedComponents = this.mergeSolutions(connComponents, returnedPayload);

    // Return the processed components and the session_id
    return [processedComponents, returnedPayload.session_id];
  }

  /* ────────────────────────────────────────────────────────────────────────── */
  /* TRANSPORTS                                                                */
  /* ────────────────────────────────────────────────────────────────────────── */
  private tryWebsocketThenRest(payload: any): Promise<ReturnedPayload> {
    return new Promise(async (resolve) => {
      try {
        const wsResult = await this.solveViaWebsocket(payload);
        resolve(wsResult);
      } catch (e) {
        console.warn('WS failed, falling back to HTTPS ➜', e);
        const restResult = await this.solveViaRest(payload);
        resolve(restResult);
      }
    });
  }

  private solveViaRest(body: OutgoingPayload): Promise<ReturnedPayload> {

    return firstValueFrom(
      this.http.post<ReturnedPayload>(environment.restUrl, body)
    );
  }

  private solveViaWebsocket(body: any): Promise<ReturnedPayload> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(environment.websocketUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket timeout'));
      }, 60000); // Consider making timeout configurable

      ws.onopen = () => ws.send(JSON.stringify(body));

      ws.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data);
          // Expect session_id and data in the message
          if (msg.type === 'solution' && msg.session_id && msg.data) {
            clearTimeout(timer);
            ws.close();
            // Resolve with the full ReturnedPayload object
            resolve({
              session_id: msg.session_id,
              data: msg.data as string[][]
            });
          } else if (msg.type === 'error') {
            // Handle potential backend errors explicitly
             clearTimeout(timer);
             ws.close();
             console.error('WebSocket error message:', msg.error || 'Unknown error');
             reject(new Error(msg.error || 'WebSocket returned an error'));
          } else {
             // Handle unexpected message format
             console.warn('Received unexpected WebSocket message format:', msg);
             // Optionally reject or ignore, depending on desired robustness
          }
        } catch (parseError) {
          clearTimeout(timer);
          ws.close();
          console.error('Failed to parse WebSocket message:', ev.data, parseError);
          reject(new Error('Failed to parse WebSocket message'));
        }
      };

      ws.onerror = err => {
        clearTimeout(timer);
        ws.close();
        // Reject with the actual error event
        reject(err);
      };
    });
  }

  private findConnectedComponents(graph: Graph, cells: PathCell[]): ConnComponent[] {
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


  private calculateBounds(xCoords: number[], yCoords: number[]): ConnComponent['bounds'] {
    const minX = Math.min(...xCoords)-this.hexSize*0.866;
    const maxX = Math.max(...xCoords)+this.hexSize*0.866;
    const minY = Math.min(...yCoords)-this.hexSize;
    const maxY = Math.max(...yCoords)+this.hexSize;
    return { minX, maxX, minY, maxY };
  }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             
/*   private createSubgraph(nodeList: string[], graph: Graph): Graph {
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
  } */

    /* ------------------------------------------------------------------ */
  /* DATA SHAPING                                                        */
  /* ------------------------------------------------------------------ */

  /** Convert a ConnComponent into the adjacency‑list object expected by backend */
  private toAdj(component: ConnComponent): Record<string, string[]> {
    const idsInComponent = new Set(component.pixels.map(p => p.linearId.toString()));
    const adj: Record<string, string[]> = {};
    component.pixels.forEach(p => {
      const id = p.linearId.toString();
      // Ensure neighbors is not null before filtering
      const nbrs = (p.neighbors ?? []).filter(n => idsInComponent.has(n));
      adj[id] = nbrs;
    });
    return adj;
  }

  /**
   * Bring backend longest‑paths back into the original ConnComponent objects,
   * validating the correspondence between paths and components.
   */
  private mergeSolutions(
    components: ConnComponent[],
    solutionPayload: ReturnedPayload // Now accepts the full payload
  ): ProcessedConnComponent[] {
    const processed: ProcessedConnComponent[] = [];
    const solutionPaths = solutionPayload.data; // Extract paths

    if (components.length !== solutionPaths.length) {
       console.error(`CRITICAL VALIDATION FAILED: Mismatched lengths between components (${components.length}) and solution paths (${solutionPaths.length}). Session ID: ${solutionPayload.session_id}`);
       throw new Error('Component and solution path counts do not match.');
    }

    // --- Validation Step ---
    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      const path = solutionPaths[i]; // Path can be empty []

      // Only validate if the path is not empty
      if (path && path.length > 0) {
        const firstLinearId = path[0];
        // Create a set for efficient lookup of linearIds in the current component
        const componentLinearIds = new Set(comp.pixels.map(p => p.linearId.toString()));

        // Check if the first ID in the path exists in the component
        if (!componentLinearIds.has(firstLinearId)) {
          console.error(`CRITICAL VALIDATION FAILED: Path ${i}'s first element (${firstLinearId}) not found in component ${i}. Session ID: ${solutionPayload.session_id}`, { component: comp, path: path });
          // Decide how to handle: throw an error to stop processing
          throw new Error(`Data validation failed: Path ${i} does not correspond to component ${i}.`);
        }
      }
    }
    // --- End Validation Step ---


    // If validation passes, proceed with merging
    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      // Ensure path exists, default to empty array if not
      const path = (solutionPaths && solutionPaths[i]) ? solutionPaths[i] : [];

      processed.push({
        connComponent: comp,
        path: path,
        pathLength: path.length
      });
    }
    return processed;
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
