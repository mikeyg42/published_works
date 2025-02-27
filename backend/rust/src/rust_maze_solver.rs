use pyo3::prelude::*;
use pyo3::exceptions::PyValueError;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use serde::Deserialize;
use heapless::{IndexMap, Vec as HeaplessVec};
use nohash_hasher;
use nohash_hasher::NoHashHasher as NoHashHasherType;
use hash32::BuildHasherDefault as HashConstructor;
use std::time::Instant;
use serde_json;

// Type aliases with heapless for fixed memory usage
type NodeId = u32; // More memory efficient than usize for most cases
type Face = HeaplessVec<NodeId, 128>;
type NeighborList = HeaplessVec<NodeId, 8>; // Max 8 neighbors (in practice will be 4 or less)

/// We assume a maximum of 1024 nodes. Each bit in the bitset corresponds to a node ID.
/// This provides a highly efficient representation for tracking visited nodes.
const MAX_NODE_COUNT: usize = 1024;
const BITSET_ARRAY_SIZE: usize = MAX_NODE_COUNT / 64;

/// A memory-efficient bitset for tracking node visitation
/// Each bit represents one node (1=visited, 0=unvisited)
#[derive(Clone)]
pub struct NodeBitset {
    /// Each `u64` stores 64 bits, so 16 of them can track up to 1024 node IDs
    /// using only 128 bytes of memory (vs. several KB for a HashSet)
    data: [u64; BITSET_ARRAY_SIZE],
}

impl NodeBitset {
    /// Create an empty bitset (all nodes unvisited)
    pub fn new() -> Self {
        NodeBitset { data: [0; BITSET_ARRAY_SIZE] }
    }

    /// Mark a node as visited
    pub fn set(&mut self, node_id: NodeId) {
        let idx = node_id as usize;
        if idx >= MAX_NODE_COUNT {
            panic!("Node ID exceeds maximum supported size of {}", MAX_NODE_COUNT);
        }
        let arr_idx = idx / 64;
        let bit_idx = idx % 64;
        self.data[arr_idx] |= 1u64 << bit_idx;
    }

    /// Mark a node as unvisited
    pub fn clear(&mut self, node_id: NodeId) {
        let idx = node_id as usize;
        if idx >= MAX_NODE_COUNT {
            panic!("Node ID exceeds maximum supported size of {}", MAX_NODE_COUNT);
        }
        let arr_idx = idx / 64;
        let bit_idx = idx % 64;
        self.data[arr_idx] &= !(1u64 << bit_idx);
    }

    /// Check if a node is visited
    pub fn contains(&self, node_id: NodeId) -> bool {
        let idx = node_id as usize;
        if idx >= MAX_NODE_COUNT {
            panic!("Node ID exceeds maximum supported size of {}", MAX_NODE_COUNT);
        }
        let arr_idx = idx / 64;
        let bit_idx = idx % 64;
        (self.data[arr_idx] & (1u64 << bit_idx)) != 0
    }
    
    /// Count the number of visited nodes
    pub fn count(&self) -> usize {
        // Use standard population count for all architectures
        self.data.iter().map(|&x| x.count_ones() as usize).sum()
    }
}

impl std::fmt::Debug for NodeBitset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NodeBitset {{ count: {} }}", self.count())
    }
}

/// Memory-efficient graph representation
#[derive(Debug)]
struct Graph {
    // Use std::hash::BuildHasherDefault with NoHashHasher
    adjacency: IndexMap<NodeId, NeighborList, HashConstructor<NoHashHasherType<NodeId>>, 1024>,
}
impl Graph {
    fn new() -> Self {
        Graph {
            adjacency: IndexMap::new(),
        }
    }

    fn add_node(&mut self, id: NodeId) -> Result<(), ()> {
        // Handle the different result type by mapping any error to ()
        match self.adjacency.insert(id, HeaplessVec::<NodeId, 8>::new()) {
            Ok(_) => Ok(()),
            Err(_) => Err(()),
        }
    }

