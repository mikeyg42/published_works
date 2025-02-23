use pyo3::prelude::*;
use rayon::prelude::*; // for par_sort_unstable
use std::collections::{HashMap, HashSet};
use serde::Deserialize;
use pyo3_serde::from_pyany;
use pyo3::wrap_pyfunction;
use pyo3_asyncio::tokio as asyncio;
use heapless::{IndexMap, Vec as HeaplessVec};
use heapless::consts::{U8, U16, U1500, U64};

//use pyo3::exceptions::PyKeyError;
// Basic type aliases
type NodeId = usize;

// A face is just a cycle of NodeIds
type Face = Vec<NodeId>;

/// Our main undirected graph
#[derive(Debug)]
struct Graph {
    // adjacency[node] = list of neighbors
    adjacency: HashMap<NodeId, Vec<NodeId>>,
}

impl Graph {
    fn new() -> Self {
        Graph {
            adjacency: HashMap::new(),
        }
    }

    /// Ensure the node is in the adjacency map
    fn add_node(&mut self, id: NodeId) {
        self.adjacency.entry(id).or_default();
        // if we need coords, we could store them, e.g.: self.coords.insert(id, (0.0, 0.0));
    }

    /// Insert undirected edge
    fn add_edge(&mut self, from: NodeId, to: NodeId) {
        self.adjacency.entry(from).or_default().push(to);
        self.adjacency.entry(to).or_default().push(from);
    }

    fn get_neighbors(&self, node: NodeId) -> &[NodeId] {
        // Safe to unwrap since we ensure add_node
        self.adjacency.get(&node).map_or(&[], |v| v.as_slice())
    }

    /// Number of nodes in the graph
    fn node_count(&self) -> usize {
        self.adjacency.len()
    }
}

// --------------------------------------------
// FaceFinder - finds faces via boundary walk
// --------------------------------------------
struct FaceFinder {
    visited_half_edges: HashSet<(NodeId, NodeId)>,
    faces: Vec<Face>,
}

impl FaceFinder {
    fn new() -> Self {
        FaceFinder {
            visited_half_edges: HashSet::new(),
            faces: Vec::new(),
        }
    }

    /// Build all faces in the graph
    fn build_faces(&mut self, graph: &Graph) -> &[Face] {
        for &u in graph.adjacency.keys() {
            for &v in graph.get_neighbors(u) {
                if !self.visited_half_edges.contains(&(u, v)) {
                    if let Some(face) = self.traverse_face_boundary(graph, u, v) {
                        self.faces.push(face);
                    }
                }
            }
        }
        &self.faces
    }

    fn traverse_face_boundary(
        &mut self,
        graph: &Graph,
        start: NodeId,
        next: NodeId
    ) -> Option<Face> {
        let mut face = Vec::new();
        let (mut current, mut incoming) = (start, next);
        let initial_edge = (start, next);

        self.visited_half_edges.insert((current, incoming));
        face.push(current);

        loop {
            face.push(incoming);

            let next_neighbor = self.get_next_boundary_neighbor(graph, current, incoming);
            match next_neighbor {
                Some(neighbor) => {
                    self.visited_half_edges.insert((incoming, neighbor));
                    current = incoming;
                    incoming = neighbor;

                    // If we returned to the start edge, face is complete
                    if (current, incoming) == initial_edge {
                        break;
                    }
                }
                None => {
                    // We can't continue properly => not a closed face
                    return None;
                }
            }
        }

        Some(face)
    }

    /// The "turn-left" or "move to next neighbor" in a CCW cycle.
    /// If we can't find a next neighbor, return None.
    fn get_next_boundary_neighbor(
        &self,
        graph: &Graph,
        prev: NodeId,
        current: NodeId
    ) -> Option<NodeId> {
        let neighbors = graph.get_neighbors(current);
        if neighbors.is_empty() {
            return None;
        }

        // find the index of `prev` in `current`'s adjacency
        let prev_idx = neighbors.iter().position(|&x| x == prev)?;
        // we assume the next index in that list is the boundary direction
        if neighbors.len() == 1 {
            // Only one neighbor => can't form a cycle
            return None;
        }

        let next_idx = (prev_idx + 1) % neighbors.len();
        Some(neighbors[next_idx])
    }
}

