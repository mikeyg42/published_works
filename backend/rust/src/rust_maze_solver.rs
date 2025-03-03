use pyo3::prelude::*;
use pyo3::exceptions::PyValueError;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use serde::Deserialize;
use heapless::{IndexMap, Vec as HeaplessVec};
use nohash_hasher;
use nohash_hasher::NoHashHasher as NoHashHasherType;
use hash32::BuildHasherDefault as HashConstructor;
use std::time::Instant;
use serde_json;
use rand::Rng;
// Type aliases with heapless for fixed memory usage
type NodeId = u32;
type Face = HeaplessVec<NodeId, 128>;

/// We assume a maximum of 2048 nodes. Each bit in the bitset corresponds to a node ID.
const MAX_NODE_COUNT: usize = 2048;
const BITSET_ARRAY_SIZE: usize = MAX_NODE_COUNT / 64;
const MAX_FACE_SIZE: usize = 28;
const MAX_SIZE_BRUTE_FORCE: usize = 100;
const BACKTRACK_TIME_LIMIT: u64 = 12; // in seconds
const NUM_ENDPOINT_HEURISTIC: usize = 254;
//const MAX_TIME_RANDOM_WALKS: u64 = 8; // in seconds

/// A memory-efficient bitset for tracking node visitation
#[derive(Clone)]
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

    fn next_clockwise_neighbor(&self, node: NodeId, from: NodeId) -> Option<NodeId> {
        if let Some(neighbors) = self.adjacency.get(&node) {
            let pos = neighbors.iter().position(|&n| n == from)?;
            Some(neighbors[(pos + 1) % neighbors.len()])
        } else {
            None
        }
    }
}