    fn add_edge(&mut self, from: NodeId, to: NodeId) -> Result<(), ()> {
        // First ensure both nodes exist
        if !self.adjacency.contains_key(&from) {
            self.add_node(from)?;
        }
        if !self.adjacency.contains_key(&to) {
            self.add_node(to)?;
        }
        
        // Add edges in both directions
        if let Some(neighbors) = self.adjacency.get_mut(&from) {
            if !neighbors.iter().any(|&n| n == to) {
                // Handle the different result type
                if neighbors.push(to).is_err() {
                    return Err(());
                }
            }
        }
        if let Some(neighbors) = self.adjacency.get_mut(&to) {
            if !neighbors.iter().any(|&n| n == from) {
                // Handle the different result type
                if neighbors.push(from).is_err() {
                    return Err(());
                }
            }
        }
        Ok(())
    }

    fn get_neighbors(&self, node: NodeId) -> &[NodeId] {
        self.adjacency.get(&node).map_or(&[], |v| v.as_slice())
    }

    fn node_count(&self) -> usize {
        self.adjacency.len()
    }
    
    // Get all nodes for parallel iteration
    fn nodes(&self) -> Vec<NodeId> {
        // Using Vec instead of HeaplessVec for large graph support
        self.adjacency.keys().copied().collect()
    }
}
// FaceFinder with optimizations for large faces
struct FaceFinder {
    visited_half_edges: HashSet<(NodeId, NodeId)>,
    faces: Vec<Face>, // Using Vec for the container to support many faces
}

impl FaceFinder {
    fn new() -> Self {
        FaceFinder {
            visited_half_edges: HashSet::new(),
            faces: Vec::new(),
        }
    }

    fn build_faces(&mut self, graph: &Graph) -> &[Face] {
        // For large components, collect all potential starting edges first
        let mut starting_edges = Vec::new();
        for (&u, _) in graph.adjacency.iter() {
            for &v in graph.get_neighbors(u) {
                if !self.visited_half_edges.contains(&(u, v)) {
                    starting_edges.push((u, v));
                }
            }
        }
        
        // Process edges in parallel chunks
        let chunk_size = (starting_edges.len() / rayon::current_num_threads()).max(1);
        let face_chunks: Vec<_> = starting_edges
            .par_chunks(chunk_size)
            .map(|edges| {
                let mut local_faces = Vec::new();
                let mut local_visited = HashSet::new();
                
                for &(u, v) in edges {
                    if !self.visited_half_edges.contains(&(u, v)) && !local_visited.contains(&(u, v)) {
                        if let Some(face) = self.traverse_face_boundary(graph, u, v, &mut local_visited) {
                            local_faces.push(face);
                        }
                    }
                }
                (local_faces, local_visited)
            })
            .collect();
        
        // Merge results back
        for (faces, visited) in face_chunks {
            self.visited_half_edges.extend(visited);
            self.faces.extend(faces);
        }
        
        &self.faces
    }

    fn traverse_face_boundary(
        &self,
        graph: &Graph,
        start: NodeId,
        next: NodeId,
        visited: &mut HashSet<(NodeId, NodeId)>
    ) -> Option<Face> {
        let mut face = HeaplessVec::new();
        let (mut current, mut incoming) = (start, next);
        let initial_edge = (start, next);

        visited.insert((current, incoming));
        if face.push(current).is_err() {
            return None; // Face too large for our fixed capacity
        }

        loop {
            if face.push(incoming).is_err() {
                return None; // Face too large
            }

            let next_neighbor = self.get_next_boundary_neighbor(graph, current, incoming);
            match next_neighbor {
                Some(neighbor) => {
                    visited.insert((incoming, neighbor));
                    current = incoming;
                    incoming = neighbor;

                    if (current, incoming) == initial_edge {
                        break;
                    }
                }
                None => return None, // Not a closed face
            }
        }

        Some(face)
    }

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

        let prev_idx = neighbors.iter().position(|&x| x == prev)?;
        if neighbors.len() == 1 {
            return None; // Only one neighbor, can't form a cycle
        }

        let next_idx = (prev_idx + 1) % neighbors.len();
        Some(neighbors[next_idx])
    }
}

