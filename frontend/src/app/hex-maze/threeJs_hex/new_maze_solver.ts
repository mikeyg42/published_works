// maze-solver.service.ts
import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { MazeData } from './maze-api.service';
import Graph from 'graphology';
import { environment } from '../../environments/environment';
import { PathCell, PathMap } from './maze-generator.service';

export interface ConnComponent {
  pixels: ConnComponentCell[];
  size: number; // number of hexagons in the component
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
}

export interface ConnComponentCell {
  linearId: number; // 1-indexed
  position: {
    x: number; // center of hexagon
    y: number; // center of hexagon
    row: number;
    col: number;
  };
  // List of neighbor linear IDs as strings
  neighbors: string[] | null;
  referenceVertex: {
    x: number;
    y: number;
  };
}

export interface ProcessedConnComponent extends ConnComponent {
  pathLength: number;
  path: string[]; // e.g. ["1", "6", "27", "2", ... ]
}

// Thresholds for component sizes (adjust as needed)
const LARGE_COMPONENT_THRESHOLD = 8;
const COMPONENT_SIZE_THRESHOLD = 7;

@Injectable({
  providedIn: 'root',
})
export class MazeSolverService {
  private totalConnComponents: number = 0;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {}

  /**
   * Processes the maze data by:
   * 1. Building a graph from the maze’s pathMap.
   * 2. Finding and analyzing connected components.
   * 3. Submitting large components for remote solving via WebSocket.
   *
   * Returns an array of processed connected components (each including its solved path)
   * which can be used by your three.js–based MazeSolverAnimator.
   */
  async solveMaze(mazeData: MazeData): Promise<ProcessedConnComponent[]> {
    if (!isPlatformBrowser(this.platformId)) {
      console.warn('Maze solving is not available during server-side rendering');
      return [];
    }

    // Build graph from maze cells and edges.
    const graph = new Graph({ type: 'undirected', multi: false });
    mazeData.pathMap.cells.forEach(cell => {
      graph.addNode(cell.linearId.toString());
    });
    mazeData.pathMap.edges.forEach(edge => {
      graph.addEdge(edge.from.toString(), edge.to.toString());
    });

    // Find connected components from the graph.
    const connComponents = this.findConnectedComponents(graph, mazeData.pathMap.cells);
    const analyzedComponents = this.analyzeComponents(connComponents, graph);
    const allComponents = analyzedComponents.allComponents;

    // If there are large components, send them for remote solving.
    const remoteResults = allComponents.length > 0
      ? await this.solveRemotely(
          allComponents.map(comp => ({ adjacencyList: comp.adjacencyList })),
          mazeData.pathMap
        )
      : [];

    // Map nodes to their component index.
    const componentIndexByNode = new Map<string, number>();
    connComponents.forEach((comp, index) => {
      comp.pixels.forEach(pixel => {
        componentIndexByNode.set(pixel.linearId.toString(), index);
      });
    });

    // Match remote solution paths to the corresponding components.
    const processedComponents: ProcessedConnComponent[] = [];
    remoteResults.forEach(path => {
      if (path.length === 0) return;
      const firstNode = path[0];
      const componentIndex = componentIndexByNode.get(firstNode);
      if (componentIndex === undefined) {
        console.warn(`Component index not found for path: ${path}`);
        return;
      }
      const procComp = connComponents[componentIndex] as ProcessedConnComponent;
      procComp.path = path;
      procComp.pathLength = path.length;
      processedComponents.push(procComp);
    });

    return processedComponents;
  }

  /**
   * Uses depth-first search to find connected components in the maze.
   */
  private findConnectedComponents(graph: Graph, cells: PathCell[]): ConnComponent[] {
    const visited = new Set<string>();
    const components: ConnComponent[] = [];

    // Quick lookup map for cells by their linearId.
    const cellMap = new Map(cells.map(cell => [cell.linearId.toString(), cell]));

    const getValidNeighbors = (nodeId: string): string[] => {
      const currentCell = cellMap.get(nodeId);
      if (!currentCell) return [];
      // Only include neighbors that are adjacent in the hexagonal grid.
      return graph.neighbors(nodeId).filter(neighborId => {
        const neighborCell = cellMap.get(neighborId);
        return neighborCell && this.areHexagonsAdjacent(currentCell, neighborCell);
      });
    };

    const exploreComponent = (startNode: string): Set<string> => {
      const compSet = new Set<string>();
      const stack = [startNode];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        compSet.add(current);
        const neighbors = getValidNeighbors(current);
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }
      return compSet;
    };

    for (const node of graph.nodes()) {
      if (!visited.has(node)) {
        const compSet = exploreComponent(node);
        if (compSet.size > 0) {
          // Convert node IDs to ConnComponentCells.
          const compCells = Array.from(compSet)
            .map(id => {
              const cell = cellMap.get(id);
              if (!cell) return undefined;
              return {
                ...cell,
                neighbors: graph.neighbors(cell.linearId.toString())
              } as ConnComponentCell;
            })
            .filter((cell): cell is ConnComponentCell => cell !== undefined);
          components.push({
            pixels: compCells,
            size: compSet.size,
            bounds: this.calculateBounds(
              compCells.map(c => c.position.x),
              compCells.map(c => c.position.y)
            )
          });
        }
      }
    }

