from fastapi import APIRouter, WebSocket
from backend.solver.maze_solver import MazeSolver

router = APIRouter()
solver = MazeSolver()

@router.post("/solve")
async def solve_maze(data: dict):
    result = solver.solve(data["edges"])
    return {"path": result}

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    while True:
        try:
            data = await websocket.receive_json()
            result = solver.solve(data["edges"])
            await websocket.send_json({"path": result})
        except Exception as e:
            await websocket.send_json({
                'type': 'error',
                'error': str(e)
            })