// Face finder
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

    fn build_faces(&mut self, graph: &Graph) -> &[Face] {
        self.visited_half_edges.clear();
        self.faces.clear();
        
        println!("Starting face detection");
        
        for &node in graph.nodes().iter() {
            for &neighbor in graph.get_neighbors(node) {
                if self.visited_half_edges.contains(&(node, neighbor)) {
                    continue;
                }
                
                self.find_face_clockwise(graph, node, neighbor);
            }
        }
        
        println!("Found {} faces", self.faces.len());
        &self.faces
    }

    fn find_face_clockwise(&mut self, graph: &Graph, start_node: NodeId, first_neighbor: NodeId) {
        let mut face = Face::new();
        let mut current = start_node;
        let mut next = first_neighbor;
        
        if face.push(current).is_err() {
            return;
        }

        loop {
            self.visited_half_edges.insert((current, next));
            
            let prev = current;
            current = next;
            
            if face.push(current).is_err() {
                return;
            }
            
            if current == start_node {
                break;
            }
            
            if let Some(neighbor) = graph.next_clockwise_neighbor(current, prev) {
                next = neighbor;
            } else {
                return;
            }
            
            if face.len() > MAX_FACE_SIZE {
                return;
            }
        }
        
        if face.len() >= 3 && face.len() <= MAX_FACE_SIZE {
            self.faces.push(face);
        }
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

// Path finder
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
        let node_count = graph.node_count();
        
        // For small graphs, use brute force
        if node_count <= MAX_SIZE_BRUTE_FORCE {
            let start_time = Instant::now();
            let result = exact_longest_path_standard(graph);
            println!("RESULT: Brute force: {} nodes ({}%) in {:?}", 
                result.len(), 
                (result.len() as f32 * 100.0 / node_count as f32) as u32,
                start_time.elapsed());
            result
        } else {     
            // For larger graphs, use heuristic approach
            let start_time = Instant::now();
            let heuristic_path = self.find_heuristic_path(graph, faces);
            let time = start_time.elapsed();
            
            println!("RESULT: Heuristic: {}/{} nodes ({}%) in {:?}", 
                heuristic_path.len(), node_count, 
                (heuristic_path.len() as f32 * 100.0 / node_count as f32) as u32, time);
            
            heuristic_path
        }
    }

    fn find_heuristic_path(&mut self, graph: &Graph, faces: &[Face]) -> Vec<NodeId> {
        let start_nodes = graph.nodes();
        let node_count = graph.node_count();
        
        // Select the most promising 200 start nodes
        let pruned_start_nodes: Vec<_> = if node_count > NUM_ENDPOINT_HEURISTIC {
            let mut selected = Vec::with_capacity(NUM_ENDPOINT_HEURISTIC);
            let mut degree_buckets: Vec<Vec<NodeId>> = vec![Vec::new(); 5]; // Buckets for degree 1-5+
            
            // Categorize nodes by degree
            for &node in &start_nodes {
                let degree = graph.get_neighbors(node).len();
                let bucket = degree.min(5) - 1; // Maps degrees 1-5+ to indices 0-4
                degree_buckets[bucket].push(node);
            }
            
            // Always include all degree 1 nodes (likely endpoints)
            selected.extend(&degree_buckets[0]);
            
            // Add degree 2 nodes if needed
            if selected.len() < NUM_ENDPOINT_HEURISTIC {
                let mut degree2_selected: Vec<NodeId> = Vec::new();
                let degree2_count = (NUM_ENDPOINT_HEURISTIC - selected.len()).min(degree_buckets[1].len());
                
                if degree2_count > 0 {
                    let mut sorted_degree2 = degree_buckets[1].clone();
                    sorted_degree2.sort_by_key(|&id| id % 97); // Prime number for better distribution
                    degree2_selected.extend(&sorted_degree2[0..degree2_count]);
                }
                
                selected.extend(degree2_selected);
            }
            
            // Add higher degree nodes if still needed
            if selected.len() < NUM_ENDPOINT_HEURISTIC {
                let mut high_degree = Vec::new();
                for i in 2..5 { // Degrees 3, 4, 5+
                    high_degree.extend(&degree_buckets[i]);
                }
                
                high_degree.sort_by_key(|&id| id % 101); // Different prime for diversity
                
                let remaining = NUM_ENDPOINT_HEURISTIC - selected.len();
                let high_degree_count = remaining.min(high_degree.len());
                if high_degree_count > 0 {
                    selected.extend(&high_degree[0..high_degree_count]);
                }
            }

            selected
        } else {
            // For smaller graphs, try all nodes
            start_nodes
        };
        
        println!("Exploring paths from {} start nodes in graph with {} total nodes", 
            pruned_start_nodes.len(), node_count);
        
        // Process start nodes in parallel
        let thread_count = rayon::current_num_threads();
        let chunk_size = ((pruned_start_nodes.len() / thread_count) + 1).max(1);
        
        println!("Using {} threads with chunk size {}", thread_count, chunk_size);
        
        let results: Vec<(usize, Vec<NodeId>)> = pruned_start_nodes
            .par_chunks(chunk_size)
            .map(|nodes| {
                let mut local_best_length = 0;
                let mut local_best_path = Vec::new();
                let mut work_path = Vec::with_capacity(MAX_NODE_COUNT);
                
                for &start_node in nodes {
                    let mut visited = NodeBitset::new();
                    visited.set(start_node);
                    
                    work_path.clear();
                    work_path.push(start_node);
                    
                    // Use iterative deepening for large graphs
                    if node_count > 500 {
                        for depth_limit in &[80, 175, 360, 2400, 5000, 7500] {
                            let pre_search_best = local_best_length;
                            
                            bnb_search_local(
                                graph, faces, &mut work_path, &mut visited,
                                &mut local_best_length, &mut local_best_path,
                                0, *depth_limit
                            );
                            
                            // If we improved significantly, try deeper
                            if local_best_length > pre_search_best + 8 {
                                continue;
                            }
                            
                            // If little improvement, no need to explore deeper
                            if local_best_length <= pre_search_best + 1 {
                                break;
                            }
                        }
                    } else {
                        // For smaller graphs, go deep right away
                        bnb_search_local(
                            graph, faces, &mut work_path, &mut visited,
                            &mut local_best_length, &mut local_best_path,
                            0, 7500
                        );
                    }
                }
                
                (local_best_length, local_best_path)
            })
            .collect();
        
        // Find the best result across all threads
        for (length, path) in results {
            if length > self.global_best_length {
                self.global_best_length = length;
                self.global_best_path = path.clone();
                println!("Found new best path: {} nodes", length);
            }
        }
        
        let coverage_pct = (self.global_best_length as f32 * 100.0 / node_count as f32) as u32;
        println!("Best path found: {} nodes out of {} total ({}%)", 
            self.global_best_length, node_count, coverage_pct);
        
        // For larger graphs using heuristic with "ehh coverage, try endpoint optimization
        if coverage_pct < 85 && !self.global_best_path.is_empty() {
            self.global_best_path = refine_path_endpoints_subgraph(graph, &self.global_best_path);
        }
        // if the end_point refinement helped at least 1%, do it again, but loose an extra vertex on each side
        if coverage_pct < 85 && self.global_best_path.len() as f32* 100.0 / node_count as f32 >= coverage_pct as f32+1.0 {
            if !self.global_best_path.is_empty() && self.global_best_path.len() >= 3 {
                let trimmed_path = &self.global_best_path[1..self.global_best_path.len() - 1];
                self.global_best_path = refine_path_endpoints_subgraph(graph, trimmed_path);
            }
        }
 
        self.global_best_path.clone()
    }

    // Improved heuristic method - runs for specified time budget
    fn find_longer_heuristic_path(&mut self, graph: &Graph, faces: &[Face]) -> Vec<NodeId> {
        let start_time = Instant::now();
        let node_count = graph.node_count();
        
        // Scale time budget with graph size
        let time_budget = if node_count > 500 {
            std::time::Duration::from_secs(5)
        } else if node_count > 300 {
            std::time::Duration::from_secs(3)
        } else {
            std::time::Duration::from_secs(1)
        };
        
        let time_limit = start_time + time_budget;
        
        // Phase 1: Get initial path with current heuristic
        let initial_path = self.find_heuristic_path(graph, faces);
        println!("Initial heuristic path: {} nodes", initial_path.len());
        
        // Phase 2: Run enhanced random walks with simulated annealing
        let random_path = random_walk_improvements(graph, &initial_path, time_limit);
        
        // Return the best path found
        if random_path.len() > initial_path.len() {
            println!("Enhanced path: {} nodes ({}%) in {:?}", 
                random_path.len(), 
                (random_path.len() as f32 * 100.0 / node_count as f32) as u32,
                start_time.elapsed());
            random_path
        } else {
            println!("No improvement found, keeping original path: {} nodes", 
                    initial_path.len());
            initial_path
        }
    }

}