// --------------------------------------------
// PathFinder - B&B for longest path
// --------------------------------------------
struct PathFinder {
    global_best_length: usize,
    global_best_path: Vec<NodeId>,
}

impl PathFinder {
    fn new() -> Self {
        PathFinder {
            global_best_length: 0,
            global_best_path: Vec::new(),
        }
    }

    fn find_longest_path(&mut self, graph: &Graph, faces: &[Face]) -> Vec<NodeId> {
        // This is CPU-intensive work that doesn't need the GIL
        // We can release it while doing the search
        Python::with_gil(|py| {
            py.allow_threads(|| {
                for &start_node in graph.adjacency.keys() {
                    let mut visited = HashSet::new();
                    visited.insert(start_node);
                    let current_path = vec![start_node];
                    self.bnb_search(graph, faces, &current_path, &mut visited);
                }
                self.global_best_path.clone()
            })
        })
    }

    fn bnb_search(
        &mut self,
        graph: &Graph,
        faces: &[Face],
        current_path: &[NodeId],
        visited: &mut HashSet<NodeId>
    ) {
        let current_length = current_path.len();
        let last_node = *current_path.last().unwrap();

        // 1) Face-based bounding
        let face_bound = self.enhanced_face_heuristic(graph, current_path, visited, faces);
        if current_length + face_bound <= self.global_best_length {
            return;
        }

        // 2) (Optional) other heuristics; we removed is_bridge_node for simplicity:
        /*
        if !self.maintains_connectivity(graph, visited) {
            return;
        }
        if self.leads_to_dead_end(graph, last_node, visited) {
            return;
        }
        */

        // 3) Update global best
        if current_length > self.global_best_length {
            self.global_best_length = current_length;
            self.global_best_path = current_path.to_vec();
        }

        // 4) Branch: try all unvisited neighbors
        for &neighbor in graph.get_neighbors(last_node) {
            if !visited.contains(&neighbor) {
                visited.insert(neighbor);
                let mut new_path = current_path.to_vec();
                new_path.push(neighbor);

                self.bnb_search(graph, faces, &new_path, visited);

                // backtrack
                visited.remove(&neighbor);
            }
        }
    }

    /// A simplified face-based bounding heuristic
    fn enhanced_face_heuristic(
        &self,
        graph: &Graph,
        current_path: &[NodeId],
        visited: &HashSet<NodeId>,
        faces: &[Face]
    ) -> usize {
        let last_node = *current_path.last().unwrap();

        // 1) find any face that 'last_node' is on
        let mut reachable_faces = Vec::new();
        for (face_idx, face) in faces.iter().enumerate() {
            if face.contains(&last_node) {
                reachable_faces.push(face_idx);
            }
        }

        // 2) sum up how many unvisited in those faces
        let mut total_reachable = 0;
        for &idx in &reachable_faces {
            let face = &faces[idx];
            let unvisited_in_face = face
                .iter()
                .filter(|id| !visited.contains(id))
                .count();
            total_reachable += unvisited_in_face;
        }

        // 3) also can't exceed "graph.node_count() - visited.len()"
        let leftover_nodes = graph.node_count() - visited.len();
        // trivial bounding with MAX_DEGREE or other logic
        

        leftover_nodes.min(total_reachable)
    }
}

// ----------------------------------------------------------
// PyO3 bridging: unify adjacency from Python, run BnB, return
// ----------------------------------------------------------

#[pyfunction]
pub fn find_longest_paths(components: Vec<Vec<(String, String)>>) -> Vec<Vec<String>> {
    // Use rayon's into_par_iter for owned data
    components.into_par_iter()
        .map(find_longest_path)  // No need for clone since we have ownership
        .collect()
}

