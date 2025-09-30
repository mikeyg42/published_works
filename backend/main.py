from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
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
import os
import logging
from google.cloud import storage
from fastapi.responses import RedirectResponse, FileResponse, Response
from fastapi import HTTPException
from typing import List, Dict
from pydantic import BaseModel
from backend.redis_cache.cache import fetch as redis_fetch

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
    "https://localhost:4200",    # Angular default
    "https://localhost:3000",    # React/Next.js default
    "https://localhost:8000",    # FastAPI/Django default
    "https://localhost:8080",    # General development
    "https://127.0.0.1:4200",
    "https://127.0.0.1:3000",
    "https://127.0.0.1:8000",
    "https://127.0.0.1:8080",
]

# Define allowed headers explicitly
allowed_headers = [
    "Accept",
    "Accept-Language",
    "Content-Language",
    "Content-Type",
    "Authorization", # If you plan to use authentication
    "X-Requested-With",
    # Add any other custom headers your frontend might send
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"], # Specify methods
    allow_headers=allowed_headers, # Use the explicit list
)

# Conditional Trusted Hosts
allowed_hosts_config = ["michaelglendinning.com", "*"]
# Check an environment variable (e.g., ENVIRONMENT) to add local hosts for development
if os.environ.get("ENVIRONMENT", "production").lower() == "development":
    print("Development environment detected: Allowing localhost/127.0.0.1 as trusted hosts.")
    allowed_hosts_config.extend(["localhost", "127.0.0.1"])
    allowed_hosts_config = list(set(allowed_hosts_config)) 

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=allowed_hosts_config, # Use the conditional list
)

router = APIRouter()

# Define Pydantic models for request and response bodies for type safety
class MazeSolveRequest(BaseModel):
    components: List[Dict[str, List[str]]]
    dimensions: Dict[str, int]
    session_id: str | None = None # Optional session_id from client
    # Add any other fields the frontend might send, like 'skip_rust'
    skip_rust: bool | None = False

class MazeSolveResponse(BaseModel):
    session_id: str
    data: List[List[str]]

@router.get("/api/visualize/{session_id}", response_model=None)
async def get_visualization(session_id: str) -> Response:
    try:
        env = os.environ.get('ENVIRONMENT', 'production').lower()
        bucket_name = os.environ.get("GOOGLE_STORAGE_BUCKET")

        print(f"Visualization request for session {session_id} in '{env}' mode.")

        if env == 'development':
            # --- Development Logic: Look for local files only ---
            local_prefix = f"visualizations/{session_id}/"
            print(f"DEV MODE: Checking local path: {local_prefix}")
            if os.path.exists(local_prefix):
                files = [f for f in os.listdir(local_prefix) if os.path.isfile(os.path.join(local_prefix, f)) and f.endswith(".png")]
                if files:
                    # Sort by modification time (most recent first)
                    latest_file = sorted(files, key=lambda f: os.path.getmtime(os.path.join(local_prefix, f)), reverse=True)[0]
                    local_path = os.path.join(local_prefix, latest_file)
                    print(f"DEV MODE: Found local visualization file: {local_path}")
                    # Use FileResponse for local files
                    return FileResponse(
                        local_path,
                        media_type="image/png",
                        headers={
                            "Access-Control-Allow-Origin": "*", # Consider restricting in real dev
                            "Access-Control-Allow-Methods": "GET, OPTIONS",
                            "Access-Control-Allow-Headers": "Content-Type",
                            "Cache-Control": "no-cache"
                        }
                    )
                else:
                    print(f"DEV MODE: No local .png files found in: {local_prefix}")
                    raise HTTPException(status_code=404, detail=f"DEV MODE: No local .png visualizations found for session: {session_id}")
            else:
                print(f"DEV MODE: Local directory does not exist: {local_prefix}")
                raise HTTPException(status_code=404, detail=f"DEV MODE: Visualization directory not found locally for session: {session_id}")

        else:
            # --- Production Logic: Look in GCS only ---
            if not bucket_name:
                logging.error("PRODUCTION MODE ERROR: GOOGLE_STORAGE_BUCKET environment variable not set.")
                raise HTTPException(status_code=500, detail="Server configuration error: Storage bucket not specified.")

            try:
                client = storage.Client()
                bucket = client.bucket(bucket_name)
                prefix = f"visualizations/{session_id}/"
                print(f"PROD MODE: Listing GCS blobs in gs://{bucket_name}/{prefix}")
                blobs = list(bucket.list_blobs(prefix=prefix))

                # Filter out potential directory placeholders if necessary
                image_blobs = [b for b in blobs if b.name.lower().endswith(".png") and b.size > 0]

                if not image_blobs:
                    print(f"PROD MODE: No GCS visualization blobs found with prefix: {prefix}")
                    raise HTTPException(
                        status_code=404,
                        detail=f"No production visualizations found in GCS for session: {session_id}"
                    )

                # Sort by name to get the most recent (assuming timestamp in filename)
                latest_blob = sorted(image_blobs, key=lambda b: b.name, reverse=True)[0]
                print(f"PROD MODE: Found latest GCS blob: {latest_blob.name}")

                # Generate the public URL (consider signed URLs for private buckets)
                # Ensure bucket/objects are publicly readable or use signed URLs
                url = f"https://storage.googleapis.com/{bucket_name}/{latest_blob.name}"
                print(f"PROD MODE: Redirecting to GCS URL: {url}")

                # Redirect to the image
                return RedirectResponse(url=url)

            except Exception as gcs_error:
                logging.error(f"PROD MODE: GCS error for prefix gs://{bucket_name}/{prefix}: {str(gcs_error)}")
                raise HTTPException(
                    status_code=500, # Use 500 for GCS errors
                    detail=f"Error accessing visualization storage for session: {session_id}."
                )

    except HTTPException as http_exc:
        # Log and re-raise specific HTTP exceptions
        logging.error(f"HTTP exception for session {session_id}: {http_exc.status_code} - {http_exc.detail}")
        raise http_exc
    except Exception as e:
        # Catch any other unexpected errors
        logging.error(f"Unexpected error retrieving visualization for session {session_id}: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error while retrieving visualization."
        )