// Branch and bound search
fn bnb_search_local(
    graph: &Graph,
    faces: &[Face],
    work_path: &mut Vec<NodeId>,
    visited: &mut NodeBitset,
    local_best_length: &mut usize,
    local_best_path: &mut Vec<NodeId>,
    depth: usize,
    depth_limit: usize
) {
    // Early returns
    if depth >= depth_limit { return; }

    let current_length = work_path.len();
    let last_node = *work_path.last().unwrap();

    // Face-based pruning with relaxed bound
    if faces.len() > 0 {
        let face_bound = enhanced_face_heuristic(graph, work_path, visited, faces);
        if current_length + face_bound * 8 / 10 < *local_best_length {
            return;
        }
    }

    // Update best if improved
    if current_length > *local_best_length {
        *local_best_length = current_length;
        *local_best_path = work_path.clone();
    }

    // Get unvisited neighbors
    let neighbors: Vec<_> = graph.get_neighbors(last_node)
        .iter()
        .copied()
        .filter(|&n| !visited.contains(n))
        .collect();
    
    // Order neighbors
    let mut ordered_neighbors = neighbors;
    if graph.node_count() > 180 {
        if depth < 20 {
            ordered_neighbors.sort_by_key(|&n| graph.get_neighbors(n).len());
        } else {
            if depth % 2 == 0 {
                ordered_neighbors.sort_by_key(|&n| graph.get_neighbors(n).len());
            } else {
                ordered_neighbors.sort_by_key(|&n| std::cmp::Reverse(graph.get_neighbors(n).len()));
            }
        }
    }
    
    // Process neighbors
    for &neighbor in &ordered_neighbors {
        visited.set(neighbor);
        work_path.push(neighbor);

        bnb_search_local(
            graph, faces, work_path, visited,
            local_best_length, local_best_path,
            depth + 1, depth_limit
        );

        work_path.pop();
        visited.clear(neighbor);
    }
}

// Face heuristic
fn enhanced_face_heuristic(
    graph: &Graph,
    current_path: &[NodeId],
    visited: &NodeBitset,
    faces: &[Face]
) -> usize {
    if faces.is_empty() {
        let remaining = graph.node_count() - visited.count();
        return remaining;
    }

    let last_node = *current_path.last().unwrap();

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

    // If no faces contain the last node, be optimistic
    if reachable_faces.is_empty() {
        let remaining = graph.node_count() - visited.count();
        return remaining;
    }

    // Calculate total reachable nodes with bonus
    let mut total_reachable = reachable_faces
        .iter()
        .map(|&idx| {
            faces[idx]
                .iter()
                .filter(|&&id| !visited.contains(id))
                .count()
        })
        .sum();

    // Add a bonus to encourage exploration
    total_reachable = (total_reachable * 11) / 10; // Add 10% bonus

    let leftover_nodes = graph.node_count() - visited.count();
    leftover_nodes.min(total_reachable)
}

//  ================ Brute force exact solution
// Standard brute force (existing implementation)
fn exact_longest_path_standard(graph: &Graph) -> Vec<NodeId> {
    let start = Instant::now();
    let node_count = graph.node_count();
    
    // Get low-degree nodes as starting points
    let start_nodes: Vec<_> = graph.nodes().iter()
        .filter(|&&node| graph.get_neighbors(node).len() <= 2)
        .copied()
        .collect();
    
    // Use all nodes if not enough low-degree nodes found
    let nodes_to_try = if start_nodes.len() < 2 { graph.nodes() } else { start_nodes };
    
    // Shared atomic best length
    let best_len = AtomicUsize::new(0);
    let best_path = Arc::new(Mutex::new(Vec::with_capacity(node_count)));
    
    // Process in parallel with standard approach
    nodes_to_try.par_iter().for_each(|&start_node| {
        let mut local_best_len = 0;
        let mut local_best_path = Vec::with_capacity(node_count);
        let mut visited = NodeBitset::new();
        let mut path = Vec::with_capacity(node_count);
        
        visited.set(start_node);
        path.push(start_node);
        
        backtrack_exact_standard(
            graph,
            &mut path,
            &mut visited,
            &mut local_best_len,
            &mut local_best_path,
            start,
            std::time::Duration::from_secs(BACKTRACK_TIME_LIMIT)
        );
        
        // Only update global best if our local result is better
        let current_best = best_len.load(Ordering::Relaxed);
        if local_best_len > current_best {
            // First update the atomic length
            best_len.store(local_best_len, Ordering::Relaxed);
            // Then grab the mutex to update the path
            let mut path_guard = best_path.lock().unwrap();
            *path_guard = local_best_path;
        }
    });
    
    // Get final result
    let result = best_path.lock().unwrap().clone();
    println!("Standard BF: Found path of {}/{} nodes ({}%) in {:?}", 
              result.len(), node_count, 
              (result.len() as f32 * 100.0 / node_count as f32) as u32,
              start.elapsed());
    
    result
}

