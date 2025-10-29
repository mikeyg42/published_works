#!/usr/bin/env python3
"""
Export test maze data in the format expected by the GPU renderer.

The GPU renderer expects:
{
  "hexagons": [
    {
      "id": "1",
      "q": 0, "r": 0, "s": 0,
      "center": {"x": 0.0, "y": 0.0, "z": 0.0}
    }
  ],
  "graph": [[connectivity matrix]],
  "solution": ["1", "2", "3"],
  "dimensions": {"width": 30, "height": 7, "depth": 1}
}

But the frontend sends:
{
  "components": [{"1": ["2", "3"], "2": ["1"]}],
  "dimensions": {"rows": 7, "cols": 30}
}

This script converts from the frontend format to the GPU renderer format.
"""

import json
import sys
import math
from typing import Dict, List, Any, Optional


def hex_to_pixel(q: int, r: int, size: float) -> tuple[float, float]:
    """Convert hex coordinates to pixel coordinates (pointy-top orientation)"""
    x = size * (3.0 / 2.0 * q)
    y = size * (math.sqrt(3.0) / 2.0 * q + math.sqrt(3.0) * r)
    return x, y


def generate_hex_vertices(center_x: float, center_y: float, radius: float) -> list[dict]:
    """Generate vertices for a pointy-top hexagon"""
    vertices = []
    for i in range(6):
        # Pointy-top hexagon vertices
        angle = math.pi / 3.0 * i  # 60 degrees per vertex
        x = center_x + radius * math.cos(angle)
        y = center_y + radius * math.sin(angle)
        vertices.append({"x": x, "y": y, "z": 0.0})
    return vertices


def convert_components_to_hexagons_and_graph(components_data: dict) -> dict:
    """Convert frontend components format to GPU renderer format"""

    components = components_data.get("components", [])
    dimensions = components_data.get("dimensions", {})

    # Extract all unique cell IDs from components (these are navigable cells)
    navigable_cell_ids = set()
    adjacency_map = {}

    for component in components:
        for cell_id, neighbors in component.items():
            navigable_cell_ids.add(cell_id)
            adjacency_map[cell_id] = neighbors
            for neighbor in neighbors:
                navigable_cell_ids.add(neighbor)

    # Grid dimensions
    rows = dimensions.get("rows", 7)
    cols = dimensions.get("cols", 30)
    hex_size = dimensions.get("hexWidth", 44) / 2  # Convert to radius

    # Generate complete hexagonal grid (all possible cells)
    all_possible_cells = set()
    for row in range(rows):
        for col in range(cols):
            linear_id = row * cols + col + 1  # Convert to 1-based indexing
            all_possible_cells.add(str(linear_id))

    # Create hexagons array for ALL cells in the grid
    hexagons = []
    sorted_all_cells = sorted(all_possible_cells, key=lambda x: int(x))

    for cell_id in sorted_all_cells:
        # Convert linear ID to grid coordinates
        linear_id = int(cell_id) - 1  # Convert to 0-based
        row = linear_id // cols
        col = linear_id % cols

        # Convert to hex coordinates (pointy-top, offset coordinates)
        # For pointy-top orientation with offset coordinates:
        q = col - (row - (row & 1)) // 2
        r = row
        s = -q - r

        # Calculate pixel position
        x, y = hex_to_pixel(q, r, hex_size)

        # Determine if this cell is a wall
        is_wall = cell_id not in navigable_cell_ids

        # Generate hexagon vertices
        vertices = generate_hex_vertices(x, y, hex_size * 0.8)  # Slightly smaller for visual separation

        hexagons.append({
            "id": cell_id,
            "q": q,
            "r": r,
            "s": s,
            "center": {"x": x, "y": y, "z": 0.0},
            "isWall": is_wall,
            "vertices": vertices
        })

    # Create connectivity graph (adjacency matrix) for ALL cells
    num_cells = len(sorted_all_cells)
    id_to_index = {cell_id: i for i, cell_id in enumerate(sorted_all_cells)}

    # Initialize adjacency matrix
    graph = [[0 for _ in range(num_cells)] for _ in range(num_cells)]

    # Fill adjacency matrix only for navigable cells
    for cell_id, neighbors in adjacency_map.items():
        if cell_id in id_to_index:
            cell_index = id_to_index[cell_id]
            for neighbor in neighbors:
                if neighbor in id_to_index:
                    neighbor_index = id_to_index[neighbor]
                    graph[cell_index][neighbor_index] = 1

    # Convert dimensions
    gpu_dimensions = {
        "width": dimensions.get("cols", 30),
        "height": dimensions.get("rows", 7),
        "depth": 1
    }

    return {
        "hexagons": hexagons,
        "graph": graph,
        "solution": None,  # No solution in input data
        "dimensions": gpu_dimensions
    }


def add_mock_solution(gpu_data: dict) -> dict:
    """Add a mock solution path for testing"""
    hexagons = gpu_data["hexagons"]

    # Only use non-wall hexagons for the solution path
    navigable_hexagons = [hex_cell for hex_cell in hexagons if not hex_cell["isWall"]]

    if len(navigable_hexagons) >= 10:
        # Create a simple path using first 10 navigable hexagons
        solution = [hex_cell["id"] for hex_cell in navigable_hexagons[:10]]
        gpu_data["solution"] = solution
    elif len(navigable_hexagons) > 0:
        # Use all available navigable hexagons if less than 10
        solution = [hex_cell["id"] for hex_cell in navigable_hexagons]
        gpu_data["solution"] = solution
    else:
        # No navigable hexagons found
        gpu_data["solution"] = []

    return gpu_data


def main():
    if len(sys.argv) < 2:
        print("Usage: python export_gpu_renderer_format.py <input_file> [output_file]")
        print("       If output_file is not provided, output goes to stdout")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        with open(input_file, 'r') as f:
            frontend_data = json.load(f)

        # Handle wrapped format (from frontend maze-solver service)
        if "input" in frontend_data:
            # This is the complete format saved by the frontend
            components_data = frontend_data["input"]
            timestamp = frontend_data.get("timestamp", "unknown")
            print(f"Converting frontend maze data from {timestamp}", file=sys.stderr)
        else:
            # Direct components format
            components_data = frontend_data

        # Convert to GPU renderer format
        gpu_data = convert_components_to_hexagons_and_graph(components_data)

        # Add mock solution for testing
        gpu_data = add_mock_solution(gpu_data)

        # Output result
        gpu_json = json.dumps(gpu_data, indent=2)

        if output_file:
            with open(output_file, 'w') as f:
                f.write(gpu_json)
            print(f"GPU renderer format exported to {output_file}", file=sys.stderr)
        else:
            print(gpu_json)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()