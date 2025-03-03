/// <reference lib="webworker" />
import Graph from 'graphology';

/** 
 * --------------------------------------------------
 * Types and Interfaces
 * --------------------------------------------------
 */

// Coordinates used for storing x,y in the final path
interface HexCoord {
  x: number;
  y: number;
}

// A single hexagonal cell in our maze
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

// Represents the bounding box for a path or component
interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Basic component info (single path here, but we keep the structure)
interface Component {
  pixels: HexCoord[];
  size: number;
  bounds: Bounds;
}

// Extended interface to capture pathLength and associated cells
interface ProcessedComponent extends Component {
  pathLength: number;
  path: string[]; // ["1" ,"6", "27", "2", ... ]
  componentCells: HexCell[];
}

// The shape of the data we receive in a worker message
interface WorkerData {
  edges: { from: number; to: number }[];
  cells: HexCell[];
}

// The shape of messages we can post back from the worker
interface WorkerMessage {
  type: 'progress' | 'debug' | 'error' | 'result';
  data?: any;
  message?: string;
  error?: string;
}

/** 
 * --------------------------------------------------
 * Constants
 * --------------------------------------------------
 */
const PATH_FINDING_TIMEOUT = 7000; // 7 seconds

/** 
 * --------------------------------------------------
 * Web Worker Event Listener
 * --------------------------------------------------
 */

// The main entry point for messages sent to this worker
addEventListener('message', async ({ data }: { data: WorkerData }) => {
  try {
    const { edges, cells } = data;

    // Build the graphology graph
    const graph = new Graph({ type: 'undirected' });
    cells.forEach(cell => {
      graph.addNode(cell.id.toString(), {
        x: cell.position.x,
        y: cell.position.y,
        row: cell.position.row,
        col: cell.position.col
      });
    });
    edges.forEach(edge => {
      graph.addEdge(edge.from.toString(), edge.to.toString());
    });

    // Find the longest path (via DFS backtracking) in this (single) component
    const pathNodeIds = await findLongestPath(graph, graph.nodes(), cells);

    // Convert it into a ProcessedComponent so the UI can work with it
    const processedComponent = createProcessedComponent(pathNodeIds, cells);

    // Send our final result back
    const msg: WorkerMessage = {
      type: 'result',
      data: [processedComponent]  // array for compatibility with older multi-component code
    };
    postMessage(msg);

  } catch (err: any) {
    const errorMsg: WorkerMessage = {
      type: 'error',
      error: err instanceof Error ? err.message : 'Unknown error'
    };
    postMessage(errorMsg);
  }
});

/** 
 * --------------------------------------------------
 * findLongestPath (DFS Backtracking)
 * --------------------------------------------------
 * Performs a full search for the longest *simple path*.
 * For each node, we recursively try all paths, 
 * never revisiting a node in the same path.
 */
async function findLongestPath(
  graph: Graph,
  nodes: string[],
  cells: HexCell[]
): Promise<string[]> {
  // Build adjacency using actual hex adjacency rules
  const adjacencyMap = buildHexAdjacencyMap(graph, nodes, cells);

  // Calculate the theoretical maximum path length
  const degree1Nodes = nodes.filter(node => 
    (adjacencyMap.get(node)?.size || 0) === 1
  ).length;
  const pathCeiling = nodes.length - degree1Nodes + 2;

  let bestPathGlobal: string[] = [];
  const startTime = Date.now();

  // DFS function capturing the best path so far
  function dfsLongestPath(
    current: string,
    visited: Set<string>,
    path: string[]
  ) {
    // If we exceed our time limit, stop early
    if (Date.now() - startTime > PATH_FINDING_TIMEOUT) return;

    // Mark current node visited
    visited.add(current);
    path.push(current);

    // Update best path if needed
    if (path.length > bestPathGlobal.length) {
      bestPathGlobal = [...path];
      
      // If we've hit the theoretical maximum, we can stop
      if (bestPathGlobal.length >= pathCeiling) {
        return;
      }
    }

    // Explore neighbors (avoiding already visited)
    for (const neighbor of adjacencyMap.get(current) || []) {
      if (!visited.has(neighbor)) {
        dfsLongestPath(neighbor, visited, path);
      }
    }

    // backtrack
    visited.delete(current);
    path.pop();
  }

  // Try using each node as a potential start
  for (const node of nodes) {
    if (Date.now() - startTime > PATH_FINDING_TIMEOUT) {
      console.debug('Path finding timed out; returning partial best path.');
      return bestPathGlobal;
    }

    // If we've already found the maximum possible path, we can stop
    if (bestPathGlobal.length >= pathCeiling) {
      break;
    }

    dfsLongestPath(node, new Set<string>(), []);
  }

  return bestPathGlobal;
}