// Recursive backtracking with Vec (standard)
fn backtrack_exact_standard(
    graph: &Graph,
    path: &mut Vec<NodeId>,
    visited: &mut NodeBitset,
    best_length: &mut usize,
    best_path: &mut Vec<NodeId>,
    start_time: Instant,
    time_limit: std::time::Duration
) {
    // Check time limit periodically
    if path.len() % 10 == 0 && start_time.elapsed() > time_limit {
        return;
    }

    // Update best if current path is longer
    if path.len() > *best_length {
        *best_length = path.len();
        best_path.clear();
        best_path.extend(path.iter());
    }
    
    // Try all unvisited neighbors
    let current = *path.last().unwrap();
    for &neighbor in graph.get_neighbors(current) {
        if !visited.contains(neighbor) {
            visited.set(neighbor);
            path.push(neighbor);
            
            backtrack_exact_standard(
                graph, path, visited, best_length, best_path,
                start_time, time_limit
            );
            
            // Backtrack
            path.pop();
            visited.clear(neighbor);
        }
    }
}

// ======= Improved sequential benchmarking
fn check_brute_force(
    components: &[HashMap<String, Vec<String>>],
    solutions: &[Vec<String>]
) {
    println!("\n==== BENCHMARK ====");
    
    // Find second largest component
    if components.len() < 2 {
        println!("BENCHMARK: Not enough components");
        return;
    }
    
    // Sort components by size
    let mut component_indices: Vec<(usize, usize)> = components
        .iter()
        .enumerate()
        .map(|(idx, c)| (idx, c.len()))
        .collect();
    
    component_indices.sort_by(|a, b| b.1.cmp(&a.1));
    let (second_idx, second_size) = component_indices[1];
    
    // Skip if too large
    if second_size > 300 {
        println!("BENCHMARK: Component too large ({} nodes)", second_size);
        return;
    }
    
    println!("BENCHMARK: Component size: {} nodes", second_size);
    let second_component = &components[second_idx];
    
    // Find matching solution
    let component_nodes: HashSet<&String> = second_component.keys().collect();
    let matching_idx = solutions.iter().position(|solution| {
        !solution.is_empty() && solution.iter().any(|node| component_nodes.contains(node))
    });
    
    if matching_idx.is_none() {
        println!("BENCHMARK: No matching solution found");
        return;
    }
    
    let optimized = &solutions[matching_idx.unwrap()];
    
    // Prepare the graph
    let sorted_component = sort_neighbors_clockwise(second_component);
    let (graph, _id_to_name) = build_graph_from_adjacency(&sorted_component);
    
    // Find faces
    let faces = {
        let mut face_finder = FaceFinder::new();
        face_finder.build_faces(&graph).to_vec()
    };
    
    // Run standard brute force
    println!("\nRunning standard brute force...");
    let start_standard = Instant::now();
    let standard_path = exact_longest_path_standard(&graph);
    let standard_time = start_standard.elapsed();
    let standard_len = standard_path.len();
    
    // Run original heuristic
    println!("\nRunning original heuristic...");
    let start_original = Instant::now();
    let mut path_finder = PathFinder::new();
    let original_path = path_finder.find_heuristic_path(&graph, &faces);
    let original_time = start_original.elapsed();
    let original_len = original_path.len();
    
    // Run improved heuristic
    println!("\nRunning improved heuristic...");
    let start_improved = Instant::now();
    let mut path_finder2 = PathFinder::new();
    let improved_path = path_finder2.find_longer_heuristic_path(&graph, &faces);
    let improved_time = start_improved.elapsed();
    let improved_len = improved_path.len();
    
    // Print results table
    println!("\n========== RESULTS ==========");
    println!("| Method           | Length | Time      | % of Optimal |");
    println!("|------------------|--------|-----------|--------------|");
    println!("| Standard BF      | {:6} | {:9?} | {:12.1}% |", 
              standard_len, standard_time, 100.0);
    println!("| Original Heur.   | {:6} | {:9?} | {:12.1}% |", 
              original_len, original_time, 
              (original_len as f32 / standard_len as f32) * 100.0);
    println!("| Improved Heur.   | {:6} | {:9?} | {:12.1}% |", 
              improved_len, improved_time,
              (improved_len as f32 / standard_len as f32) * 100.0);
    println!("| Pre-computed     | {:6} | N/A       | {:12.1}% |", 
              optimized.len(), 
              (optimized.len() as f32 / standard_len as f32) * 100.0);
    
    println!("============================");
}

