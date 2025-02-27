import networkx as nx
from typing import List, Dict
from fastapi import WebSocket
from maze_solver import process_and_solve_maze
import matplotlib.pyplot as plt
from joblib import Parallel, delayed
from datetime import datetime
from backend.models import (
    LargeMazeData,
    SolutionResponse,
    ErrorResponse
)

class MazeSolver:
    def __init__(self):
        self._image_counter = 0
    
    async def solve_maze(self, data: LargeMazeData, websocket: WebSocket):
        try:
            if not data.largeComponents:
                raise ValueError("No maze components provided.")
            
            # Process everything in Rust (single call)
            solutions = process_and_solve_maze(data)
            
            # Compute verification priority (sort components by size)
            sorted_components = sorted(
                enumerate(data.largeComponents), 
                key=lambda x: len(x[1].adjacency_list),
                reverse=True
            )
            
            # Identify the second largest component for longest path validation
            second_largest_idx = sorted_components[1][0] if len(sorted_components) > 1 else -1
            
            # Verify and visualize in parallel
            results = Parallel(n_jobs=-1)(
                delayed(self._verify_and_visualize)(
                    component.adjacency_list, solutions[idx], idx, idx == second_largest_idx
                )
                for i, (idx, component) in enumerate(sorted_components)
            )
            
            # Log verification failures but do not stop execution
            errors = []
            for i, (errMsg, is_valid) in enumerate(results):
                if not is_valid:
                    errors.append(f"Solution {i} is invalid: {errMsg}")
            
            # Send the complete solution
            await websocket.send_json(
                SolutionResponse(
                    type="solution", 
                    data=solutions
                ).model_dump()
            )
            
            # Send errors separately if any
            if errors:
                await websocket.send_json(
                    ErrorResponse(
                        type="validation_warning",
                        error="; ".join(errors)
                    ).model_dump()
                )
        except Exception as e:
            await websocket.send_json(
                ErrorResponse(
                    type="internal_error",
                    error=f"An unexpected error occurred: {str(e)}"
                ).model_dump()
            )
    
    def _verify_and_visualize(self, adjacency_dict: Dict[str, List[str]], 
                              path: List[str], component_idx: int, check_longest: bool) -> tuple[str, bool]:
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
            self._visualize_path(G, path, component_idx)
            
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
            if any((path[i], path[i+1]) not in G.edges for i in range(len(path) - 1)):
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
    
    def _visualize_path(self, G: nx.Graph, path: List[str], component_idx: int) -> None:
        """Optimized visualization using a planar layout."""
        try:
            if not path:
                return
            
            # Use planar layout for better representation
            pos = nx.planar_layout(G) if nx.check_planarity(G)[0] else nx.kamada_kawai_layout(G)
            
            plt.figure(figsize=(10, 10), dpi=100)
            nx.draw(G, pos, with_labels=(len(G) < 300), node_size=300, node_color="lightblue", edge_color="gray", width=0.5)
            
            # Draw path with strong contrast
            path_edges = list(zip(path[:-1], path[1:]))
            nx.draw_networkx_edges(G, pos, edgelist=path_edges, edge_color="red", width=2.0)
            
            # Highlight start and end nodes
            nx.draw_networkx_nodes(G, pos, nodelist=[path[0], path[-1]], node_color=["green", "yellow"], node_size=500)
            
            # Save visualization with timestamp
            self._image_counter += 1
            timestamp = datetime.now().strftime("%b-%d_%H-%M-%S")
            filename = f"maze_solution_{component_idx}_{self._image_counter}_{timestamp}.png"
            plt.title(f"Component {component_idx} - Path Length: {len(path)}")
            plt.savefig(filename)
            plt.close('all')
        except Exception as e:
            print(f"Visualization error: {str(e)}")