// PathFinder optimized for large components
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

    // For very large components, we need a more aggressive pruning strategy
    fn find_longest_path(&mut self, graph: &Graph, faces: &[Face]) -> Vec<NodeId> {
        // Start nodes as candidates for longest path starting points
        let start_nodes = graph.nodes();
        
        // Special optimization for large components: 
        // Only start from high-degree nodes or nodes at "corners" of the maze
        let pruned_start_nodes: Vec<_> = if start_nodes.len() > 500 {
            // For large mazes, prioritize low-degree nodes (usually at maze extremities)
            start_nodes.into_iter()
                .filter(|&node| {
                    let degree = graph.get_neighbors(node).len();
                    // Prefer nodes with degree 1 or 2 - likely to be endpoints
                    degree <= 2
                })
                .collect()
        } else {
            start_nodes
        };
        
        // Process start nodes in parallel
        let chunk_size = (pruned_start_nodes.len() / rayon::current_num_threads()).max(1);
        let results: Vec<(usize, Vec<NodeId>)> = pruned_start_nodes
            .par_chunks(chunk_size)
            .map(|nodes| {
                let mut local_best_length = 0;
                let mut local_best_path = Vec::new();
                let mut work_path = Vec::with_capacity(MAX_NODE_COUNT);
                
                for &start_node in nodes {
                    // Use NodeBitset instead of HashSet for tracking visited nodes
                    // This is much more memory-efficient and faster for large graphs
                    let mut visited = NodeBitset::new();
                    visited.set(start_node);
                    
                    // Initialize work path with start node
                    work_path.clear();
                    work_path.push(start_node);
                    
                    // Local BnB search with enhanced pruning
                    bnb_search_local(
                        graph, 
                        faces, 
                        &mut work_path, 
                        &mut visited,
                        &mut local_best_length,
                        &mut local_best_path
                    );
                }
                
                (local_best_length, local_best_path)
            })
            .collect();
        
        // Find the best result across all threads
        for (length, path) in results {
            if length > self.global_best_length {
                self.global_best_length = length;
                self.global_best_path = path;
            }
        }
        
        self.global_best_path.clone()
    }
}

 // Enhanced branch-and-bound search with advanced pruning
// Now using NodeBitset for tracking visited nodes
// Made this a standalone function to avoid self reference issues
fn bnb_search_local(
    graph: &Graph,
    faces: &[Face],
    work_path: &mut Vec<NodeId>,
    visited: &mut NodeBitset,
    local_best_length: &mut usize,
    local_best_path: &mut Vec<NodeId>
) {
    let current_length = work_path.len();
    let last_node = *work_path.last().unwrap();

    // 1. Face-based bounding (primary pruning mechanism)
    let face_bound = enhanced_face_heuristic(graph, work_path, visited, faces);
    if current_length + face_bound <= *local_best_length {
        return;
    }

    // 2. Additional pruning for large graphs: Don't go into dead-ends 
    // if we're not close to a potentially good solution
    if graph.node_count() > 500 && current_length < *local_best_length / 2 {
        let unvisited_neighbors = graph.get_neighbors(last_node)
            .iter()
            .filter(|&&n| !visited.contains(n))
            .count();
            
        if unvisited_neighbors == 1 {
            // We're entering a potential dead-end - only continue if promising
            let potential = current_length + face_bound;
            if potential < *local_best_length + (graph.node_count() / 10) {
                return; // Prune this branch - not likely to lead to major improvement
            }
        }
    }

    // 3. Update local best if current path is longer
    if current_length > *local_best_length {
        *local_best_length = current_length;
        *local_best_path = work_path.clone();
    }

    // 4. Branch: sort neighbors by potential 
    // This can significantly improve pruning effectiveness
    let neighbors: Vec<_> = graph.get_neighbors(last_node)
        .iter()
        .copied()
        .filter(|&n| !visited.contains(n))
        .collect();
        
    // For large graphs, sort neighbors by their potential
    // This is a greedy approach that often works well
    let mut ordered_neighbors = neighbors;
    if graph.node_count() > 300 {
        // Sort neighbors by degree (preferring low-degree nodes first)
        // This tends to push the path toward the extremities of the maze
        ordered_neighbors.sort_by_key(|&n| graph.get_neighbors(n).len());
    }
    
    // Try each neighbor
    for &neighbor in &ordered_neighbors {
        visited.set(neighbor);  // Mark as visited using bitset
        work_path.push(neighbor);

        bnb_search_local(
            graph, 
            faces, 
            work_path, 
            visited,
            local_best_length,
            local_best_path
        );

        // backtrack
        work_path.pop();
        visited.clear(neighbor);  // Unmark as visited using bitset
    }
}


