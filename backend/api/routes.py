from fastapi import APIRouter, WebSocket
from backend.models import LargeMazeData, SolutionResponse, ErrorResponse
from backend.solver.maze_solver import MazeSolver

router = APIRouter()
solver = MazeSolver()

@router.post("/solve")
async def solve_maze(data: LargeMazeData):
    try:
        # Solutions are now processed by MazeSolver
        solutions = await solver.solve_maze(data, websocket=None)
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
            error="An unexpected error occurred"
        ).model_dump()

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    try:
        while True:
            data = await websocket.receive_json()
            maze_data = LargeMazeData(**data)
            
            # Solutions are now processed by MazeSolver
            await solver.solve_maze(maze_data, websocket)
    
    except Exception as e:
        await websocket.send_json(
            ErrorResponse(
                type="internal_error",
                error=str(e)
            ).model_dump()
        )
    finally:
        await websocket.close()
