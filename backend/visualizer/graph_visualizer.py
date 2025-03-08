import networkx as nx
import matplotlib.pyplot as plt
import numpy as np
from typing import Dict, List, Tuple, Optional, Set
from datetime import datetime
import os
import math
from matplotlib.colors import LinearSegmentedColormap

export = True

class GraphVisualizer:
    """
    Visualizes graphs and paths through them, with support for hexagonal grid layouts.
    Uses pointy-top hexagon orientation.
    """
    
    def __init__(self, output_dir: str = "visualizations"):
        self.output_dir = output_dir
        if not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)
        
        # Gradient colormap for paths
        self.path_cmap = LinearSegmentedColormap.from_list(
            "path_colors", ["#ff4500", "#ff8c00", "#ffd700", "#9acd32", "#32cd32"]
        )
    
    def create_nx_graph(self, adjacency_dict: Dict[str, List[str]]) -> nx.Graph:
        """Create a NetworkX graph from an adjacency dictionary."""
        G = nx.Graph()
        
        # Handle case where adjacency_dict is actually a list
        if isinstance(adjacency_dict, list):
            print("Warning: Received list instead of adjacency dictionary, attempting to convert")
            try:
                # Try to convert a path list to a minimal adjacency dict
                converted_dict = {}
                for i in range(len(adjacency_dict) - 1):
                    from_node = str(adjacency_dict[i])
                    to_node = str(adjacency_dict[i + 1])
                    
                    if from_node not in converted_dict:
                        converted_dict[from_node] = []
                    if to_node not in converted_dict:
                        converted_dict[to_node] = []
                    
                    converted_dict[from_node].append(to_node)
                    converted_dict[to_node].append(from_node)
                
                adjacency_dict = converted_dict
            except Exception as e:
                print(f"Failed to convert list to adjacency dict: {e}")
                # Create an empty graph as fallback
                return G
        
        # Add nodes and edges
        for node_id, neighbors in adjacency_dict.items():
            G.add_node(node_id)
            for neighbor in neighbors:
                G.add_edge(node_id, neighbor)
                
        return G
    
    def hex_grid_layout(self, G: nx.Graph, dimensions: Dict[str, int]) -> Dict[str, np.ndarray]:
        """
        Generate a pointy-top hexagonal grid layout based on node IDs.
        Assumes 1-indexed node IDs starting from top-left, going row by row.
        """
        positions = {}
        nodes = list(G.nodes())
        
        # If rows and cols not provided, estimate them
        ncols = dimensions['cols']
        
        # Try to interpret node IDs as integers
        try:
            node_ids = [int(node) for node in nodes]
            
            # For each node ID, calculate its position based on 1-indexed grid coordinates
            for node_id in node_ids:
                # Convert 1-indexed node ID to 0-indexed position
                pos = node_id - 1
                
                # Calculate row and column (0-indexed)
                row = pos // ncols
                col = (pos % ncols) 
                
                # Apply hexagonal layout coordinates
                # For pointy-top hexagons:
                x = col * 0.75
                y = row + (0.5 if (col % 2 == 1) else 0)

                positions[str(node_id)] = np.array([x, y])
                
        except ValueError:
            # Fall back to spring layout if nodes aren't integers
            print("Warning: Could not interpret node IDs as integers. Using spring layout.")
            positions = nx.spring_layout(G, seed=42)
        
        return positions
    
    def maintain_clockwise_order(self, G: nx.Graph, adjacency_dict: Dict[str, List[str]]) -> nx.Graph:
        """Ensure the graph maintains the clockwise ordering of neighbors."""
        # This function preserves the neighbor ordering from your adjacency dict
        for node, neighbors in adjacency_dict.items():
            if node in G:
                # Store the clockwise ordering as a node attribute
                G.nodes[node]['clockwise_neighbors'] = neighbors
        return G
    
    def visualize_graph(self, 
                        dimensions: Dict[str, int],
                        adjacency_dict: Dict[str, List[str]], 
                        path: Optional[List[str]] = None,
                        title: str = "Graph Visualization",
                        filename_prefix: str = "graph",
                        show_labels: bool = True,
                        figsize: Tuple[int, int] = (12, 10),
                        show: bool = False) -> str:
        """
        Visualize a graph and optionally a path through it.
        Saves to a file without displaying unless show=True.
        """
        # Create graph and determine layout
        G = self.create_nx_graph(adjacency_dict)
        G = self.maintain_clockwise_order(G, adjacency_dict)
        
        # Use hexagonal layout
        pos = self.hex_grid_layout(G, dimensions)
        
        # For very large graphs, fall back to planar or force-directed layout
        if len(pos) == 0 or len(G) > 1000:
            if nx.check_planarity(G)[0]:
                pos = nx.planar_layout(G)
            else:
                print("Warning: Graph is not planar. Using Kamada-Kawai layout.")
                pos = nx.kamada_kawai_layout(G)
        
        # Create figure (will be closed without displaying when show=False)
        plt.figure(figsize=figsize)
        
        # Adjust display parameters based on graph size
        node_size = 300
        edge_width = 1.3
        
        if len(G) > 200:
            show_labels = False
            node_size = 100
        
        # Draw the basic graph
        nx.draw_networkx_edges(G, pos, width=edge_width, alpha=0.8, edge_color="gray")
        nx.draw_networkx_nodes(G, pos, node_size=node_size, node_color="lightblue", alpha=0.7)
        
        if show_labels:
            nx.draw_networkx_labels(G, pos, font_size=8, font_family="sans-serif")
        
        # Draw the path if provided
        if path and len(path) > 1:
            path_edges = list(zip(path[:-1], path[1:]))
            
            # Create gradient colors for the path
            path_colors = [self.path_cmap(i/len(path_edges)) for i in range(len(path_edges))]
            
            # Draw path edges with gradient colors
            nx.draw_networkx_edges(
                G, pos, 
                edgelist=path_edges, 
                width=edge_width*2.5, 
                alpha=0.8,
                edge_color=path_colors
            )
            
            # Highlight start and end nodes
            nx.draw_networkx_nodes(
                G, pos,
                nodelist=[path[0]],
                node_size=node_size*1.5,
                node_color="green",
                alpha=1.0
            )
            nx.draw_networkx_nodes(
                G, pos,
                nodelist=[path[-1]],
                node_size=node_size*1.5,
                node_color="red",
                alpha=1.0
            )
            
            # Highlight intermediate path nodes
            if len(path) > 2:
                nx.draw_networkx_nodes(
                    G, pos, 
                    nodelist=path[1:-1], 
                    node_size=node_size*1.2, 
                    node_color="orange",
                    alpha=0.9
                )
        
        # Add title and adjust layout
        plt.title(f"{title} - {len(G)} nodes, {len(path) if path else 0} in path")
        plt.axis("off")
        plt.tight_layout()
        
        # Save the figure
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"{filename_prefix}_{timestamp}.png"
        filepath = os.path.join(self.output_dir, filename)
        plt.savefig(filepath)
        
        # Always close the figure to prevent display and free memory
        plt.close()
        
        # Return the file path so the caller knows where it was saved
        return filepath
    
    def visualize_hexagonal_tiling(self, 
                                  dimensions: Dict[str, int],
                                  adjacency_dict: Dict[str, List[str]], 
                                  path: Optional[List[str]] = None,
                                  title: str = "Hexagonal Tiling",
                                  filename_prefix: str = "hex_tiling",
                                  show: bool = False) -> str:
        """
        Visualize the graph as explicit pointy-top hexagons to better represent the tiling.
        """
        G = self.create_nx_graph(adjacency_dict)
            
        pos = self.hex_grid_layout(G, dimensions)
        
        # Create figure
        plt.figure(figsize=(12, 10))
        ax = plt.gca()
        
        # Calculate hexagon size based on spacing
        if pos:
            # Find minimum distance between neighboring nodes
            min_dist = float('inf')
            for node in G.nodes():
                for neighbor in G.neighbors(node):
                    if node in pos and neighbor in pos:
                        dist = np.linalg.norm(np.array(pos[node]) - np.array(pos[neighbor]))
                        min_dist = min(min_dist, dist)
            
            # Use a reasonable hexagon size relative to node spacing
            hex_size = min_dist / 2 if min_dist < float('inf') else 0.4
        else:
            hex_size = 0.4
        
        # Draw hexagons
        for node in G.nodes():
            if node not in pos:
                continue
                
            x, y = pos[node]
            color = "lightblue"
            
            # Use path coloring if node is in path
            if path and node in path:
                idx = path.index(node)
                if idx == 0:
                    color = "green"
                elif idx == len(path) - 1:
                    color = "red"
                else:
                    path_pos = idx / len(path)
                    color = self.path_cmap(path_pos)
            
            # Create pointy-top hexagon shape
            # Start at top point (0 degrees) and move clockwise
            angles = np.pi/2 + np.linspace(0, 2*np.pi, 7)[:-1]  # 6 points, rotated for pointy-top
            hex_x = x + hex_size * np.cos(angles)
            hex_y = y + hex_size * np.sin(angles)
            hex_points = list(zip(hex_x, hex_y))
            
            # Draw the hexagon
            ax.add_patch(plt.Polygon(hex_points, color=color, alpha=0.8))
            
            # Add node label
            if len(G) < 100:
                plt.text(x, y, node, ha='center', va='center', fontsize=8)
        
        # Draw edges between hexagons
        for edge in G.edges():
            n1, n2 = edge
            if n1 not in pos or n2 not in pos:
                continue
                
            x1, y1 = pos[n1]
            x2, y2 = pos[n2]
            
            # Check if edge is part of path
            edge_color = "gray"
            edge_width = 1.0
            alpha = 0.5
            
            if path and len(path) > 1:
                for i in range(len(path)-1):
                    if (path[i] == n1 and path[i+1] == n2) or (path[i] == n2 and path[i+1] == n1):
                        edge_color = self.path_cmap(i/(len(path)-1))
                        edge_width = 2.5
                        alpha = 1.0
                        break
            
            plt.plot([x1, x2], [y1, y2], color=edge_color, linewidth=edge_width, alpha=alpha)
        
        # Set axis limits with some padding
        x_coords = [p[0] for p in pos.values()]
        y_coords = [p[1] for p in pos.values()]
        margin = hex_size * 1.5
        plt.xlim(min(x_coords) - margin, max(x_coords) + margin)
        plt.ylim(min(y_coords) - margin, max(y_coords) + margin)
        
        plt.title(title)
        plt.axis("equal")
        plt.axis("off")
        plt.tight_layout()
        
        # Save figure
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"{filename_prefix}_{timestamp}.png"
        filepath = os.path.join(self.output_dir, filename)
        plt.savefig(filepath)
        
        if show:
            plt.show()
        else:
            plt.close()
        
        return filepath
    
    def visualize_clockwise_ordering(self,
                                    adjacency_list: Dict[str, List[str]],
                                    node_id: str,
                                    title: str = "Clockwise Ordering",
                                    filename_prefix: str = "clockwise",
                                    show: bool = False) -> str:
        """
        Visualize the clockwise ordering of neighbors around a specific node.
        """
        if node_id not in adjacency_list:
            print(f"Node {node_id} not found in adjacency list")
            return ""
            
        neighbors = adjacency_list[node_id]
        if not neighbors:
            print(f"Node {node_id} has no neighbors")
            return ""
        
        # Create figure with two subplots
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))
        
        # Left plot: visual representation
        G = nx.Graph()
        G.add_node(node_id)
        for neighbor in neighbors:
            G.add_node(neighbor)
            G.add_edge(node_id, neighbor)
        
        # Position the central node at origin
        pos = {node_id: np.array([0, 0])}
        
        # Position neighbors in a hexagon around central node
        num_neighbors = len(neighbors)
        for i, neighbor in enumerate(neighbors):
            # Start from top (π/2) and go clockwise
            angle = np.pi/2 - 2 * np.pi * i / max(1, num_neighbors)
            x = np.cos(angle)
            y = np.sin(angle)
            pos[neighbor] = np.array([x, y])
        
        # Draw the central node
        nx.draw_networkx_nodes(G, pos, ax=ax1, nodelist=[node_id], 
                            node_color="red", node_size=500)
        
        # Draw neighbors with color gradient to show order
        colors = plt.cm.hsv(np.linspace(0, 1, num_neighbors))
        nx.draw_networkx_nodes(G, pos, ax=ax1, nodelist=neighbors, 
                            node_color=colors, node_size=300)
        
        # Draw edges
        nx.draw_networkx_edges(G, pos, ax=ax1, width=1.5)
        
        # Add node labels
        nx.draw_networkx_labels(G, pos, ax=ax1)
        
        # Add order numbers to show clockwise ordering
        for i, neighbor in enumerate(neighbors):
            x, y = pos[neighbor]
            ax1.text(x*1.2, y*1.2, f"{i+1}", fontsize=12, 
                    bbox=dict(facecolor='white', alpha=0.7))
        
        ax1.set_title("Neighbor Ordering")
        ax1.axis('equal')
        ax1.axis('off')
        
        # Right plot: table view
        ax2.axis('off')
        table_data = [[f"#{i+1}", neighbor] for i, neighbor in enumerate(neighbors)]
        table = ax2.table(
            cellText=table_data,
            colLabels=["Order", "Node ID"],
            loc='center',
            cellLoc='center'
        )
        table.auto_set_font_size(False)
        table.set_fontsize(10)
        table.scale(1.2, 1.5)
        ax2.set_title("Clockwise Sequence")
        
        plt.suptitle(f"Clockwise Neighbors of Node {node_id}", fontsize=16)
        plt.tight_layout()
        
        # Save figure
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"{filename_prefix}_{node_id}_{timestamp}.png"
        filepath = os.path.join(self.output_dir, filename)
        plt.savefig(filepath)
        
        if show:
            plt.show()
        else:
            plt.close()
        
        return filepath
    
    def visualize_multiple_paths(self,
                                dimensions: Dict[str, int],
                                adjacency_dict: Dict[str, List[str]],
                                paths: List[List[str]],
                                title: str = "Multiple Paths Comparison",
                                filename_prefix: str = "comparison",
                                show: bool = False,
                                ) -> str:
        """
        Visualize multiple paths on the same graph for comparison.
        """
        if not paths:
            return ""
            
        # Create graph
        G = self.create_nx_graph(adjacency_dict)
    
        
        # Get positions
        pos = self.hex_grid_layout(G, dimensions)
        
        # Create figure
        plt.figure(figsize=(12, 10), dpi=100)
        
        # Draw the base graph
        nx.draw(G, pos, with_labels=True, node_size=200, 
                node_color="lightgray", edge_color="lightgray", width=0.5, alpha=0.5)
        
        # Draw each path with a different color
        colors = plt.cm.tab10(np.linspace(0, 1, len(paths)))
        
        for i, path in enumerate(paths):
            if len(path) > 1:
                path_edges = list(zip(path[:-1], path[1:]))
                color = colors[i % len(colors)]
                
                nx.draw_networkx_edges(G, pos, edgelist=path_edges, 
                                    edge_color=color, width=2.0, alpha=0.8)
                
                # Highlight start/end
                nx.draw_networkx_nodes(G, pos, nodelist=[path[0], path[-1]], 
                                    node_color=color, node_size=300)
        
        # Create legend
        legend_elements = [plt.Line2D([0], [0], color=colors[i % len(colors)], lw=2, 
                                    label=f"Path {i+1} (len={len(path)})") 
                        for i, path in enumerate(paths)]
        plt.legend(handles=legend_elements, loc='upper right')
        
        # Finish plot
        plt.title(title)
        plt.axis('off')
        
        # Save visualization
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"{filename_prefix}_{timestamp}.png"
        filepath = os.path.join(self.output_dir, filename)
        plt.savefig(filepath, bbox_inches='tight')
        
        if show:
            plt.show()
        else:
            plt.close()
        
        return filepath