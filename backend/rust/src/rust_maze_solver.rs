use pyo3::prelude::*;
use pyo3::exceptions::PyValueError;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use heapless::{IndexMap, Vec as HeaplessVec};
use nohash_hasher;
use nohash_hasher::NoHashHasher as NoHashHasherType;
use hash32::BuildHasherDefault as HashConstructor;
use std::time::Instant;
use serde::Deserialize;
use serde_json;

// Type aliases with heapless for fixed memory usage
type NodeId = u32;

/// We assume a maximum of 2048 nodes. Each bit in the bitset corresponds to a node ID.
const MAX_NODE_COUNT: usize = 2048;
const BITSET_ARRAY_SIZE: usize = MAX_NODE_COUNT / 64;

/// A memory-efficient bitset for tracking node visitation
#[derive(Clone, Hash, Eq, PartialEq)]
pub struct NodeBitset {
    data: [u64; BITSET_ARRAY_SIZE],
}

impl NodeBitset {
    pub fn new() -> Self {
        NodeBitset { data: [0; BITSET_ARRAY_SIZE] }
    }

    pub fn set(&mut self, node_id: NodeId) {
        let idx = node_id as usize;
        if idx >= MAX_NODE_COUNT {
            panic!("Node ID exceeds maximum supported size of {}", MAX_NODE_COUNT);
        }
        let arr_idx = idx / 64;
        let bit_idx = idx % 64;
        self.data[arr_idx] |= 1u64 << bit_idx;
    }

    pub fn clear(&mut self, node_id: NodeId) {
        let idx = node_id as usize;
        if idx >= MAX_NODE_COUNT {
            panic!("Node ID exceeds maximum supported size of {}", MAX_NODE_COUNT);
        }
        let arr_idx = idx / 64;
        let bit_idx = idx % 64;
        self.data[arr_idx] &= !(1u64 << bit_idx);
    }

    pub fn contains(&self, node_id: NodeId) -> bool {
        let idx = node_id as usize;
        if idx >= MAX_NODE_COUNT {
            panic!("Node ID exceeds maximum supported size of {}", MAX_NODE_COUNT);
        }
        let arr_idx = idx / 64;
        let bit_idx = idx % 64;
        (self.data[arr_idx] & (1u64 << bit_idx)) != 0
    }
    
    pub fn count(&self) -> usize {
        self.data.iter().map(|&x| x.count_ones() as usize).sum()
    }
}

impl std::fmt::Debug for NodeBitset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NodeBitset {{ count: {} }}", self.count())
    }
}

// Graph structure
#[derive(Debug, Clone)]
struct Graph {
    adjacency: IndexMap<NodeId, HeaplessVec<NodeId, 8>, HashConstructor<NoHashHasherType<NodeId>>, 2048>,
}

impl Graph {
    fn new() -> Self {
        Graph {
            adjacency: IndexMap::new(),
        }
    }

    fn node_count(&self) -> usize {
        self.adjacency.len()
    }
    
    fn nodes(&self) -> Vec<NodeId> {
        self.adjacency.keys().copied().collect()
    }
    
    fn add_node(&mut self, id: NodeId) -> Result<(), ()> {
        match self.adjacency.insert(id, HeaplessVec::<NodeId, 8>::new()) {
            Ok(_) => Ok(()),
            Err(_) => Err(()),
        }
    }