// ========================== Verify path ================
// Function to verify a path is valid (no duplicates, all edges exist)
fn verify_path(graph: &Graph, path: &[NodeId]) -> bool {
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


// ========================== Main function ===========

// Data structures for deserialization
#[derive(Deserialize)]
struct MazeData {
    #[serde(rename = "largeComponents")]
    large_components: Vec<HashMap<String, Vec<String>>>,
}

#[pyfunction]
pub fn process_and_solve_maze(py: Python, data: PyObject) -> PyResult<Vec<Vec<String>>> {
    let total_start = Instant::now();
    let data_str = data.extract::<String>(py)?;
    
    py.allow_threads(move || {
        let maze_data: MazeData = serde_json::from_str(&data_str)
            .map_err(|e| PyErr::new::<PyValueError, _>(format!("JSON error: {}", e)))?;
        
        println!("SOLVING: {} components", maze_data.large_components.len());
        let components_clone = maze_data.large_components.clone();
        
        // Process all components in parallel
        let solutions = maze_data.large_components
            .into_par_iter()
            .enumerate()
            .map(|(idx, component)| {
                let start = Instant::now();
                let node_count = component.len();
                
                // Component identifier for logs
                let comp_id = format!("C{}({})", idx, node_count);
                println!("{}: Starting", comp_id);
                
                // Build graph
                let sorted_component = sort_neighbors_clockwise(&component);
                let (graph, id_to_name) = build_graph_from_adjacency(&sorted_component);
                
                // Find faces
                let faces = {
                    let mut face_finder = FaceFinder::new();
                    let faces = face_finder.build_faces(&graph);
                    println!("{}: Found {} faces", comp_id, faces.len());
                    faces.to_vec()
                };
                
                // Find path
                let mut path_finder = PathFinder::new();
                let best_path_ids = path_finder.find_longest_path(&graph, &faces);
                
                // Convert to strings
                let best_path: Vec<String> = best_path_ids.into_iter()
                    .map(|id| id_to_name[id as usize].clone())
                    .collect();
                
                let coverage = (best_path.len() as f32 * 100.0 / node_count as f32) as u32;
                println!("{}: Completed - {}/{} nodes ({}%) in {:?}", 
                         comp_id, best_path.len(), node_count, coverage, start.elapsed());
                
                Ok(best_path)
            })
            .collect::<PyResult<Vec<_>>>()?;
            
        println!("TOTAL TIME: {:?}", total_start.elapsed());
        
        // Run benchmark
        check_brute_force(&components_clone, &solutions);
        
        Ok(solutions)
    })
}


// ================ refine path endpoints ================
/// Refine the path endpoints by excluding the existing path's nodes
/// and brute-forcing within the smaller subgraph. We do this twice:
/// once near the "back" of the path and once near the "front."

/// Refine both endpoints sequentially: first refine near the back,
/// then refine near the front.
fn refine_path_endpoints_subgraph(
    graph: &Graph,
    current_path: &[NodeId],
) -> Vec<NodeId> {
    if current_path.len() < 6 {
        return current_path.to_vec();
    }

    let mut best_path = current_path.to_vec();

    // 1) Refine the back (4th-from-last)
    if let Some(improved) = refine_one_endpoint_subgraph(graph, &best_path, false) {
        best_path = improved;
    }
    // 2) Refine the front (4th-from-front)
    if let Some(improved) = refine_one_endpoint_subgraph(graph, &best_path, true) {
        best_path = improved;
    }

    best_path
}
/// Single-endpoint refinement:
/// - Decide which end to "trim" (front vs. back).
/// - Exclude those path nodes from the graph, extracting a sub-component.
/// - Run a brute force search on that smaller subgraph from the trim node.
/// - Attach the new subpath if it's strictly longer.
/// Refine the endpoints by excluding the current path's nodes and
/// running an exact search on the reachable subgraph. Returns an improved
/// path if an extension is found; otherwise, returns None.
fn refine_one_endpoint_subgraph(
    graph: &Graph,
    path: &[NodeId],
    refine_front: bool,
) -> Option<Vec<NodeId>> {
    if path.len() < 6 {
        return None;
    }

    // For front refinement, target path[4]; for back refinement, target path[len-5].
    let (trim_idx, keep_head_first) = if refine_front {
        (4, false)  // We will prepend a new subpath.
    } else {
        (path.len() - 5, true) // We will append a new subpath.
    };

    let trim_node = path[trim_idx];

    // Build exclusion set for the current path.
    let mut path_nodes = NodeBitset::new();
    for &n in path {
        path_nodes.set(n);
    }

    // Get the connected subgraph (as node IDs) reachable from trim_node,
    // excluding any node already in the path.
    let sub_nodes = get_subgraph_nodes_excluding_path(graph, trim_node, &path_nodes);
    // Early exit if there is no new area accessible.
    if sub_nodes.len() <= 1 {
        return None;
    }

    // Build the subgraph from sub_nodes.
    let subg = match build_subgraph_from_nodes(graph, &sub_nodes) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("Error building subgraph: {}", e);
            return None;
        }
    };

    // Run an exact search (brute force) on the subgraph starting from trim_node.
    let (sub_best_len, sub_best_path) = exact_longest_path_subgraph(&subg, trim_node);
    if sub_best_len <= 1 {
        return None;
    }

    // Merge the new subpath into the current path.
    let mut new_path = Vec::new();
    let mut included = NodeBitset::new();
    if keep_head_first {
        // For back refinement: keep original [0..=trim_idx], then append subpath.
        for &node in &path[0..=trim_idx] {
            new_path.push(node);
            included.set(node);
        }
        for &node in &sub_best_path {
            if !included.contains(node) {
                new_path.push(node);
                included.set(node);
            }
        }
    } else {
        // For front refinement: prepend subpath, then append original [trim_idx..].
        for &node in &sub_best_path {
            if !included.contains(node) {
                new_path.push(node);
                included.set(node);
            }
        }
        for &node in &path[trim_idx..] {
            if !included.contains(node) {
                new_path.push(node);
                included.set(node);
            }
        }
    }

    if new_path.len() > path.len() && verify_path(graph, &new_path) {
        Some(new_path)
    } else {
        None
    }
}

