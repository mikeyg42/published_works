import networkx as nx
from typing import List, Dict
from fastapi import WebSocket
from maze_solver import process_and_solve_maze
import json
import asyncio
import concurrent.futures
import os
from backend.visualizer.graph_visualizer import GraphVisualizer
from ortools.linear_solver import pywraplp 
import time
from ortools.sat.python import cp_model
from ortools.sat.python.cp_model import CpModel, CpSolver
import random

class MazeSolver:
    def __init__(self, output_dir: str = "maze_visualizations"):
        self._image_counter = 0
        self._output_dir = output_dir
        if not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)
        self.visualizer = GraphVisualizer(output_dir=output_dir)
    
    async def solve_maze(self, data: dict, websocket: WebSocket = None):
        try:
            # Handle restructured data from frontend
            if 'largeComponents' not in data:
                # Check if this is the new structure with nested allConnComponents
                if 'allConnComponents' in data:
                    # Extract components from the nested structure
                    print("Received nested component structure, restructuring...")
                    components = []
                    for comp_data in data['allConnComponents']:
                        if 'adjacencyList' in comp_data:
                            components.append(comp_data['adjacencyList'])
                    
                    # Restructure data to expected format
                    data = {
                        'largeComponents': components,
                        'dimensions': data.get('dimensions', {})
                    }
                    print(f"Restructured data contains {len(components)} components")
                else:
                    raise ValueError("Missing 'largeComponents' in input data")
            
            if not data['largeComponents']:
                raise ValueError("No maze components provided.")
            
            # Extract dimensions if available
            dimensions = data.get('dimensions', {})
            rows = dimensions.get('rows')
            cols = dimensions.get('cols')
            print(f"Grid dimensions: {rows} rows x {cols} columns")
            
            # Standardize dimension keys for visualizer
            viz_dimensions = {
                'rows': rows,
                'cols': cols  # Visualizer expects 'cols' key instead of 'columns'
            }
            
            # Process each component based on size
            solutions = []
            visualizations = []
            
            # First, identify which components need Rust vs OR-Tools
            small_components = []
            small_indices = []
            large_components = []
            large_indices = []
            
            for i, component in enumerate(data['largeComponents']):
                # Count nodes in the component
                # Check if component is a dictionary before using keys
                if isinstance(component, dict):
                    node_count = len(component.keys())
                    
                    if node_count <= 200:  # Lowered threshold slightly for safety
                        small_components.append(component.copy())
                        small_indices.append(i)
                    else:
                        large_components.append(component.copy())
                        large_indices.append(i)
                else:
                    print(f"Warning: Component {i} is not a dictionary: {type(component)}")
                    # Handle list component case - convert to dict if possible
                    # For example, if the component is a list of connections
                    if isinstance(component, list):
                        # Attempt to convert list to adjacency dict format
                        adj_dict = {}
                        for item in component:
                            if isinstance(item, dict) and 'from' in item and 'to' in item:
                                from_node = str(item['from'])
                                to_node = str(item['to'])
                                
                                if from_node not in adj_dict:
                                    adj_dict[from_node] = []
                                if to_node not in adj_dict:
                                    adj_dict[to_node] = []
                                    
                                adj_dict[from_node].append(to_node)
                                adj_dict[to_node].append(from_node)
                        
                        # Add the converted component
                        if adj_dict:
                            node_count = len(adj_dict)
                            if node_count <= 250:
                                small_components.append(adj_dict)
                                small_indices.append(i)
                            else:
                                large_components.append(adj_dict)
                                large_indices.append(i)
            
            # Launch both solvers concurrently
            small_task = None
            large_task = None
            loop = asyncio.get_running_loop()
            
            # Create task for small components (Rust)
            if small_components:
                # Create a Rust-compatible data structure
                rust_data = {
                    'largeComponents': small_components
                }
                json_small_data = json.dumps(rust_data)
                
                # Launch Rust solver as async task
                small_task = asyncio.create_task(self._run_rust_solver(json_small_data, loop))
                print(f"Launched Rust solver for {len(small_components)} components")
            else:
                print("No small components for Rust solver")
                small_task = asyncio.create_task(asyncio.sleep(0))  # Dummy task
            
            # Create task for large components (OR-Tools)
            if large_components:
                # Launch OR-Tools solver as async task
                large_task = asyncio.create_task(self._run_ortools_solver(large_components, large_indices, dimensions))
                print(f"Launched OR-Tools solver for {len(large_components)} components")
            else:
                print("No large components for OR-Tools solver")
                large_task = asyncio.create_task(asyncio.sleep(0))  # Dummy task
            
            # Wait for both tasks to complete
            try:
                small_solutions, or_tools_solutions = await asyncio.gather(
                    small_task, large_task, 
                    return_exceptions=True  # Don't let one failure cancel the other task
                )
                
                # Handle possible exceptions from tasks
                if isinstance(small_solutions, Exception):
                    print(f"Rust solver failed: {small_solutions}")
                    small_solutions = [[] for _ in small_components]
                
                if isinstance(or_tools_solutions, Exception):
                    print(f"OR-Tools solver failed: {or_tools_solutions}")
                    or_tools_solutions = [[] for _ in large_components]
                
            except Exception as e:
                print(f"Error waiting for solvers: {e}")
                # Provide empty results if both failed
                small_solutions = [[] for _ in small_components]
                or_tools_solutions = [[] for _ in large_components]
            
            # Merge solutions from both solvers
            all_solutions = [None] * len(data['largeComponents'])
            
            # Insert small component solutions
            for idx, solution in zip(small_indices, small_solutions):
                if idx < len(all_solutions):
                    all_solutions[idx] = solution
            
            # Insert large component solutions
            for idx, solution in zip(large_indices, or_tools_solutions):
                if idx < len(all_solutions):
                    all_solutions[idx] = solution
            
            # If we processed all components with Rust (no large components),
            # ensure the solutions array is properly filled
            if not large_components and small_indices:
                print(f"All {len(small_indices)} components were processed by Rust")
                
                # If the array still has None values, the indices might be mismatched
                if None in all_solutions:
                    print("Warning: Some solutions are None, reconstructing array")
                    # Create a mapping of original indices to solutions
                    solution_map = {idx: sol for idx, sol in zip(small_indices, small_solutions)}
                    # Rebuild the all_solutions array
                    all_solutions = [solution_map.get(i, []) for i in range(len(data['largeComponents']))]
            
            # Ensure no null values in the array
            all_solutions = [solution if solution is not None else [] for solution in all_solutions]
            
            # Log solution summary
            solution_lengths = [len(sol) if sol else 0 for sol in all_solutions]
            print(f"Final solution lengths: {solution_lengths}")
            
            # Visualize solutions
            for i, solution in enumerate(all_solutions):
                if solution and len(solution) > 0:
                    # Extract the component adjacency dict
                    component = data['largeComponents'][i] if i < len(data['largeComponents']) else {}
                    if component:
                        # Use a basic dimensions dict if not provided
                        dimensions = data.get('dimensions', {'width': 800, 'height': 600})
                        self._verify_and_visualize(component, solution, i, i == 1, dimensions)
            
            # If websocket provided, send directly
            if websocket:
                try:
                    # Send the array directly, not wrapped in an object
                    await websocket.send_json(all_solutions)
                    print(f"Successfully sent solution to client")
                except Exception as ws_error:
                    print(f"Error sending via websocket: {ws_error}")
                    raise
            
            return all_solutions
            
        except Exception as e:
            error_message = f"An unexpected error occurred: {str(e)}"
            print(f"Solver error: {error_message}")
            if websocket:
                try:
                    await websocket.send_json({
                        "type": "internal_error",
                        "error": error_message
                    })
                except Exception as ws_close_error:
                    print(f"Failed to send error message: {ws_close_error}")
            raise
    
    async def _run_rust_solver(self, json_data, loop):
        """Run Rust solver asynchronously with timeout protection"""
        try:
            with concurrent.futures.ThreadPoolExecutor() as pool:
                return await asyncio.wait_for(
                    loop.run_in_executor(pool, lambda: process_and_solve_maze(json_data)),
                    timeout=360  # 6 minute timeout
                )
        except asyncio.TimeoutError:
            print("Timeout in Rust solver")
            raise
        except Exception as e:
            print(f"Error in Rust solver: {str(e)}")
            raise
    
    async def _run_ortools_solver(self, components, indices, dimensions):
        """Run OR-Tools solver asynchronously"""
        try:
            # Create a thread pool for parallel processing
            results = []
            with concurrent.futures.ThreadPoolExecutor() as executor:
                # Create futures for each component
                futures = []
                for idx, component in zip(indices, components):
                    futures.append(executor.submit(
                        self._solve_component, component, idx, dimensions
                    ))
                
                # Gather results as they complete
                for future in concurrent.futures.as_completed(futures):
                    try:
                        result = future.result()
                        results.append(result)
                    except Exception as e:
                        print(f"Error in OR-Tools component: {str(e)}")
                        results.append([])  # Add an empty path for this component
            
            return results
        except Exception as e:
            print(f"Error in OR-Tools solver: {str(e)}")
            raise
        # Replace your current _solve_component with this new implementation
    def _solve_component(self, adjacency_dict, component_idx, dimensions=None):
        """Solve a single component using multiple strategies to avoid local minima."""
        try:
            start_time = time.time()
            print(f"Solving component {component_idx} with {len(adjacency_dict)} nodes")
            
            # Try different solution strategies and return the best one
            solutions = []
            
            # 1. First try the rank-based approach for better global optimization
            rank_solution = self._solve_with_ranking(adjacency_dict, component_idx)
            if rank_solution:
                solutions.append(rank_solution)
                print(f"Rank-based solution found path of length {len(rank_solution)}")
            
            # 2. Also try the previous edge-based approach as a fallback
            if time.time() - start_time < 40:  # If we have time left
                edge_solution = self._solve_with_edge_model(adjacency_dict, component_idx)
                if edge_solution:
                    solutions.append(edge_solution)
                    print(f"Edge-based solution found path of length {len(edge_solution)}")
            
            # 3. If we have time, also try beam search to complement other approaches
            if time.time() - start_time < 45:  # Leave at least 15s for beam search
                beam_solution = self._beam_search_longest_path(adjacency_dict)
                if beam_solution:
                    solutions.append(beam_solution)
                    print(f"Beam search solution found path of length {len(beam_solution)}")
            
            # Return the best solution
            if not solutions:
                print(f"No solution found for component {component_idx}")
                return []
                
            best_solution = max(solutions, key=len)
            print(f"Component {component_idx}: Best solution has length {len(best_solution)}")
            
            # Validate the final solution
            self._validate_path(adjacency_dict, best_solution, component_idx)
            
            return best_solution
            
        except Exception as e:
            print(f"Error solving component {component_idx}: {str(e)}")
            import traceback
            traceback.print_exc()
            return []
    
    def _solve_with_edge_model(self, adjacency_dict, component_idx):
        """Legacy edge-based approach, kept as a fallback."""
        try:
            start_time = time.time()
            
            # Convert adjacency dict to a flat list of edges for CP-SAT
            edges = []
            node_to_index = {}
            
            # Assign each node a numeric index
            for i, node in enumerate(adjacency_dict.keys()):
                node_to_index[node] = i
            
            # Add edges (ensuring all vertices have an index)
            for node, neighbors in adjacency_dict.items():
                for neighbor in neighbors:
                    if neighbor in node_to_index:
                        edges.append((node_to_index[node], node_to_index[neighbor]))
            
            # Create the solver
            model = CpModel()
            
            # Variables: for each edge, whether it's in the path
            edge_vars = {}
            for i, edge in enumerate(edges):
                edge_vars[i] = model.NewBoolVar(f'edge_{i}')
            
            # Variables: for each vertex, whether it's in the path
            vertex_vars = {}
            for node in node_to_index:
                vertex_idx = node_to_index[node]
                vertex_vars[vertex_idx] = model.NewBoolVar(f'vertex_{vertex_idx}')
            
            # For each vertex, either 0, 1, or 2 incident edges must be used
            # (0 = not in path, 2 = in middle of path, 1 = endpoint)
            for node in node_to_index:
                node_idx = node_to_index[node]
                # Get all edges incident to this vertex
                incident_edges = []
                for i, (u, v) in enumerate(edges):
                    if u == node_idx or v == node_idx:
                        incident_edges.append(edge_vars[i])
                
                # If vertex is used, it must have 1 or 2 incident edges
                if incident_edges:
                    model.Add(sum(incident_edges) <= 2)
                    # Connect vertex_var with incident edges
                    model.Add(sum(incident_edges) >= vertex_vars[node_idx])
                    model.Add(sum(incident_edges) <= 2 * vertex_vars[node_idx])
                else:
                    # Isolated vertex can't be in path
                    model.Add(vertex_vars[node_idx] == 0)
            
            # Objective: maximize total vertices in path
            model.Maximize(sum(vertex_vars.values()))
            
            # Add randomization to avoid local minima
            solver = CpSolver()
            solver.parameters.max_time_in_seconds = 30.0  # 30 second timeout
            solver.parameters.randomize_search = True
            solver.parameters.random_seed = int(time.time() * 1000) % 10000
            
            status = solver.Solve(model)
            
            # Process results
            if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
                # Find the endpoints (vertices with exactly one incident edge)
                endpoints = []
                for node in node_to_index:
                    node_idx = node_to_index[node]
                    if solver.Value(vertex_vars[node_idx]) == 1:
                        # Count incident edges that are in the solution
                        incident_count = 0
                        for i, (u, v) in enumerate(edges):
                            if (u == node_idx or v == node_idx) and solver.Value(edge_vars[i]) == 1:
                                incident_count += 1
                        
                        if incident_count == 1:
                            endpoints.append(node_idx)
                
                # Reconstruct the path from one endpoint to the other
                path = []
                if len(endpoints) == 2:
                    # Start with one endpoint
                    current = endpoints[0]
                    path.append(current)
                    visited = set([current])
                    
                    # Keep adding vertices until we reach the other endpoint
                    while current != endpoints[1]:
                        found_next = False
                        for i, (u, v) in enumerate(edges):
                            if solver.Value(edge_vars[i]) == 1:
                                if u == current and v not in visited:
                                    current = v
                                    path.append(current)
                                    visited.add(current)
                                    found_next = True
                                    break
                                elif v == current and u not in visited:
                                    current = u
                                    path.append(current)
                                    visited.add(current)
                                    found_next = True
                                    break
                        
                        if not found_next:
                            # We hit a dead end - this shouldn't happen with valid solutions
                            print("Error in path reconstruction: hit dead end")
                            break
                
                # Convert back to original node IDs
                index_to_node = {idx: node for node, idx in node_to_index.items()}
                path_with_node_ids = [index_to_node[idx] for idx in path]
                
                # If path is valid, return it
                if self._validate_path(adjacency_dict, path_with_node_ids, component_idx):
                    elapsed = time.time() - start_time
                    print(f"Edge model for component {component_idx}: Found path of length {len(path_with_node_ids)} in {elapsed:.2f}s")
                    return path_with_node_ids
                else:
                    return []
            else:
                print(f"Component {component_idx}: Edge model found no solution")
                return []
        except Exception as e:
            print(f"Error in edge-based solver: {str(e)}")
            import traceback
            traceback.print_exc()
            return []
    
    def _solve_with_ranking(self, adjacency_dict, component_idx):
        """Use a rank-based CP-SAT formulation to find the longest path."""
        try:
            start_time = time.time()
            
            # Convert adjacency dict to a graph representation
            G = nx.Graph()
            for node, neighbors in adjacency_dict.items():
                for neighbor in neighbors:
                    G.add_edge(node, neighbor)
            
            # Mapping between nodes and indices
            nodes = list(adjacency_dict.keys())
            node_to_idx = {node: i for i, node in enumerate(nodes)}
            idx_to_node = {i: node for node, i in node_to_idx.items()}
            
            # Create the model
            model = CpModel()
            
            # 1. Variables for each node:
            # - in_path[i] = whether node i is in the path
            # - rank[i] = position of node i in the path (or -1 if not in path)
            in_path = {}
            rank = {}
            num_nodes = len(nodes)
            
            for i, node in enumerate(nodes):
                in_path[i] = model.NewBoolVar(f'in_path_{i}')
                # Rank goes from 0 to num_nodes-1 (or -1 if not in path)
                rank[i] = model.NewIntVar(-1, num_nodes-1, f'rank_{i}')
                
                # Connect in_path and rank variables
                model.Add(rank[i] >= 0).OnlyEnforceIf(in_path[i])
                model.Add(rank[i] == -1).OnlyEnforceIf(in_path[i].Not())
            
            # 2. Path consistency constraints:
            # - Each rank 0 to path_length-1 appears exactly once
            # - Nodes with consecutive ranks must be connected in the graph
            # - No gaps in ranks
            
            # Each rank can be assigned to at most one node
            for r in range(num_nodes):
                rank_indicators = []
                for i in range(num_nodes):
                    has_rank_r = model.NewBoolVar(f'node_{i}_has_rank_{r}')
                    model.Add(rank[i] == r).OnlyEnforceIf(has_rank_r)
                    model.Add(rank[i] != r).OnlyEnforceIf(has_rank_r.Not())
                    rank_indicators.append(has_rank_r)
                model.Add(sum(rank_indicators) <= 1)
            
            # We must have rank 0 if any node is in the path
            rank0_indicators = []
            for i in range(num_nodes):
                has_rank_0 = model.NewBoolVar(f'node_{i}_has_rank_0')
                model.Add(rank[i] == 0).OnlyEnforceIf(has_rank_0)
                model.Add(rank[i] != 0).OnlyEnforceIf(has_rank_0.Not())
                rank0_indicators.append(has_rank_0)
            
            path_exists = model.NewBoolVar('path_exists')
            model.Add(sum(in_path.values()) >= 1).OnlyEnforceIf(path_exists)
            model.Add(sum(in_path.values()) == 0).OnlyEnforceIf(path_exists.Not())
            model.Add(sum(rank0_indicators) == 1).OnlyEnforceIf(path_exists)
            
            # No gaps in ranks
            for r in range(1, num_nodes):
                # If rank r is used, rank r-1 must also be used
                has_rank_r = []
                for i in range(num_nodes):
                    indicator = model.NewBoolVar(f'node_{i}_has_rank_{r}')
                    model.Add(rank[i] == r).OnlyEnforceIf(indicator)
                    model.Add(rank[i] != r).OnlyEnforceIf(indicator.Not())
                    has_rank_r.append(indicator)
                
                has_rank_prev = []
                for i in range(num_nodes):
                    indicator = model.NewBoolVar(f'node_{i}_has_rank_{r-1}')
                    model.Add(rank[i] == r-1).OnlyEnforceIf(indicator)
                    model.Add(rank[i] != r-1).OnlyEnforceIf(indicator.Not())
                    has_rank_prev.append(indicator)
                
                rank_r_exists = model.NewBoolVar(f'rank_{r}_exists')
                model.Add(sum(has_rank_r) >= 1).OnlyEnforceIf(rank_r_exists)
                model.Add(sum(has_rank_r) == 0).OnlyEnforceIf(rank_r_exists.Not())
                
                # If rank r exists, rank r-1 must exist
                model.Add(sum(has_rank_prev) >= 1).OnlyEnforceIf(rank_r_exists)
            
            # 3. Consecutive ranks must be connected in the graph
            adjacency_matrix = {}
            for node, neighbors in adjacency_dict.items():
                i = node_to_idx[node]
                for neighbor in neighbors:
                    if neighbor in node_to_idx:  # Ensure the neighbor is valid
                        j = node_to_idx[neighbor]
                        adjacency_matrix[(i, j)] = True
                        adjacency_matrix[(j, i)] = True
            
            for i in range(num_nodes):
                for j in range(num_nodes):
                    if i != j:
                        i_then_j = model.NewBoolVar(f'consecutive_{i}_then_{j}')
                        
                        # For all possible ranks r, if i has rank r and j has rank r+1,
                        # then i_then_j must be true
                        for r in range(num_nodes - 1):
                            i_has_r = model.NewBoolVar('')
                            j_has_r_plus_1 = model.NewBoolVar('')
                            
                            model.Add(rank[i] == r).OnlyEnforceIf(i_has_r)
                            model.Add(rank[i] != r).OnlyEnforceIf(i_has_r.Not())
                            
                            model.Add(rank[j] == r + 1).OnlyEnforceIf(j_has_r_plus_1)
                            model.Add(rank[j] != r + 1).OnlyEnforceIf(j_has_r_plus_1.Not())
                            
                            both_consecutive = model.NewBoolVar('')
                            model.AddBoolAnd([i_has_r, j_has_r_plus_1]).OnlyEnforceIf(both_consecutive)
                            model.AddBoolOr([i_has_r.Not(), j_has_r_plus_1.Not()]).OnlyEnforceIf(both_consecutive.Not())
                            
                            # If both_consecutive is true, then i_then_j must be true
                            model.AddImplication(both_consecutive, i_then_j)
                        
                        # If i_then_j is true, then there must be an edge between i and j
                        if (i, j) not in adjacency_matrix:
                            model.Add(i_then_j == 0)
            
            # 4. Objective: maximize the number of nodes in the path
            model.Maximize(sum(in_path.values()))
            
            # 5. Solve with randomization to avoid local minima
            solver = CpSolver()
            solver.parameters.max_time_in_seconds = 40.0  # 40 second timeout
            
            # Use randomization to explore different areas of the solution space
            solver.parameters.randomize_search = True
            solver.parameters.random_seed = int(time.time() * 1000) % 10000
            
            # Enable multiple workers for better exploration
            solver.parameters.num_search_workers = min(8, os.cpu_count() or 4)
            solver.parameters.log_search_progress = False
            
            status = solver.Solve(model)
            
            if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
                # Construct the path from rank values
                path_with_rank = []
                for i, node in enumerate(nodes):
                    node_rank = solver.Value(rank[i])
                    if node_rank >= 0:  # Node is in the path
                        path_with_rank.append((idx_to_node[i], node_rank))
                
                # Sort by rank to get the path in correct order
                path_with_rank.sort(key=lambda x: x[1])
                path = [node for node, _ in path_with_rank]
                
                # Validate path connectivity
                if self._validate_path(adjacency_dict, path, component_idx):
                    elapsed = time.time() - start_time
                    print(f"Rank model for component {component_idx}: Found path of length {len(path)} in {elapsed:.2f}s")
                    return path
                else:
                    return []
            else:
                print(f"Component {component_idx}: Rank model could not find a solution")
                return []
                
        except Exception as e:
            print(f"Error in rank-based solver: {str(e)}")
            import traceback
            traceback.print_exc()
            return []
        
    def _beam_search_longest_path(self, adjacency_dict, beam_width=100, max_iterations=1000):
        """Find longest path using beam search with multiple starting nodes."""
        try:
            # Convert dictionary to a graph
            G = nx.Graph()
            for node, neighbors in adjacency_dict.items():
                for neighbor in neighbors:
                    G.add_edge(node, neighbor)
            
            nodes = list(adjacency_dict.keys())
            if not nodes:
                return []
            
            best_path = []
            
            # Choose starting nodes based on graph structure
            # Prefer nodes with degree 1 or 2 as they're likely endpoints
            degree_1_nodes = [n for n in nodes if len(adjacency_dict.get(n, [])) == 1]
            degree_2_nodes = [n for n in nodes if len(adjacency_dict.get(n, [])) == 2]
            
            # Include some random nodes for diversity
            random_nodes = random.sample(nodes, min(10, len(nodes)))
            
            # Combine potential starting nodes, prioritizing degree 1 nodes
            start_nodes = degree_1_nodes + degree_2_nodes + random_nodes
            
            # Remove duplicates while preserving order
            seen = set()
            start_nodes = [n for n in start_nodes if not (n in seen or seen.add(n))]
            
            # Limit number of starting nodes to avoid excessive computation
            start_nodes = start_nodes[:min(15, len(start_nodes))]
            
            # If no good candidates, just use a few random nodes
            if not start_nodes:
                start_nodes = random.sample(nodes, min(5, len(nodes)))
            
            print(f"Beam search using {len(start_nodes)} starting nodes")
            
            for start_node in start_nodes:
                # Initialize beam with paths containing only the start node
                beam = [[start_node]]
                
                for _ in range(min(max_iterations, len(G) * 2)):
                    candidates = []
                    
                    # Expand each path in the beam
                    for path in beam:
                        last_node = path[-1]
                        
                        # Try to extend the path with neighbors
                        for neighbor in G.neighbors(last_node):
                            if neighbor not in path:
                                new_path = path + [neighbor]
                                candidates.append(new_path)
                    
                    # If no candidates, we can't extend paths further
                    if not candidates:
                        break
                    
                    # Select top-k candidates based on length
                    beam = sorted(candidates, key=len, reverse=True)[:beam_width]
                    
                    # Update best path
                    if beam and len(beam[0]) > len(best_path):
                        best_path = beam[0]
                    
                    # If we've covered most of the graph, we're likely done
                    if best_path and len(best_path) > len(G) * 0.9:
                        break
            
            return best_path
            
        except Exception as e:
            print(f"Error in beam search: {str(e)}")
            return []

    
    def _visualize_path(self, adjacency_dict: Dict[str, List[str]], path: List[str], component_idx: int, dimensions: Dict[str, int]) -> None:
        """Visualize the graph and path using the GraphVisualizer."""
        try:
            if not path:
                return
            
            # Use our GraphVisualizer for visualization
            self._image_counter += 1
            
            # Generate both regular graph and hexagonal visualizations
            self.visualizer.visualize_graph(
                dimensions,
                path,
                title=f"Component {component_idx}",
                filename_prefix=f"component_{component_idx}_{self._image_counter}"
            )
            
            self.visualizer.visualize_hexagonal_tiling(
                dimensions,
                adjacency_dict,
                path,
                title=f"Component {component_idx} Hex Tiling",
                filename_prefix=f"hex_component_{component_idx}_{self._image_counter}"
            )
            
        except Exception as e:
            print(f"Visualization error: {str(e)}")
            
    def analyze_clockwise_ordering(self, adjacency_list, node_id: str) -> None:
        """Analyze and visualize the clockwise ordering of neighbors around a node."""
        try:
            # Check that adjacency_list is a dictionary
            if not isinstance(adjacency_list, dict):
                print(f"Cannot analyze clockwise ordering: adjacency_list is a {type(adjacency_list)}, not a dictionary")
                return
                
            # Check that node_id exists in the adjacency list
            if node_id not in adjacency_list:
                print(f"Cannot analyze clockwise ordering: node {node_id} not found in adjacency list")
                return
                
            self.visualizer.visualize_clockwise_ordering(
                adjacency_list,
                node_id,
                title=f"Clockwise Ordering - Node {node_id}",
                filename_prefix="clockwise"
            )
        except Exception as e:
            print(f"Clockwise ordering visualization error: {str(e)}")
    
    def _verify_and_visualize(self, adjacency_dict: Dict[str, List[str]], 
                              path: List[str], component_idx: int, check_longest: bool, dimensions: Dict[str, int]) -> tuple[str, bool]:
        """Verify solution and visualize, performing longest path check only for the second largest component."""
        try:
            if not adjacency_dict:
                return "Empty adjacency list", False
            
            if not path:
                return "Empty path", False
            
            # Build graph once
            G = nx.Graph(adjacency_dict)
            
            # Verify solution
            result, valid = self._verify_solution(G, path, adjacency_dict, check_longest)
            
            # Always visualize even if the solution is suboptimal
            self._visualize_path(adjacency_dict, path, component_idx, dimensions)
            
            return result, valid
        except Exception as e:
            return f"Verification error: {str(e)}", False
    
    def _verify_solution(self, G: nx.Graph, path: List[str], adjacency_dict: Dict[str, List[str]], check_longest: bool) -> tuple[str, bool]:
        """Optimized verification, longest path validation only for second largest component."""
        try:
            path_set = set(path)
            if len(path) != len(path_set):
                return "Duplicate node in path", False
            
            # Path connectedness check
            if any((path[i], path[i+1]) not in G.edges and (path[i+1], path[i]) not in G.edges for i in range(len(path) - 1)):
                return "Path is not connected", False
            
            # Longest path validation only for the second largest component
            if check_longest:
                non_path_nodes = set(G.nodes) - path_set
                for node in non_path_nodes:
                    neighbors = set(adjacency_dict.get(node, []))
                    path_neighbors = list(neighbors & path_set)
                    if len(path_neighbors) > 1:
                        found_count = 0
                        for i, step in enumerate(path[:-1]):
                            if step in path_neighbors:
                                if path[i+1] in path_neighbors:
                                    found_count += 1
                                    if found_count >= len(path_neighbors) - 1:
                                        return "Suboptimal longest path", False
            
            return "Valid", True
        except Exception as e:
            return f"Solution verification error: {str(e)}", False