#!/usr/bin/env python3
"""
Test script to generate a sample visualization using GraphVisualizer.
This is useful for local development testing.
"""
import os
import uuid
from backend.visualizer.graph_visualizer import GraphVisualizer
from backend.maze_generator.maze_generator import MazeGenerator
def main():
    # Create output directory if it doesn't exist
    session_id = "test-session"
    output_dir = os.path.join("visualizations", session_id)
    os.makedirs(output_dir, exist_ok=True)
    
    # Create a visualizer
    visualizer = GraphVisualizer()
    generator = MazeGenerator()
    solver = MazeSolver()
    
    
    
    # Create sample components data
    components_data = [
        {
            "id": 1,
            "nodes": ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
            "adjacency": {
                "1": ["2", "6"],
                "2": ["1", "3", "7"],
                "3": ["2", "4", "7", "8"],
                "4": ["1", "5", "9"],
                "5": ["4", "9", "10"],
                "6": ["1"],
                "7": ["2", "3"],
                "8": ["3", "9"],
                "9": ["4", "5", "10"],
                "10": ["5", "9"]
            },
            "longest_path": ["6", "1", "2", "7", "3", "8", "9", "10", "5", "4"]
        },
    ]
    
    # Create dimensions
    dimensions = {"rows": 2, "cols": 5}
    
    # Generate visualization
    # First as a file
    filepath = visualizer.create_component_report(
        dimensions,
        components_data,
        return_bytes=False
    )
    print(f"Visualization saved to: {filepath}")
    
    # Then as bytes and save to the output directory
    image_bytes = visualizer.create_component_report(
        dimensions,
        components_data,
        return_bytes=True
    )
    
    # Save bytes to a file in the session directory
    output_filepath = os.path.join(output_dir, f"test_{uuid.uuid4().hex[:8]}.png")
    with open(output_filepath, "wb") as f:
        f.write(image_bytes)
    
    print(f"Test visualization saved to: {output_filepath}")
    print(f"Access via: http://localhost:8000/api/visualize/maze/{session_id}/latest")

if __name__ == "__main__":
    main() 