@router.get("/api/health_check")
async def health_check():
    return {"status": "healthy"}
        
@router.websocket("/api/maze-solver") # we don't need to pass in session_id here because it's passed along with the data
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
            print(f"Session_id not found!! Generated new session_id: {session_id}")
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
        print("Maze processing completed, keeping connection open for final messages")
        await asyncio.sleep(2)
        
    except WebSocketDisconnect:
        # Client disconnected, cancel any running tasks for this websocket
        print("WebSocket disconnecting")
        await asyncio.sleep(2)
        await app.state.maze_solver.cancel_tasks_for_websocket(websocket)
    except Exception as e:
        print(f"Error details: {type(e)}: {str(e)}")
        await asyncio.sleep(2)
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
            await asyncio.sleep(2)
            await app.state.maze_solver.cancel_tasks_for_websocket(websocket)
            await websocket.close()
        except:
            pass
        
@router.post("/api/rest/maze-solver", response_model=MazeSolveResponse)
async def http_solve_maze(request_data: MazeSolveRequest):
    """
    REST endpoint for solving maze components.
    Receives components and dimensions, returns session_id and solution paths.
    """
    print(f"Received REST solve request. Session: {request_data.session_id}")
    solver = app.state.maze_solver
    try:
        # Prepare data in the format expected by solve_maze
        # Pydantic automatically converts the request body JSON to the MazeSolveRequest object
        solver_data = request_data.dict() 
        
        # Call the solver directly (no websocket, direct=True implies sync processing)
        # The solver._solve_maze_implementation should now return the dict {session_id, data}
        result = await solver.solve_maze(solver_data, websocket=None, direct=True)

        # FastAPI will automatically use the response_model (MazeSolveResponse)
        # to validate and serialize the 'result' dictionary into the JSON response.
        print(f"REST solve successful for session: {result.get('session_id')}")
        return result
    except Exception as e:
        # Handle potential errors from the solver
        print(f"Error during REST solve: {e}")
        import traceback
        traceback.print_exc()
        # Re-raise as HTTPException for FastAPI to handle
        raise HTTPException(status_code=500, detail=f"Maze solving failed: {str(e)}")

# -----------------------------------------------------------------------------
# Visualization generation trigger (HTTPS). Client calls this after receiving
# solution to request that the backend generate & upload the visualization. The
# backend responds with JSON containing status and optional URL.
# -----------------------------------------------------------------------------

@router.get("/api/visualize/generate/{session_id}")
async def generate_visualization(session_id: str):
    """Generate visualization for a previously solved session.

    The solver must have cached the session data & solutions. Returns JSON with
    the same structure produced by _generate_component_report_for_rest.
    """
    
    cached = await redis_fetch(session_id)
    if not cached:
        raise HTTPException(status_code=404,detail=f"Session '{session_id}' not in cache (expired or wrong instance)." )
    data, solutions = cached
    try:
        print(f"Triggering visualization generation for session: {session_id}")
        viz_info = await solver._generate_component_report_for_rest(data, solutions)  # type: ignore[arg-type]
        
        # --- NEW: Check status from generation report ---
        if viz_info.get("status") != "success":
             error_detail = viz_info.get("error", "Unknown visualization generation issue")
             status_code = 500 # Default to 500 for failures
             if viz_info.get("status") == "no_components":
                 status_code = 400 # Bad request - nothing to visualize
                 error_detail = "No components with solutions found to visualize for this session."
             elif viz_info.get("status") == "no_dimensions":
                 status_code = 400
                 error_detail = "Maze dimensions were not available for visualization."
             elif viz_info.get("status") == "upload_error":
                 status_code = 503 # Service unavailable (GCS issue)
             
             # Log the specific error before raising generic HTTP exception
             logging.error(f"Visualization failed for session {session_id}. Status: {viz_info.get('status')}, Detail: {error_detail}")
             
             # Raise HTTPException with more specific detail from viz_info
             raise HTTPException(
                 status_code=status_code, 
                 detail=f"Visualization failed: {error_detail}"
             )
        # --- END NEW ---
            
        print(f"Visualization generation successful for session: {session_id}. URL: {viz_info.get('url')}")
        return viz_info # Return the full success metadata {status: 'success', url: ..., ...}
        
    except HTTPException as http_exc:
         # Re-raise HTTPExceptions directly (like the 404 or the ones we just created)
         raise http_exc
    except Exception as e:
        # Catch any other unexpected errors during the process
        logging.error(f"Unexpected error during visualization generation for session {session_id}: {e}", exc_info=True) # Log stack trace
        raise HTTPException(
            status_code=500, 
            # Provide more context in the 500 error
            detail=f"Internal server error during visualization generation: {str(e)}" 
        )

app.include_router(router)

# Create a single solver instance as application state
app.state.maze_solver = MazeSolver()