/// Gather all nodes reachable from `start` without touching `exclude`.
#[inline]
fn get_subgraph_nodes_excluding_path(
    graph: &Graph,
    start: NodeId,
    exclude: &NodeBitset,
) -> Vec<NodeId> {
    let mut sub_nodes = Vec::new();
    let mut queue = VecDeque::new();
    let mut visited = NodeBitset::new();

    if !exclude.contains(start) {
        queue.push_back(start);
        visited.set(start);
    }

    while let Some(u) = queue.pop_front() {
        sub_nodes.push(u);
        for &nbr in graph.get_neighbors(u) {
            if !exclude.contains(nbr) && !visited.contains(nbr) {
                visited.set(nbr);
                queue.push_back(nbr);
            }
        }
    }
    sub_nodes
}

/// Build a mini-subgraph containing only `sub_nodes`.
/// Adjacency is stored similarly to main Graph. Adjust as needed.

#[inline]
fn build_subgraph_from_nodes(graph: &Graph, sub_nodes: &[NodeId]) -> Result<Graph, String> {
    let mut in_sub = NodeBitset::new();
    for &n in sub_nodes {
        in_sub.set(n);
    }
    let mut new_graph = Graph::new();
    for &n in sub_nodes {
        new_graph.add_node(n)
            .map_err(|_| format!("Failed to add node {} to subgraph", n))?;
    }
    for &n in sub_nodes {
        for &nbr in graph.get_neighbors(n) {
            if in_sub.contains(nbr) {
                new_graph.add_edge(n, nbr)
                    .map_err(|_| format!("Failed to add edge {}-{} to subgraph", n, nbr))?;
            }
        }
    }
    Ok(new_graph)
}

/// A simple brute force over the subgraph (single-thread),
/// ensuring we start from `start_node`.
/// Returns (length, path).
fn exact_longest_path_subgraph(subg: &Graph, start_node: NodeId) -> (usize, Vec<NodeId>) {
    let mut visited = NodeBitset::new();
    visited.set(start_node);

    let mut path = vec![start_node];
    let mut best_len = 1;
    let mut best_path = path.clone();

    backtrack_subgraph(subg, &mut path, &mut visited, &mut best_len, &mut best_path);
    (best_len, best_path)
}

fn backtrack_subgraph(
    subg: &Graph,
    path: &mut Vec<NodeId>,
    visited: &mut NodeBitset,
    best_len: &mut usize,
    best_path: &mut Vec<NodeId>,
) {
    // Update best if current path is longer
    if path.len() > *best_len {
        *best_len = path.len();
        best_path.clear();
        best_path.extend_from_slice(path);
    }
    // Explore neighbors
    let current = *path.last().unwrap();
    for &nbr in subg.get_neighbors(current) {
        if !visited.contains(nbr) {
            visited.set(nbr);
            path.push(nbr);
            backtrack_subgraph(subg, path, visited, best_len, best_path);
            path.pop();
            visited.clear(nbr);
        }
    }
}
// ===========================

// Enhanced random walk algorithm with simulated annealing
fn random_walk_improvements(
    graph: &Graph,
    current_path: &[NodeId],
    time_limit: Instant
) -> Vec<NodeId> {
    let node_count = graph.node_count();
    let mut rng = rand::rng();

    
    // Best path found so far
    let mut best_path = current_path.to_vec();
    let mut best_length = current_path.len();
    
    println!("Starting random walks from path of length {}", best_length);
    
    // Generate diverse starting points across the graph
    let mut initial_paths = Vec::new();
    initial_paths.push(current_path.to_vec()); // Use current path
    
    // Add 20 completely fresh random walks from different start points
    for _ in 0..20 {
        if Instant::now() >= time_limit { break; }
        
        // Select random starting node, preferring low-degree nodes
        let start_nodes: Vec<_> = graph.nodes().iter()
            .filter(|&&node| graph.get_neighbors(node).len() <= 3)
            .copied()
            .collect();
            
        let start = if !start_nodes.is_empty() {
            start_nodes[rng.random_range(0..start_nodes.len())]
        } else {
            let nodes = graph.nodes();
            nodes[rng.random_range(0..nodes.len())]
        };
        
        // Create random walk
        let path = create_random_walk(graph, start);
        if path.len() > 10 { // Only keep reasonable paths
            initial_paths.push(path);
        }
    }
    
    // Process each path with simulated annealing
    for (idx, mut path) in initial_paths.into_iter().enumerate() {
        if Instant::now() >= time_limit { break; }
        
        println!("Optimizing path {} with length {}", idx, path.len());
        
        // Simulated annealing parameters
        let mut current_length = path.len();
        let mut temperature = 1.0;
        let cooling_rate = 0.95;
        
        // Run simulated annealing
        for iteration in 0..200 {
            if Instant::now() >= time_limit { break; }
            
            // Cool down
            temperature *= cooling_rate;
            
            // Choose random operation
            let operation = rng.random_range(0..4);
            
            // Apply selected operation to get new candidate path
            let candidate = match operation {
                0 => extend_path(&graph, &path),
                1 => create_detour(&graph, &path),
                2 => reverse_segment(&graph, &path),
                _ => recombine_with_best(&graph, &path, &best_path)
            };
            
            // Check if valid
            if !verify_path(&graph, &candidate) {
                continue;
            }
            
            let candidate_length = candidate.len();
            
            // Accept if better or with probability based on temperature
            if candidate_length > current_length || 
               rng.random::<f64>() < ((candidate_length as f64 - current_length as f64) 
                                  / temperature).exp() {
                path = candidate;
                current_length = candidate_length;
                
                // Update global best
                if current_length > best_length {
                    best_path = path.clone();
                    best_length = current_length;
                    println!("New best path: {} nodes ({}%)",
                        best_length, (best_length as f32 * 100.0 / node_count as f32) as u32);
                }
            }
            
            // Every 20 iterations, try path fusion
            if iteration % 20 == 0 && iteration > 0 {
                let fused = fuse_paths(&graph, &path, &best_path);
                if verify_path(&graph, &fused) && fused.len() > current_length {
                    path = fused;
                    current_length = path.len();
                    
                    if current_length > best_length {
                        best_path = path.clone();
                        best_length = current_length;
                        println!("Path fusion improved to {} nodes", best_length);
                    }
                }
            }
        }
    }
    
    best_path
}