// Advanced heuristic specially optimized for large mazes
// Now using NodeBitset for tracking visited nodes
fn enhanced_face_heuristic(
    graph: &Graph,
    current_path: &[NodeId],
    visited: &NodeBitset,
    faces: &[Face]
) -> usize {
    let last_node = *current_path.last().unwrap();

    // For very large graphs, use a faster approximation
    if graph.node_count() > 500 && faces.len() > 100 {
        // Simple and fast approximation: just estimate based on unvisited nodes
        // This loses some precision but is much faster for large graphs
        let remaining = graph.node_count() - visited.count();
        return (remaining / 2).min(remaining);
    }

    // For smaller graphs, use the more precise face-based heuristic
    // Find faces containing the last node
    let reachable_faces: Vec<usize> = faces
        .par_iter()
        .enumerate()
        .filter_map(|(idx, face)| {
            if face.contains(&last_node) {
                Some(idx)
            } else {
                None
            }
        })
        .collect();

    // Calculate total reachable nodes
    let total_reachable = reachable_faces
        .iter()
        .map(|&idx| {
            faces[idx]
                .iter()
                .filter(|&&id| !visited.contains(id))
                .count()
        })
        .sum();

    let leftover_nodes = graph.node_count() - visited.count();
    leftover_nodes.min(total_reachable)
}

// Data structures for direct deserialization
#[derive(Deserialize)]
struct MazeData {
    #[serde(rename = "largeComponents")]
    #[serde(default)]
    large_components: Vec<ComponentData>,
}

#[derive(Deserialize)]
struct ComponentData {
    adjacency_list: serde_json::Value,
}

// Main entry point - solves the maze from Python input
#[pyfunction]
pub fn process_and_solve_maze(py: Python, data: PyObject) -> PyResult<Vec<Vec<String>>> {
    // Parse the input data
    let start = Instant::now();
    
    // Convert PyObject to string
    let data_str = data.extract::<String>(py)?;
    
    // Release GIL for heavy processing
    py.allow_threads(move || {
        // Use serde_json's Result type for better error handling
        let maze_data: MazeData = serde_json::from_str(&data_str)
            .map_err(|e| PyErr::new::<PyValueError, _>(format!("JSON parsing error: {}", e)))?;
        
        // Process all components in parallel
        let solutions = maze_data.large_components
            .into_par_iter()
            .map(|component| {
                // Start component timer
                let component_start = Instant::now();
                
                // Convert to edge list
                let edges = convert_adjacency_to_edges(&component.adjacency_list);
                println!("Component with {} nodes converted to {} edges in {:?}", 
                    component.adjacency_list.as_object().unwrap().len(), edges.len(), component_start.elapsed());
                
                // Find longest path
                let path_start = Instant::now();
                let path = find_longest_path_for_component(edges)?;
                println!("Found longest path of length {} in {:?}", 
                    path.len(), path_start.elapsed());
                
                Ok(path)
            })
            .collect::<PyResult<Vec<_>>>()?;
            
        println!("Total maze solving completed in {:?}", start.elapsed());
        Ok(solutions)
    })
}


