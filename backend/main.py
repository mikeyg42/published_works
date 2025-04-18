from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.api.routes import router
from fastapi.websockets import WebSocket
from backend.solver.maze_solver import MazeSolver
import json
from starlette.websockets import WebSocketDisconnect
from contextlib import asynccontextmanager
from fastapi.middleware.trustedhost import TrustedHostMiddleware
import time
import random
import datetime
import asyncio

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize the maze solver queue
    await app.state.maze_solver.start_queue_processor()
    yield
    # Shutdown: properly stop the queue processor
    await app.state.maze_solver.stop_queue_processor()

app = FastAPI(lifespan=lifespan, root_path="")

# Configure CORS for both development and production
origins = [
    # Production
    "https://michaelglendinning.com",
    
    # Development - common local ports
    "http://localhost:4200",    # Angular default
    "http://localhost:3000",    # React/Next.js default
    "http://localhost:8000",    # FastAPI/Django default
    "http://localhost:8080",    # General development
    "http://127.0.0.1:4200",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8080",
]

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add Trusted Host middleware
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["*"]
)

# Include the router
app.include_router(router)

# Create a single solver instance as application state
app.state.maze_solver = MazeSolver()

@app.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {"status": "healthy"}

@app.get("/test-websocket")
async def test_websocket():
    """Test endpoint to verify WebSocket functionality."""
    return {"status": "websocket_test", "message": "WebSocket endpoint is available"}

@app.websocket("/maze-solver")
async def websocket_endpoint(websocket: WebSocket):
    print("WebSocket connection request received")
    print(f"Client host: {websocket.client.host}")
    print(f"Client port: {websocket.client.port}")
    print(f"Headers: {websocket.headers}")
    print(f"URL: {websocket.url}")
    print(f"Query params: {websocket.query_params}")
    print(f"Path params: {websocket.path_params}")
    print(f"Client: {websocket.client}")
    
    try:
        await websocket.accept()
        print("WebSocket connection accepted")
        
        # Get and parse the data
        raw_data = await websocket.receive_text()
        print(f"Received data: {raw_data[:100]}...")  # Print first 100 chars
        
        try:
            data = json.loads(raw_data)
        except json.JSONDecodeError as e:
            print(f"JSON parsing error: {str(e)}")
            await websocket.send_json({
                "type": "internal_error",
                "error": f"Invalid JSON format: {str(e)}"
            })
            return
        
        # Handle test messages
        if isinstance(data, dict) and data.get('type') == 'test':
            print(f"Received test message: {data.get('message')}")
            await websocket.send_json({
                "type": "test_response",
                "message": "Test message received successfully"
            })
            return
        
        # Extract session_id if provided
        session_id = None
        if isinstance(data, dict) and 'session_id' in data:
            session_id = data['session_id']
            print(f"Using session_id from client: {session_id}")
        else:
            # Generate a new session ID
            session_id = f"session_{int(time.time())}_{random.randint(1000, 9999)}"
            print(f"Generated new session_id: {session_id}")
            # Add it to the data
            if isinstance(data, dict):
                data['session_id'] = session_id
        
        # Log the dimensions if present
        if 'dimensions' in data:
            print(f"Received maze dimensions: {data['dimensions']}")
        
        # Get solver instance from app state
        solver = app.state.maze_solver
        
        # Send acknowledgment that processing is starting
        await websocket.send_json({
            "type": "processing_started",
            "session_id": session_id,
            "timestamp": datetime.datetime.now().isoformat()
        })
        
        # Process the maze directly instead of queueing
        # This ensures we can handle the WebSocket connection throughout
        # the entire process and respond with all required messages
        print(f"Starting direct maze processing for session: {session_id}")
        await solver._solve_maze_internal(data, websocket, f"direct_{session_id}")
        
        # Keep connection open for a moment to ensure all messages are sent
        # This is important for the visualization_ready message which is sent asynchronously
        await asyncio.sleep(2)
        print("Maze processing completed, keeping connection open for final messages")
        
    except WebSocketDisconnect:
        # Client disconnected, cancel any running tasks for this websocket
        print("WebSocket disconnected")
        await app.state.maze_solver.cancel_tasks_for_websocket(websocket)
    except Exception as e:
        print(f"Error details: {type(e)}: {str(e)}")
        try:
            await websocket.send_json({
                "type": "internal_error",
                "error": f"An unexpected error occurred: {str(e)}"
            })
        except:
            print(f"Could not send error message: {str(e)}")
    finally:
        try:
            print(f"Closing WebSocket connection for session: {session_id}")
            await app.state.maze_solver.cancel_tasks_for_websocket(websocket)
            await websocket.close()
        except:
            pass