    fn add_edge(&mut self, from: NodeId, to: NodeId) -> Result<(), ()> {
        if !self.adjacency.contains_key(&from) {
            self.add_node(from)?;
        }
        if !self.adjacency.contains_key(&to) {
            self.add_node(to)?;
        }
        
        if let Some(neighbors) = self.adjacency.get_mut(&from) {
            if !neighbors.iter().any(|&n| n == to) {
                if neighbors.push(to).is_err() {
                    return Err(());
                }
            }
        }
        if let Some(neighbors) = self.adjacency.get_mut(&to) {
            if !neighbors.iter().any(|&n| n == from) {
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
}

// Graph building
fn build_graph_from_adjacency(adjacency_list: &HashMap<String, Vec<String>>) -> (Graph, Vec<String>) {
    let mut name_to_id = HashMap::new();
    let mut id_to_name = Vec::new();
    
    for node_name in adjacency_list.keys() {
        if !name_to_id.contains_key(node_name) {
            let id = id_to_name.len() as u32;
            name_to_id.insert(node_name.clone(), id);
            id_to_name.push(node_name.clone());
        }
    }
    
    let mut graph = Graph::new();
    
    for (node_name, neighbors) in adjacency_list {
        let node_id = name_to_id[node_name];
        let _ = graph.add_node(node_id);
        
        for neighbor_name in neighbors {
            let neighbor_id = name_to_id[neighbor_name];
            let _ = graph.add_edge(node_id, neighbor_id);
        }
    }
    
    (graph, id_to_name)
}

// Helper function to sort neighbors in clockwise order
fn sort_neighbors_clockwise(adjacency_list: &HashMap<String, Vec<String>>) -> HashMap<String, Vec<String>> {
    let mut sorted_adjacency_list = HashMap::new();
    
    for (center_str, neighbors) in adjacency_list {
        let center: usize = center_str.parse().unwrap_or(0);
        
        if neighbors.len() <= 1 {
            sorted_adjacency_list.insert(center_str.clone(), neighbors.clone());
            continue;
        }
        
        let mut upper_row = Vec::new();
        let mut lower_row = Vec::new();
        let mut same_row_prev = None;
        let mut same_row_next = None;
        
        for node_str in neighbors {
            let node: usize = node_str.parse().unwrap_or(0);
            
            if node == center - 1 {
                same_row_prev = Some(node_str.clone());
            } else if node == center + 1 {
                same_row_next = Some(node_str.clone());
            } else if node < center {
                upper_row.push(node_str.clone());
            } else {
                lower_row.push(node_str.clone());
            }
        }
        
        upper_row.sort_by(|a, b| {
            let a_num: usize = a.parse().unwrap_or(0);
            let b_num: usize = b.parse().unwrap_or(0);
            a_num.cmp(&b_num)
        });
        
        lower_row.sort_by(|a, b| {
            let a_num: usize = a.parse().unwrap_or(0);
            let b_num: usize = b.parse().unwrap_or(0);
            b_num.cmp(&a_num)
        });
        
        let mut result = Vec::new();
        result.extend(upper_row);
        if let Some(next) = same_row_next {
            result.push(next);
        }
        result.extend(lower_row);
        if let Some(prev) = same_row_prev {
            result.push(prev);
        }
        
        sorted_adjacency_list.insert(center_str.clone(), result);
    }
    
    sorted_adjacency_list
}

// Optimized brute force approach
fn exact_longest_path_optimized(graph: &Graph) -> Vec<NodeId> {
    let node_count = graph.node_count();
    
    // Pre-calculate and cache low-degree nodes to avoid repeated filtering
    let start_nodes: Vec<_> = {
        let mut nodes = Vec::with_capacity(node_count / 4);
        for &node in graph.nodes().iter() {
            if graph.get_neighbors(node).len() <= 2 {
                nodes.push(node);
            }
        }
        nodes
    };
    
    // Use all nodes if not enough low-degree nodes found
    let nodes_to_try = if start_nodes.len() < 2 { graph.nodes() } else { start_nodes.clone() };
    
    let best_len = AtomicUsize::new(0);
    let result = Arc::new(Mutex::new(Vec::with_capacity(node_count)));
    
    let thread_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(std::thread::available_parallelism().map(|x| x.get()).unwrap_or(8))
        .build()
        .unwrap();
    
    thread_pool.install(|| {
        nodes_to_try.par_iter().for_each(|&start_node| {
            let mut local_best_len = 0;
            let mut local_best_path = Vec::with_capacity(node_count);
            let mut visited = NodeBitset::new();
            let mut path = Vec::with_capacity(node_count);
            
            visited.set(start_node);
            path.push(start_node);
            
            backtrack_exact_standard_optimized(
                graph,
                &mut path,
                &mut visited,
                &mut local_best_len,
                &mut local_best_path
            );
            
            let current_best = best_len.load(Ordering::Relaxed);
            if local_best_len > current_best {
                if best_len.compare_exchange(
                    current_best, 
                    local_best_len, 
                    Ordering::SeqCst, 
                    Ordering::Relaxed
                ).is_ok() {
                    let mut path_guard = result.lock().unwrap();
                    *path_guard = local_best_path;
                }
            }
        });
    });
    
    let final_result = result.lock().unwrap().clone();
    println!("Found path of {}/{} nodes ({}%)", 
              final_result.len(), node_count, 
              (final_result.len() as f32 * 100.0 / node_count as f32) as u32);
    
    final_result
}

#[inline(always)]
fn backtrack_exact_standard_optimized(
    graph: &Graph,
    path: &mut Vec<NodeId>,
    visited: &mut NodeBitset,
    best_length: &mut usize,
    best_path: &mut Vec<NodeId>,
) {
    if path.len() > *best_length {
        *best_length = path.len();
        best_path.clear();
        best_path.extend_from_slice(path);
    }
    
    let current = *path.last().unwrap();
    let neighbors = graph.get_neighbors(current);
    
    match neighbors.len() {
        0 => return, // Dead-end
        1 => {
            let neighbor = neighbors[0];
            if !visited.contains(neighbor) {
                visited.set(neighbor);
                path.push(neighbor);
                
                backtrack_exact_standard_optimized(
                    graph, path, visited, best_length, best_path
                );
                
                path.pop();
                visited.clear(neighbor);
            }
        },
        2 => {
            let n1 = neighbors[0];
            let n2 = neighbors[1];
            
            if !visited.contains(n1) {
                visited.set(n1);
                path.push(n1);
                
                backtrack_exact_standard_optimized(
                    graph, path, visited, best_length, best_path
                );
                
                path.pop();
                visited.clear(n1);
            }
            
            if !visited.contains(n2) {
                visited.set(n2);
                path.push(n2);
                
                backtrack_exact_standard_optimized(
                    graph, path, visited, best_length, best_path
                );
                
                path.pop();
                visited.clear(n2);
            }
        },
        _ => {
            for &neighbor in neighbors {
                if !visited.contains(neighbor) {
                    visited.set(neighbor);
                    path.push(neighbor);
                    
                    backtrack_exact_standard_optimized(
                        graph, path, visited, best_length, best_path
                    );
                    
                    path.pop();
                    visited.clear(neighbor);
                }
            }
        }
    }
}

// Data structures for deserialization
#[derive(Deserialize)]
struct MazeData {
    components: Vec<HashMap<String, Vec<String>>>,
}

#[pyfunction]
pub fn process_and_solve_maze(py: Python, data: PyObject) -> PyResult<Vec<Vec<String>>> {
    let total_start = Instant::now();
    let data_str = data.extract::<String>(py)?;
    
    py.allow_threads(move || {
        let maze_data: MazeData = serde_json::from_str(&data_str)
            .map_err(|e| PyErr::new::<PyValueError, _>(format!("JSON error: {}", e)))?;
        
        println!("SOLVING: {} components", maze_data.components.len());
        
        // Process each component in parallel and collect results
        let results: Vec<Vec<String>> = maze_data.components.par_iter()
            .map(|component| {
                // Sort neighbors clockwise for better performance
                let sorted_component = sort_neighbors_clockwise(component);
                let (graph, id_to_name) = build_graph_from_adjacency(&sorted_component);
                
                // Find the longest path using only the optimized approach
                let mut path_ids = exact_longest_path_optimized(&graph);
                
                // Validate the path
                if !validate_path(&graph, &path_ids) {
                    println!("WARNING: Found invalid path: {:?}", path_ids);
                    println!("Retrying algorithm once...");
                    
                    // Retry once
                    path_ids = exact_longest_path_optimized(&graph);
                    
                    // Check again
                    if !validate_path(&graph, &path_ids) {
                        println!("ERROR: Still found invalid path after retry: {:?}", path_ids);
                        panic!("Failed to find valid path after retry");
                    } else {
                        println!("Retry successful, found valid path");
                    }
                }
                
                // Convert node IDs back to names
                path_ids.iter().map(|&id| id_to_name[id as usize].clone()).collect()
            })
            .collect();
        
        println!("TOTAL TIME: {:?}", total_start.elapsed());
        
        Ok(results)
    })
}

// Function to verify a path is valid (no duplicates, all edges exist)
fn validate_path(graph: &Graph, path: &[NodeId]) -> bool {
    if path.is_empty() {
        return true;
    }
    
    // Check for duplicates
    let mut seen = HashSet::new();
    for &node in path {
        if !seen.insert(node) {
            return false; // Duplicate found
        }
    }
    
    // Check all edges exist
    for i in 0..path.len()-1 {
        let curr = path[i];
        let next = path[i+1];
        
        if !graph.get_neighbors(curr).contains(&next) {
            return false; // Non-adjacent nodes
        }
    }
    
    true
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