// Convert adjacency list to edge list efficiently
fn convert_adjacency_to_edges(adjacency_list: &serde_json::Value) -> Vec<(String, String)> {
    // Convert the JSON value to an object (map)
    let adjacency_map = adjacency_list.as_object()
        .expect("adjacency_list must be an object");
    let node_count = adjacency_map.len();
    let estimated_edges = node_count * 2;
    let mut edges = Vec::with_capacity(estimated_edges);
    
    // Process based on the size of the component
    if node_count > 500 {
        // For very large components: sequential processing to avoid parallelism overhead
        for (node, neighbors) in adjacency_map {
            if let Some(neighbor_array) = neighbors.as_array() {
                for neighbor in neighbor_array {
                    if let Some(n2) = neighbor.as_str() {
                        // Compare as &str using node.as_str()
                        if node.as_str() < n2 {
                            edges.push((node.clone(), n2.to_string()));
                        }
                    }
                }
            }
        }
    } else {
        // For smaller components: use parallelism
        // Convert the map's iterator into a Vec to enable parallel iteration.
        let parallel_edges: Vec<(String, String)> = adjacency_map
            .iter()
            .collect::<Vec<_>>()
            .par_iter()
            .flat_map(|(node, neighbors)| {
                if let Some(neighbor_array) = neighbors.as_array() {
                    neighbor_array.iter()
                        .filter_map(|neighbor| {
                            if let Some(n2) = neighbor.as_str() {
                                if node.as_str() < n2 {
                                    Some((node.to_string(), n2.to_string()))
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            })
            .collect();
        
        edges.extend(parallel_edges);
    }
    
    edges
}

// Find longest path for a component
fn find_longest_path_for_component(edges: Vec<(String, String)>) -> PyResult<Vec<String>> {
    if edges.is_empty() {
        return Ok(Vec::new());
    }
    
    // Build the graph
    let (graph, id_to_name) = build_graph_from_edges(edges);
    println!("Graph built with {} nodes", graph.node_count());
    
    // Find faces
    let face_start = Instant::now();
    let faces = {
        let mut face_finder = FaceFinder::new();
        let faces = face_finder.build_faces(&graph);
        println!("Found {} faces in {:?}", faces.len(), face_start.elapsed());
        faces.to_vec()
    };
    
    // Find longest path
    let path_start = Instant::now();
    let best_path_ids = {
        let mut path_finder = PathFinder::new();
        path_finder.find_longest_path(&graph, &faces)
    };
    println!("BnB search completed in {:?}", path_start.elapsed());
    
    // Convert back to string names
    let best_path = best_path_ids.into_iter()
        .map(|id| id_to_name[id as usize].clone())
        .collect();
    
    Ok(best_path)
}

// Build graph from edges
fn build_graph_from_edges(edges: Vec<(String, String)>) -> (Graph, Vec<String>) {
    let mut name_to_id = HashMap::new();
    let mut id_to_name = Vec::new();
    let mut graph = Graph::new();
    
    // For very large components, avoid threading overhead
    if edges.len() > 1000 {
        // Sequential processing for large graphs
        for (from, to) in &edges {
            // Convert strings to IDs
            let from_id = *name_to_id.entry(from.clone()).or_insert_with(|| {
                let new_id = id_to_name.len() as u32;
                id_to_name.push(from.clone());
                new_id
            });
            
            let to_id = *name_to_id.entry(to.clone()).or_insert_with(|| {
                let new_id = id_to_name.len() as u32;
                id_to_name.push(to.clone());
                new_id
            });
            
            // Add to graph
            let _ = graph.add_node(from_id);
            let _ = graph.add_node(to_id);
            let _ = graph.add_edge(from_id, to_id);
        }
    } else {
        // Use parallel processing for smaller graphs
        // First pass: collect all node names
        let node_names: HashSet<String> = edges.iter()
            .flat_map(|(from, to)| vec![from.clone(), to.clone()])
            .collect();
            
        // Convert to IDs sequentially (this is fast enough)
        for name in node_names {
            let id = id_to_name.len() as u32;
            name_to_id.insert(name.clone(), id);
            id_to_name.push(name);
        }
        
        // Use Arc for thread-safe sharing
        let graph_arc = Arc::new(Mutex::new(graph));
        
        // Now process edges in parallel with already-assigned IDs
        edges.par_chunks(128)
            .for_each(|chunk| {
                // Collect local edges to minimize lock contention
                let mut local_edges = Vec::with_capacity(chunk.len());
                
                for (from, to) in chunk {
                    let from_id = name_to_id[from];
                    let to_id = name_to_id[to];
                    local_edges.push((from_id, to_id));
                }
                
                // Add all edges at once with a single lock
                if !local_edges.is_empty() {
                    let mut graph_ref = graph_arc.lock().unwrap();
                    for (from_id, to_id) in local_edges {
                        let _ = graph_ref.add_node(from_id);
                        let _ = graph_ref.add_node(to_id);
                        let _ = graph_ref.add_edge(from_id, to_id);
                    }
                }
            });
            
        // Unwrap the Arc<Mutex<Graph>> to get the Graph
        graph = Arc::try_unwrap(graph_arc)
            .expect("Failed to unwrap Arc")
            .into_inner()
            .expect("Failed to unwrap Mutex");
    }
    
    (graph, id_to_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_bitset_basic() {
        let mut visited = NodeBitset::new();
        assert_eq!(visited.contains(10), false);
        visited.set(10);
        assert_eq!(visited.contains(10), true);
        visited.clear(10);
        assert_eq!(visited.contains(10), false);
    }
    
    #[test]
    fn test_node_bitset_multiple() {
        let mut visited = NodeBitset::new();
        for i in 0..100 {
            visited.set(i);
        }
        assert_eq!(visited.count(), 100);
        
        for i in 0..100 {
            assert_eq!(visited.contains(i), true);
        }
        
        for i in 100..200 {
            assert_eq!(visited.contains(i), false);
        }
    }
}