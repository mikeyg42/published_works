"""
Clean Backend #1 - Simple maze solving WebSocket without Redis complexity
"""
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.websockets import WebSocket
from starlette.websockets import WebSocketDisconnect
import json
import logging
from typing import Dict, Any
import uuid

# MazeSolver temporarily disabled for testing

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(title="Simple Maze Solver Backend")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create router
router = APIRouter()

@router.get("/health")
async def health_check():
    """Basic health check endpoint"""
    return {"status": "healthy", "service": "maze-solver-backend"}

@router.websocket("/api/maze-solver")
async def simple_maze_provider(websocket: WebSocket):
    """
    Simple WebSocket endpoint that generates and solves mazes.
    No Redis, no visualizations, no overengineering.
    """
    await websocket.accept()
    logger.info("Maze solver WebSocket connection established")

    try:
        while True:
            # Receive request
            request = await websocket.receive_json()
            logger.info(f"Received request: {request}")

            # Extract dimensions
            canvas_width = request.get('canvas_width', 800)
            canvas_height = request.get('canvas_height', 600)
            session_id = request.get('session_id', str(uuid.uuid4()))

            # Send processing started
            await websocket.send_json({
                "type": "processing_started",
                "session_id": session_id,
                "message": "Generating maze and solving..."
            })

            # Create simple test maze data based on canvas dimensions
            # Scale maze complexity with canvas size
            num_nodes = max(4, min(50, (canvas_width * canvas_height) // 10000))

            test_maze_data = {
                'components': [
                    # Simple graph component
                    {str(i): [str((i+1) % num_nodes), str((i-1) % num_nodes)]
                     for i in range(num_nodes)}
                ],
                'dimensions': {
                    'rows': max(10, canvas_height // 50),
                    'cols': max(10, canvas_width // 50)
                }
            }

            # For now, skip the complex solver and return mock data to test the flow
            try:
                # Mock solution paths for the simple test maze
                mock_solution_paths = [
                    ['1', '2', '4', '3'],  # Simple path through our 4-node graph
                ]

                # Send solution - NO VISUALIZATIONS
                await websocket.send_json({
                    "type": "solution",
                    "session_id": session_id,
                    "maze_data": test_maze_data,
                    "solution_paths": mock_solution_paths,
                    "message": f"Found {len(mock_solution_paths)} solution paths (mock data)"
                })

            except Exception as e:
                logger.error(f"Mock solver error: {e}")
                await websocket.send_json({
                    "type": "error",
                    "session_id": session_id,
                    "message": f"Mock solver error: {str(e)}"
                })

    except WebSocketDisconnect:
        logger.info("Maze solver WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.close()
        except:
            pass

# Include router
app.include_router(router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)