/**
 * Build a map of { nodeId -> set of adjacent nodeIds }, 
 * filtering by valid hex adjacency
 */
function buildHexAdjacencyMap(
  graph: Graph,
  nodes: string[],
  cells: HexCell[]
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  
  // convenience for retrieving a HexCell
  function getCellFromId(id: number): HexCell {
    const cell = cells.find(c => c.id === id);
    if (!cell) throw new Error(`Cell not found for id ${id}`);
    return cell;
  }

  for (const node of nodes) {
    adjacency.set(node, new Set());
  }

  // For each node, see who is actually adjacent in hex‐space
  for (const node of nodes) {
    const neighbors = graph.neighbors(node);
    const nodeCell = getCellFromId(parseInt(node));
    for (const nbr of neighbors) {
      const nbrCell = getCellFromId(parseInt(nbr));
      if (areHexagonsAdjacent(nodeCell, nbrCell)) {
        adjacency.get(node)!.add(nbr);
      }
    }
  }

  return adjacency;
}

/** 
 * --------------------------------------------------
 * createProcessedComponent
 * --------------------------------------------------
 * Convert the found path (list of node IDs) into a 
 * consistent shape with geometry/bounding info.
 */
function createProcessedComponent(pathIds: string[], cells: HexCell[]): ProcessedComponent {
  // Convert IDs -> HexCell
  const pathCells = pathIds.map(id => {
    const cell = cells.find(c => c.id === parseInt(id));
    if (!cell) throw new Error(`Cell not found for id ${id}`);
    return cell;
  });

  // The hex centers as x,y pairs
  const pixels: HexCoord[] = pathCells.map(cell => ({
    x: cell.position.x,
    y: cell.position.y
  }));

  const bounds = calculateBounds(pathCells);
  const size = pathCells.length;

  return {
    pixels,
    size,
    bounds,
    path:pathIds,
    pathLength: size,
    componentCells: pathCells
  };
}
/*
// Update getCellFromId to accept cells parameter
function getCellFromId(id: number, cells: HexCell[]): HexCell {
  const cell = cells.find(c => c.id === id);
  if (!cell) throw new Error(`Cell not found for id ${id}`);
  return cell;
}
*/

/**
 * --------------------------------------------------
 * areHexagonsAdjacent
 * --------------------------------------------------
 * Check if two hexagons are adjacent in hex space
 */
function areHexagonsAdjacent(cell1: HexCell, cell2: HexCell): boolean {
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

/**
 * --------------------------------------------------
 * calculateBounds
 * --------------------------------------------------
 * Calculate the xy-bounding box for a list of hex cells
 */
function calculateBounds(cells: HexCell[]): Component['bounds'] {
  const xCoords = cells.map(c => c.position.x);
  const yCoords = cells.map(c => c.position.y);
  const hexSize = ((xCoords[0] - xCoords[1])/2)/0.866;
  return { 
    minX: Math.min(...xCoords)-hexSize*0.866,
    maxX: Math.max(...xCoords)+hexSize*0.866,
    minY: Math.min(...yCoords)-hexSize,
    maxY: Math.max(...yCoords)+hexSize
  };
}
