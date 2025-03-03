# backend/api/routes.py
from fastapi import APIRouter
from backend.models import LargeMazeData, SolutionResponse, ErrorResponse
from backend.solver.maze_solver import MazeSolver
import json

router = APIRouter(prefix="/api")

# Create a single solver instance
solver = MazeSolver()

@router.post("/solve")
async def solve_maze(data: LargeMazeData):
    """REST API endpoint for solving mazes (non-WebSocket)"""
    try:
        # Convert to JSON string for Rust
        json_data = json.dumps(data.model_dump())
        
        # Process with Rust solver
        solutions = solver.process_and_solve_maze(json_data)
        
        # Optional: Run verification in background without blocking response
        # This could be done with background tasks if needed
        
        return SolutionResponse(
            type="solution",
            data=solutions
        )
    except ValueError as ve:
        return ErrorResponse(
            type="validation_error",
            error=str(ve)
        ).model_dump()
    except Exception as e:
        return ErrorResponse(
            type="internal_error",
            error=f"An unexpected error occurred: {str(e)}"
        ).model_dump()

@router.get("/examples")
async def get_example_mazes():
    """Optional endpoint to provide example mazes for testing"""
    return {
        "examples": [
            {
                "name": "Small Test Maze",
                "description": "A simple 3x3 maze for testing",
                "data": {
                    "largeComponents": [
                        {
                            "1": ["2", "4"],
                            "2": ["1", "3", "5"],
                            "3": ["2", "6"],
                            "4": ["1", "5", "7"],
                            "5": ["2", "4", "6", "8"],
                            "6": ["3", "5", "9"],
                            "7": ["4", "8"],
                            "8": ["5", "7", "9"],
                            "9": ["6", "8"]
                        }
                    ]
                }
            }
        ]
    }