// Create a completely random walk
fn create_random_walk(graph: &Graph, start: NodeId) -> Vec<NodeId> {
    let mut rng = rand::rng();
    let mut path = Vec::new();
    let mut visited = NodeBitset::new();
    
    path.push(start);
    visited.set(start);
    let mut current = start;
    
    // Take up to 300 random steps
    for _ in 0..300 {
        // Get unvisited neighbors
        let neighbors: Vec<_> = graph.get_neighbors(current)
            .iter()
            .copied()
            .filter(|&n| !visited.contains(n))
            .collect();
        
        if neighbors.is_empty() {
            break;
        }
        
        let next = neighbors[rng.random_range(0..neighbors.len())];
        path.push(next);
        visited.set(next);
        current = next;
    }
    
    path
}

// Extend path from either end
fn extend_path(graph: &Graph, path: &[NodeId]) -> Vec<NodeId> {
    if path.is_empty() {
        return Vec::new();
    }
    
    let mut rng = rand::rng();
    
    // Choose randomly whether to extend from start or end
    let from_start = rng.random_bool(0.5);
    let current_end = if from_start { path[0] } else { *path.last().unwrap() };
    
    // Track visited nodes
    let mut visited = NodeBitset::new();
    for &node in path {
        visited.set(node);
    }
    
    // Create extension
    let mut extension = Vec::new();
    let mut current = current_end;
    
    for _ in 0..100 {
        let neighbors: Vec<_> = graph.get_neighbors(current)
            .iter()
            .copied()
            .filter(|&n| !visited.contains(n))
            .collect();
        
        if neighbors.is_empty() {
            break;
        }
        
        let next = neighbors[rng.random_range(0..neighbors.len())];
        extension.push(next);
        visited.set(next);
        current = next;
    }
    
    // Apply extension
    if extension.is_empty() {
        return path.to_vec();
    }
    
    if from_start {
        let mut new_path = extension;
        new_path.reverse();
        new_path.extend_from_slice(path);
        new_path
    } else {
        let mut new_path = path.to_vec();
        new_path.extend_from_slice(&extension);
        new_path
    }
}

// Create a detour in the path
fn create_detour(graph: &Graph, path: &[NodeId]) -> Vec<NodeId> {
    if path.len() < 3 {
        return path.to_vec();
    }
    
    let mut rng = rand::rng();
    let idx = rng.random_range(1..path.len() - 1);
    
    // Create path nodes map
    let mut path_nodes = NodeBitset::new();
    for &node in path {
        path_nodes.set(node);
    }
    
    // Temporarily clear the current node to allow revisits
    path_nodes.clear(path[idx]);
    
    // Start detour from the selected point
    let mut detour = Vec::new();
    detour.push(path[idx]);
    
    let mut current = path[idx];
    let mut visited = path_nodes.clone(); // Start with all path nodes visited
    
    // Create random detour
    for _ in 0..50 {
        // Get neighbors that aren't in the path (except the entry/exit points)
        let neighbors: Vec<_> = graph.get_neighbors(current)
            .iter()
            .copied()
            .filter(|&n| !visited.contains(n))
            .collect();
        
        if neighbors.is_empty() {
            // Try to reconnect to the path
            let reconnect_neighbors: Vec<_> = graph.get_neighbors(current)
                .iter()
                .copied()
                .filter(|&n| path_nodes.contains(n) && n != path[idx-1] && n != path[idx+1])
                .collect();
                
            if !reconnect_neighbors.is_empty() {
                let reconnect = reconnect_neighbors[rng.random_range(0..reconnect_neighbors.len())];
                detour.push(reconnect);
                
                // Find reconnect point
                let reconnect_idx = path.iter().position(|&n| n == reconnect).unwrap();
                
                // Build new path
                let mut new_path = path[0..idx].to_vec();
                new_path.extend_from_slice(&detour);
                new_path.extend_from_slice(&path[reconnect_idx+1..]);
                
                return new_path;
            }
            break;
        }
        
        let next = neighbors[rng.random_range(0..neighbors.len())];
        detour.push(next);
        visited.set(next);
        current = next;
    }
    
    // Just return original if detour failed
    path.to_vec()
}

