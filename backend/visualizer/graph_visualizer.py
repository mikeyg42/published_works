import networkx as nx
import matplotlib
matplotlib.use('Agg')  # Use non-GUI backend
import matplotlib.pyplot as plt
import numpy as np
from typing import Dict, List, Tuple, Optional, Union
from datetime import datetime
import os
import io
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
        
        For pointy-top hexagons:
        - Node #1 is placed at the top-left corner
        - Odd-indexed rows are shifted to the right by (hex_width/2)
        """
        positions = {}
        nodes = list(G.nodes())
        
        # Get dimensions
        ncols = dimensions['cols']
        
        # Calculate hexagon dimensions for pointy-top orientation
        # For pointy-top hexagons, height = 2*radius, width = sqrt(3)*radius
        hex_radius = 1.0  # Base unit
        hex_width = hex_radius * np.sqrt(3)
        hex_height = 2 * hex_radius
        
        # Horizontal spacing between hexagon centers is 3/4 of the hexagon width
        x_spacing = hex_width  # This makes hexagons share edges
        # Vertical spacing is the height of the hexagon
        y_spacing = (3/2) * hex_radius
        
        # X-offset for odd-indexed rows
        odd_row_x_offset = x_spacing / 2
        
        try:
            node_ids = [int(node) for node in nodes]
            
            # For each node ID, calculate its position based on 1-indexed grid coordinates
            for node_id in node_ids:
                # Convert 1-indexed node ID to 0-indexed position
                pos = node_id - 1
                
                # Calculate row and column (0-indexed)
                row = pos // ncols
                col = pos % ncols
                
                # Apply hexagonal layout coordinates
                # For pointy-top hexagons:
                # 1. Calculate the base position
                x = col * x_spacing
                y = row * y_spacing
                
                # 2. Apply horizontal offset for odd rows
                if row % 2 == 1:  # Odd-indexed row
                    x += odd_row_x_offset
                
                # Store position
                # Note that we invert the y-coordinate to have node #1 at the top-left
                # (in matplotlib, lower y values are at the top of the plot)
                positions[str(node_id)] = np.array([x, -y])
                
        except ValueError:
            # Fall back to spring layout if nodes aren't integers
            print("Warning: Could not interpret node IDs as integers. Using spring layout.")
            positions = nx.spring_layout(G, seed=42)
        
        return positions
    
    def create_component_report(self, 
                              dimensions: Dict[str, int],
                              components_data: List[Dict], 
                              return_bytes: bool = True) -> Union[str, bytes]:
        """
        Create a comprehensive visualization showing:
        1. Grid view with components colored uniquely and longest paths highlighted
        2. Abstract graph views of each component with paths highlighted
        
        Args:
            dimensions: Dictionary with 'rows' and 'cols' keys
            components_data: List of dicts, each containing:
                - id: Component identifier
                - nodes: List of node IDs in this component
                - adjacency: Dict mapping node IDs to neighbor lists
                - longest_path: List of nodes in longest path
            return_bytes: If True, return PNG bytes instead of filepath
            
        Returns:
            Either filepath (str) or PNG image data (bytes)
        """
        # Skip if no components provided
        if not components_data:
            print("No component data provided for visualization")
            return b"" if return_bytes else ""
        
        # Determine figure layout based on number of components
        num_components = len(components_data)
        grid_height = 8  # Height allocation for the main grid view
        
        # Calculate how many component graphs to show per row
        comps_per_row = min(3, num_components)
        comp_rows = (num_components + comps_per_row - 1) // comps_per_row  # Ceiling division
        
        # Set up figure
        total_height = grid_height + 4 * comp_rows
        fig = plt.figure(figsize=(15, total_height), dpi=120)
        
        # Create grid for subplots
        grid_spec = plt.GridSpec(1 + comp_rows, comps_per_row, height_ratios=[grid_height] + [4] * comp_rows)
        
        # 1. Create the main grid view showing all components
        ax_grid = fig.add_subplot(grid_spec[0, :])
        self._draw_grid_view(ax_grid, dimensions, components_data)
        
        # 2. Create abstract views for each component
        for i, component_data in enumerate(components_data):
            row = 1 + (i // comps_per_row)
            col = i % comps_per_row
            ax_comp = fig.add_subplot(grid_spec[row, col])
            self._draw_component_view(ax_comp, component_data)
        
        # Adjust layout
        plt.tight_layout()
        
        # Save or return the figure
        if return_bytes:
            # Save to in-memory buffer
            buf = io.BytesIO()
            plt.savefig(buf, format='png')
            plt.close(fig)
            buf.seek(0)
            return buf.getvalue()
        else:
            # Save to file
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            filename = f"component_report_{timestamp}.png"
            filepath = os.path.join(self.output_dir, filename)
            plt.savefig(filepath)
            plt.close(fig)
            return filepath
    
    def _draw_grid_view(self, ax, dimensions: Dict[str, int], components_data: List[Dict]):
        """
        Draw a grid view with hexagonal cells colored by component.
        
        Args:
            ax: Matplotlib Axes object to draw on
            dimensions: Dictionary with grid dimensions
            components_data: List of component data dicts
        """
        # Create a unified graph containing all nodes
        all_nodes = set()
        for component in components_data:
            all_nodes.update(component.get('nodes', []))
        
        full_adjacency = {}
        for component in components_data:
            full_adjacency.update(component.get('adjacency', {}))
        
        # Create networkx graph for layout calculation
        G_full = self.create_nx_graph(full_adjacency)
        
        # Calculate positions for all nodes
        pos = self.hex_grid_layout(G_full, dimensions)
        
        # Generate a distinct color palette for components
        # Using tab10/tab20 for up to 20 components, then generate colors for more
        if len(components_data) <= 10:
            colors = plt.cm.tab10(np.linspace(0, 1, 10))
        elif len(components_data) <= 20:
            colors = plt.cm.tab20(np.linspace(0, 1, 20))
        else:
            colors = plt.cm.hsv(np.linspace(0, 1, len(components_data)))
        
        # Calculate hexagon size based on grid spacing
        hex_radius = 1.0  # Base unit (same as in hex_grid_layout)
        hex_size = hex_radius * 0.97  # Slightly smaller than the actual radius for better visualization
        
        # Draw hexagons for each component
        for comp_idx, component in enumerate(components_data):
            comp_color = colors[comp_idx % len(colors)]
            nodes = component.get('nodes', [])
            
            # Draw each node as a hexagon
            for node in nodes:
                if node not in pos:
                    continue
                    
                x, y = pos[node]
                
                # Create pointy-top hexagon shape
                angles = np.pi/2 + np.linspace(0, 2*np.pi, 7)[:-1]  # 6 points, rotated for pointy-top
                hex_x = x + hex_size * np.cos(angles)
                hex_y = y + hex_size * np.sin(angles)
                hex_points = list(zip(hex_x, hex_y))
                
                # Draw the hexagon with component color
                ax.add_patch(plt.Polygon(hex_points, color=comp_color, alpha=0.7))
                
                # Add node labels for smaller grids
                if len(pos) < 100:
                    ax.text(x, y, node, ha='center', va='center', fontsize=7,
                          bbox=dict(facecolor='white', alpha=0.6, boxstyle='round,pad=0.1'))
        
        # Draw longest paths on top with thick black lines
        for comp_idx, component in enumerate(components_data):
            path = component.get('longest_path', [])
            
            if len(path) > 1:
                # Draw path segments as lines
                for i in range(len(path) - 1):
                    node1, node2 = path[i], path[i+1]
                    if node1 in pos and node2 in pos:
                        x1, y1 = pos[node1]
                        x2, y2 = pos[node2]
                        ax.plot([x1, x2], [y1, y2], color='black', linewidth=2.5, alpha=0.8)
                
                # Mark start and end nodes
                if path[0] in pos:
                    x, y = pos[path[0]]
                    ax.plot(x, y, 'go', markersize=10, alpha=0.8)  # Green circle for start
                
                if path[-1] in pos:
                    x, y = pos[path[-1]]
                    ax.plot(x, y, 'ro', markersize=10, alpha=0.8)  # Red circle for end
        
        # Set axis limits with padding
        if pos:
            x_coords = [p[0] for p in pos.values()]
            y_coords = [p[1] for p in pos.values()]
            padding = max(dimensions['rows'], dimensions['cols']) * 0.2
            ax.set_xlim(min(x_coords) - padding, max(x_coords) + padding)
            ax.set_ylim(min(y_coords) - padding, max(y_coords) + padding)
        
        # Set up the plot
        ax.set_title(f"Maze Components Grid View ({dimensions['rows']}×{dimensions['cols']})", fontsize=14)
        ax.set_aspect('equal')
        ax.axis('off')
        
        # Add a legend for components
        legend_elements = [plt.Line2D([0], [0], marker='o', color='w', 
                                     markerfacecolor=colors[i % len(colors)], 
                                     markersize=10, label=f"Component {i+1}") 
                         for i in range(len(components_data))]
        ax.legend(handles=legend_elements, loc='upper right', ncol=min(5, len(components_data)))
    
    def _draw_component_view(self, ax, component_data: Dict):
        """
        Draw an abstract view of a single component with its longest path highlighted.
        
        Args:
            ax: Matplotlib Axes object to draw on
            component_data: Dictionary with component information
        """
        component_id = component_data.get('id', '?')
        adjacency = component_data.get('adjacency', {})
        nodes = component_data.get('nodes', [])
        path = component_data.get('longest_path', [])
        
        # Skip if no adjacency information
        if not adjacency:
            ax.text(0.5, 0.5, "No graph data", ha='center', va='center')
            ax.set_title(f"Component {component_id}")
            ax.axis('off')
            return
        
        # Create a graph for this component
        G_comp = self.create_nx_graph(adjacency)
        
        # Use a force-directed layout for abstract view
        try:
            pos = nx.kamada_kawai_layout(G_comp)
        except:
            # Fallback to spring layout if kamada_kawai fails
            pos = nx.spring_layout(G_comp, seed=42)
        
        # Draw regular edges first (light gray)
        nx.draw_networkx_edges(G_comp, pos, ax=ax, 
                             width=1.0, edge_color='lightgray', alpha=0.7)
        
        # Draw all nodes (light blue)
        nx.draw_networkx_nodes(G_comp, pos, ax=ax,
                              node_size=100, node_color='lightblue', alpha=0.7)
        
        # Draw the path if provided
        if path and len(path) > 1:
            # Extract edges from the path
            path_edges = list(zip(path[:-1], path[1:]))
            
            # Draw path edges as thick black lines
            nx.draw_networkx_edges(G_comp, pos, ax=ax,
                                 edgelist=path_edges, 
                                 width=2.5, edge_color='black', alpha=0.8)
            
            # Highlight start and end nodes
            nx.draw_networkx_nodes(G_comp, pos, ax=ax, 
                                 nodelist=[path[0]], 
                                 node_size=150, node_color='green', alpha=1.0)
            
            nx.draw_networkx_nodes(G_comp, pos, ax=ax,
                                 nodelist=[path[-1]], 
                                 node_size=150, node_color='red', alpha=1.0)
            
            # Draw the rest of the path nodes
            if len(path) > 2:
                nx.draw_networkx_nodes(G_comp, pos, ax=ax,
                                     nodelist=path[1:-1], 
                                     node_size=120, node_color='orange', alpha=0.8)
        
        # Add labels for smaller graphs
        if len(G_comp) < 50:
            nx.draw_networkx_labels(G_comp, pos, ax=ax, font_size=8, font_family='sans-serif')
        
        # Set up the plot
        path_len = len(path) if path else 0
        nodes_len = len(G_comp.nodes())
        ax.set_title(f"Component {component_id} - Path: {path_len}/{nodes_len} nodes", fontsize=12)
        ax.axis('off')
    
    # Legacy helper methods needed by MazeSolver
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
        
        Note: This is a legacy method maintained for backward compatibility.
        """
        # Create graph and determine layout
        G = self.create_nx_graph(adjacency_dict)
        
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
        
        # Set axis limits with padding
        if pos:
            x_coords = [p[0] for p in pos.values()]
            y_coords = [p[1] for p in pos.values()]
            padding = max(dimensions.get('rows', 10), dimensions.get('cols', 10)) * 0.2
            plt.xlim(min(x_coords) - padding, max(x_coords) + padding)
            plt.ylim(min(y_coords) - padding, max(y_coords) + padding)
        
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
        
        Note: This is a legacy method maintained for backward compatibility.
        """
        G = self.create_nx_graph(adjacency_dict)
            
        pos = self.hex_grid_layout(G, dimensions)
        
        # Create figure
        plt.figure(figsize=(12, 10))
        ax = plt.gca()
        
        # Use consistent hexagon size with hex_grid_layout
        hex_radius = 1.0  # Base unit
        hex_size = hex_radius * 0.97  # Slightly smaller for better visualization
        
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
        
        # Set axis limits with padding
        if pos:
            x_coords = [p[0] for p in pos.values()]
            y_coords = [p[1] for p in pos.values()]
            padding = max(dimensions.get('rows', 10), dimensions.get('cols', 10)) * 0.2
            plt.xlim(min(x_coords) - padding, max(x_coords) + padding)
            plt.ylim(min(y_coords) - padding, max(y_coords) + padding)
        
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
    
    # Helper for saving figures
    def _save_figure(self, filename: str) -> str:
        """Helper method to save a figure to the output directory."""
        filepath = os.path.join(self.output_dir, filename)
        plt.savefig(filepath)
        return filepath
    
# Note: The following methods were removed as they're not used by the core functionality:
# - maintain_clockwise_order: Not needed for component visualization
# - visualize_clockwise_ordering: Specialized debugging tool not needed for health check
# - visualize_multiple_paths: Superseded by the new component_report functionality