#[pyfunction]
pub fn find_longest_path(edges: Vec<(String, String)>) -> Vec<String> {
    // Input validation should happen while holding the GIL
    if edges.is_empty() {
        return Vec::new();
    }

    // Setup data structures
    let mut name_to_id = HashMap::new();
    let mut id_to_name = Vec::new();
    let mut graph = Graph::new();

    // Process edge list - this is pure Rust work, can release GIL
    Python::with_gil(|py| {
        py.allow_threads(|| {
            for (from, to) in edges {
                let from_id = *name_to_id.entry(from.clone()).or_insert_with(|| {
                    let new_id = id_to_name.len();
                    id_to_name.push(from);
                    new_id
                });
                let to_id = *name_to_id.entry(to.clone()).or_insert_with(|| {
                    let new_id = id_to_name.len();
                    id_to_name.push(to);
                    new_id
                });
                graph.add_node(from_id);
                graph.add_node(to_id);
                graph.add_edge(from_id, to_id);
            }
        });
    });

    // Face finding and path finding can run without the GIL
    let faces = Python::with_gil(|py| {
        py.allow_threads(|| {
            let mut face_finder = FaceFinder::new();
            face_finder.build_faces(&graph).to_vec()
        })
    });

    let best_path_ids = Python::with_gil(|py| {
        py.allow_threads(|| {
            let mut path_finder = PathFinder::new();
            path_finder.find_longest_path(&graph, &faces)
        })
    });

    // Error handling should happen with GIL held
    if best_path_ids.is_empty() {
        return Vec::new();
    }

    // Final conversion back to strings can happen without GIL
    

    Python::with_gil(|py| {
        py.allow_threads(|| {
            best_path_ids
                .into_iter()
                .map(|id| id_to_name[id].clone())
                .collect()
        })
    })
}
// ------------------------------------------------------------
// ------------------------------------------------------------
#[derive(Deserialize)]
struct MazeInput {
    largeMazeData: HeaplessVec<ComponentData, U8>,
}

#[derive(Deserialize)]
struct ComponentData {
    // Using heapless types to fix capacity:
    // - Keys: node IDs as strings (max 64 characters)
    // - Values: lists of neighbor IDs (each max 64 characters, up to 16 neighbors)
    adjacency_list: IndexMap<heapless::String<U64>, HeaplessVec<heapless::String<U64>, U16>>,
}


fn build_edge_list(comp: &ComponentData) -> HeaplessVec<(heapless::String<U64>, heapless::String<U64>), U1500> {
    let mut edges: HeaplessVec<(heapless::String<U64>, heapless::String<U64>), U1500> = HeaplessVec::new();
    for (node, neighbors) in comp.adjacency_list.iter() {
        for neighbor in neighbors.iter() {
            // Here we compare lexicographically; you could also convert to numbers if desired.
            if neighbor > node {
                let _ = edges.push((node.clone(), neighbor.clone())); // ignore error if full
            }
        }
    }
    // Optionally, sort the edges in parallel using Rayon.
    edges.par_sort_unstable();
    edges
}
#[pyfunction]
fn async_process_maze(websocket: PyObject) -> PyResult<&PyAny> {
    // Create a Python awaitable from our async block.
    asyncio::future_into_py(async move {
        // Acquire the GIL briefly to get the websocket’s attributes.
        let gil = Python::acquire_gil();
        let py = gil.python();
        let ws = websocket.as_ref(py);
        
        // This will hold the edge lists for all components.
        let mut results: Vec<HeaplessVec<(heapless::String<U64>, heapless::String<U64>), U1500>> = Vec::new();
        
        // We assume that the websocket’s "recv" method, when awaited, returns a JSON string.
        loop {
            // Call ws.recv() to get the next chunk.
            let recv_awaitable = ws.getattr("recv")?.call0()?;
            // Convert the Python awaitable into a Rust Future and await it.
            let chunk_obj = asyncio::into_future(recv_awaitable).await?;
            // Extract the received chunk as a String.
            let chunk: String = chunk_obj.extract()?;
            // If we receive an empty string (or you could check for a sentinel), break.
            if chunk.is_empty() {
                break;
            }
            // Deserialize the JSON chunk into our MazeInput.
            let maze_input: MazeInput = serde_json::from_str(&chunk)
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("JSON error: {}", e)))?;
            // For each component in the maze data, build an edge list.
            for comp in maze_input.largeMazeData.iter() {
                let edge_list = build_edge_list(comp);
                results.push(edge_list);
            }
    
        }
        
        // Convert our results (Vec of heapless edge lists) into a standard Rust Vec that can be sent to Python.
        // We’ll convert each heapless::String into a standard String.
        let output: Vec<Vec<(String, String)>> = results.into_iter().map(|edge_list| {
            edge_list.into_iter().map(|(a, b)| (a.into(), b.into())).collect()
        }).collect();
        
        // Return the output as a Python object.
        Python::with_gil(|py| Ok(output.into_py(py)))
    })
}