    this.totalConnComponents = components.filter(c => c.pixels.length >= COMPONENT_SIZE_THRESHOLD).length;
    console.debug('Component sizes:', components.map(c => c.pixels.length));
    console.debug('Total components (size >= threshold):', this.totalConnComponents);
    return components;
  }

  /**
   * Determines if two hexagonal cells are adjacent.
   */
  private areHexagonsAdjacent(cell1: PathCell, cell2: PathCell): boolean {
    const rowDiff = cell2.position.row - cell1.position.row;
    const colDiff = cell2.position.col - cell1.position.col;
    if (rowDiff === 0) {
      return Math.abs(colDiff) === 1;
    } else if (Math.abs(rowDiff) === 1) {
      if (cell1.position.row % 2 === 0) {
        return colDiff === 0 || colDiff === -1;
      } else {
        return colDiff === 0 || colDiff === 1;
      }
    }
    return false;
  }

  /**
   * Enhances each connected component by creating an adjacency list that includes
   * position information for each node. Only components meeting the size threshold
   * are analyzed.
   */
  private analyzeComponents(components: ConnComponent[], graph: Graph): {
    allComponents: {
      component: ConnComponent,
      size: number,
      adjacencyList: Record<string, { neighbors: string[], position: { row: number, col: number } }>
    }[]
  } {
    const allComponents: {
      component: ConnComponent,
      size: number,
      adjacencyList: Record<string, { neighbors: string[], position: { row: number, col: number } }>
    }[] = [];

    components.forEach(comp => {
      if (comp.size < LARGE_COMPONENT_THRESHOLD) return;
      const subgraph = this.createSubgraph(comp.pixels.map(c => c.linearId.toString()), graph);
      const adjacencyList: Record<string, { neighbors: string[], position: { row: number, col: number } }> = {};
      comp.pixels.forEach(pixel => {
        adjacencyList[pixel.linearId.toString()] = {
          neighbors: subgraph.neighbors(pixel.linearId.toString()),
          position: {
            row: pixel.position.row,
            col: pixel.position.col
          }
        };
      });
      allComponents.push({
        component: comp,
        size: comp.size,
        adjacencyList: adjacencyList
      });
    });

    return { allComponents };
  }

  /**
   * Computes the bounds (min/max) for the provided x and y coordinate arrays.
   */
  private calculateBounds(xCoords: number[], yCoords: number[]): { minX: number, maxX: number, minY: number, maxY: number } {
    const minX = Math.min(...xCoords);
    const maxX = Math.max(...xCoords);
    const minY = Math.min(...yCoords);
    const maxY = Math.max(...yCoords);
    return { minX, maxX, minY, maxY };
  }

  /**
   * Creates a subgraph from the provided list of node IDs.
   */
  private createSubgraph(nodeList: string[], graph: Graph): Graph {
    const subgraph = new Graph();
    const nodeSet = new Set(nodeList);
    graph.forEachNode((node, attributes) => {
      if (nodeSet.has(node)) {
        subgraph.addNode(node, attributes);
      }
    });
    graph.forEachEdge((edge, attr, source, target) => {
      if (nodeSet.has(source) && nodeSet.has(target)) {
        subgraph.addEdgeWithKey(edge, source, target, attr);
      }
    });
    return subgraph;
  }

  /**
   * Sends the enhanced adjacency lists of large components to the remote solver via WebSocket.
   * The backend is expected to return an array of solution paths (each a string array).
   */
  private async solveRemotely(
    components: { adjacencyList: Record<string, { neighbors: string[], position: { row: number, col: number } }> }[],
    pathMap: PathMap
  ): Promise<string[][]> {
    const payload = {
      largeComponents: components.map(comp => {
        // Convert the enhanced adjacency list into a simple one.
        const simpleAdjList: Record<string, string[]> = {};
        Object.entries(comp.adjacencyList).forEach(([nodeId, data]) => {
          simpleAdjList[nodeId] = data.neighbors;
        });
        return simpleAdjList;
      }),
      dimensions: pathMap.dimensions
    };

    const ws = new WebSocket(environment.websocketUrl);

    return new Promise((resolve, reject) => {
      let timeout: any;

      ws.onopen = () => {
        console.debug('WebSocket connected');
        timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket operation timed out'));
        }, 30000);
        ws.send(JSON.stringify(payload));
      };

      ws.onmessage = (event) => {
        try {
          let data;
          try {
            data = JSON.parse(event.data);
          } catch (error) {
            console.error('Failed to parse WebSocket response:', event.data);
            throw new Error('Invalid JSON response');
          }
          if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'internal_error') {
            throw new Error(`Server error: ${data.error}`);
          }
          if (!Array.isArray(data)) {
            console.error('Expected an array of paths from server, got:', data);
            throw new Error('Expected array of paths from server');
          }
          const paths: string[][] = data.filter(path => Array.isArray(path));
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
}
