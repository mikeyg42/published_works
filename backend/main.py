from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.api.routes import router
from fastapi.websockets import WebSocket
from backend.solver.maze_solver import MazeSolver
import json

app = FastAPI()

# Configure CORS for local development (support multiple origins)
origins = [
    "http://localhost:4200",  # Angular frontend
    "http://127.0.0.1:8000"   # Local FastAPI server
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include the router
app.include_router(router)

@app.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {"status": "healthy"}

@app.websocket("/maze-solver")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    try:  
        # Get and parse the data
        raw_data = await websocket.receive_text()
        data = json.loads(raw_data)
        
        # Create solver instance
        solver = MazeSolver()
        
        # Skip visualization for now
        await solver.solve_maze(data, websocket)
        
    except Exception as e:
        print(f"Error details: {type(e)}: {str(e)}")
        await websocket.send_json({
            "type": "internal_error",
            "error": f"An unexpected error occurred: {str(e)}"
        })
    finally:
        try:
            await websocket.close()
        except:
            pass