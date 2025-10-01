#!/usr/bin/env python3
"""Test script to verify the cleaned up maze solver works correctly."""

import asyncio
import json
from solver.maze_solver import MazeSolver

async def test_solver():
    # Create a simple test maze
    test_data = {
        'components': [
            # Small component (should use Rust)
            {
                '1': ['2', '3'],
                '2': ['1', '4'],
                '3': ['1', '4'],
                '4': ['2', '3']
            },
            # Larger component (should use OR-Tools)
            {str(i): [str((i+1) % 300), str((i-1) % 300)] for i in range(300)}
        ],
        'dimensions': {'rows': 10, 'cols': 10}
    }
    
    print("Test data created:")
    print(f"- Component 1: {len(test_data['components'][0])} nodes (should use Rust)")
    print(f"- Component 2: {len(test_data['components'][1])} nodes (should use OR-Tools)")
    
    # Initialize solver
    solver = MazeSolver()
    
    # Test the solver
    print("\nTesting solver...")
    result = await solver.solve_maze(test_data, direct=True)
    
    print("\nResults:")
    print(f"Session ID: {result['session_id']}")
    print(f"Solutions: {len(result['data'])} components solved")
    
    for i, solution in enumerate(result['data']):
        print(f"  Component {i}: path length = {len(solution)}")
        if len(solution) > 0 and len(solution) <= 10:
            print(f"    Path: {solution}")
    
    # Test with skip_rust flag
    print("\n\nTesting with skip_rust=True...")
    test_data['skip_rust'] = True
    result2 = await solver.solve_maze(test_data, direct=True)
    
    print("Results with OR-Tools only:")
    for i, solution in enumerate(result2['data']):
        print(f"  Component {i}: path length = {len(solution)}")

if __name__ == "__main__":
    asyncio.run(test_solver()) 