// Reverse a segment of the path
fn reverse_segment(graph: &Graph, path: &[NodeId]) -> Vec<NodeId> {
    if path.len() < 4 {
        return path.to_vec();
    }
    
    let mut rng = rand::rng();
    
    // Choose segment to reverse
    let len = path.len();
    let i = rng.random_range(1..len-2);
    let j = rng.random_range(i+1..len-1);
    
    // Create new path with reversed segment
    let mut new_path = Vec::with_capacity(len);
    new_path.extend_from_slice(&path[0..i]);
    
    // Add reversed segment
    for k in (i..=j).rev() {
        new_path.push(path[k]);
    }
    
    new_path.extend_from_slice(&path[j+1..]);
    
    // Verify connections at reversal points
    if i > 0 && !graph.get_neighbors(new_path[i-1]).contains(&new_path[i]) {
        return path.to_vec(); // Invalid connection
    }
    
    if j < len-1 && !graph.get_neighbors(new_path[j]).contains(&new_path[j+1]) {
        return path.to_vec(); // Invalid connection
    }
    
    new_path
}

// Recombine with best path
fn recombine_with_best(graph: &Graph, path1: &[NodeId], path2: &[NodeId]) -> Vec<NodeId> {
    if path1.is_empty() || path2.is_empty() {
        return path1.to_vec();
    }
    
    let mut rng = rand::rng();
    
    // Find connection points between paths
    let mut connections = Vec::new();
    
    for (i, &node1) in path1.iter().enumerate() {
        for (j, &node2) in path2.iter().enumerate() {
            if node1 == node2 || graph.get_neighbors(node1).contains(&node2) {
                connections.push((i, j, node1 == node2));
            }
        }
    }
    
    if connections.is_empty() {
        return path1.to_vec();
    }
    
    // Choose random connection
    let (i, j, is_same) = connections[rng.random_range(0..connections.len())];
    
    // Create recombined path
    let mut new_path = Vec::new();
    new_path.extend_from_slice(&path1[0..=i]);
    
    if !is_same {
        new_path.push(path2[j]); // Add connecting node if needed
    }
    
    new_path.extend_from_slice(&path2[j+1..]);
    
    if verify_path(graph, &new_path) {
        new_path
    } else {
        path1.to_vec()
    }
}

// Fuse two paths together
fn fuse_paths(graph: &Graph, path1: &[NodeId], path2: &[NodeId]) -> Vec<NodeId> {
    // Find all possible connections between paths
    let mut best_fusion = Vec::new();
    let mut best_length = 0;
    
    // Try different fusion methods
    let fusions = [
        // Connect start of path1 to start of path2
        try_connect_paths(graph, path1, true, path2, true),
        // Connect start of path1 to end of path2
        try_connect_paths(graph, path1, true, path2, false),
        // Connect end of path1 to start of path2
        try_connect_paths(graph, path1, false, path2, true),
        // Connect end of path1 to end of path2
        try_connect_paths(graph, path1, false, path2, false)
    ];
    
    // Find best fusion
    for fusion in fusions.into_iter() {
        if fusion.len() > best_length {
            best_length = fusion.len();
            best_fusion = fusion;
        }
    }
    
    if best_length > path1.len() && best_length > path2.len() {
        best_fusion
    } else if path1.len() >= path2.len() {
        path1.to_vec()
    } else {
        path2.to_vec()
    }
}

// Helper to connect two paths
fn try_connect_paths(
    graph: &Graph, 
    path1: &[NodeId], 
    from_start1: bool,
    path2: &[NodeId],
    from_start2: bool
) -> Vec<NodeId> {
    if path1.is_empty() || path2.is_empty() {
        return Vec::new();
    }
    
    // Get endpoints
    let endpoint1 = if from_start1 { path1[0] } else { *path1.last().unwrap() };
    let endpoint2 = if from_start2 { path2[0] } else { *path2.last().unwrap() };
    
    // Check if endpoints can be connected
    if endpoint1 != endpoint2 && !graph.get_neighbors(endpoint1).contains(&endpoint2) {
        return Vec::new();
    }
    
    // Create fused path
    let mut result = Vec::new();
    
    // Add first path in correct direction
    if from_start1 {
        // Add path1 in reverse
        for i in (0..path1.len()).rev() {
            result.push(path1[i]);
        }
    } else {
        // Add path1 forward
        result.extend_from_slice(path1);
    }
    
    // Add second path in correct direction
    if from_start2 {
        // Skip first node if it's a duplicate
        let start_idx = if endpoint1 == endpoint2 { 1 } else { 0 };
        result.extend_from_slice(&path2[start_idx..]);
    } else {
        // Add path2 in reverse, skipping duplicate
        let end_idx = if endpoint1 == endpoint2 { path2.len() - 1 } else { path2.len() };
        for i in (0..end_idx).rev() {
            result.push(path2[i]);
        }
    }
    
    result
}

//=============================

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