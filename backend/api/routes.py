# backend/api/routes.py
from fastapi import APIRouter
from backend.models import LargeMazeData, SolutionResponse, ErrorResponse
import json
from backend.solver.maze_solver import MazeSolver
from fastapi import WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import RedirectResponse, FileResponse
from google.cloud import storage
import os
import logging

router = APIRouter(prefix="/api")

# Create a single solver instance
solver = MazeSolver()

@router.post("/solve")
async def solve_maze(data: LargeMazeData):
    """REST API endpoint for solving mazes (non-WebSocket)"""
    try:
        # Convert to JSON string for Rust
        json_data = json.dumps(data.model_dump())
        
        # Process with Rust solver and/or OR-Tools
        solutions = solver.process_and_solve_maze(json_data)

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
        
@router.websocket("/ws/solve")
async def websocket_solve_maze(websocket: WebSocket):
    """WebSocket endpoint for solving mazes with real-time updates"""
    await websocket.accept()
    try:
        # Receive the JSON data from the client
        data = await websocket.receive_json()
        
        # Convert to proper model if needed
        maze_data = LargeMazeData.model_validate(data)
        json_data = json.dumps(maze_data.model_dump())
        
        # Send acknowledgment that processing is starting
        await websocket.send_json({
            "type": "status",
            "message": "Processing started"
        })
    
        # For now, we'll just send the final solution
        solutions = solver.process_and_solve_maze(json_data)
        
        # Send the solution
        await websocket.send_json(SolutionResponse(
            type="solution",
            data=solutions
        ).model_dump())
        
    except WebSocketDisconnect:
        # Client disconnecteda
        pass
    except ValueError as ve:
        # Validation error
        await websocket.send_json(ErrorResponse(
            type="validation_error",
            error=str(ve)
        ).model_dump())
    except Exception as e:
        # Unexpected error
        await websocket.send_json(ErrorResponse(
            type="internal_error",
            error=f"An unexpected error occurred: {str(e)}"
        ).model_dump())
        
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
    
@router.get("/visualize/maze/{session_id}/latest")
async def get_latest_visualization(session_id: str):
    """
    Get the latest visualization for a maze session.
    Redirects to the image in Google Cloud Storage or serves local file in development.
    """
    try:
        # Get bucket name from environment or use default
        bucket_name = os.environ.get("GCS_BUCKET_NAME", "maze-solver-visualizations")
        
        print(f"Fetching latest visualization for session: {session_id}")
        
        # Check for local files first (development fallback)
        local_prefix = f"visualizations/{session_id}/"
        if os.path.exists(local_prefix):
            # List files in the directory
            files = [f for f in os.listdir(local_prefix) if os.path.isfile(os.path.join(local_prefix, f)) and f.endswith(".png")]
            
            if files:
                # Sort by modification time (most recent first)
                latest_file = sorted(files, key=lambda f: os.path.getmtime(os.path.join(local_prefix, f)), reverse=True)[0]
                local_path = os.path.join(local_prefix, latest_file)
                
                print(f"Found local visualization file: {local_path}")
                
                # Use FileResponse for local files
                return FileResponse(
                    local_path, 
                    media_type="image/png",
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                        "Cache-Control": "no-cache"
                    }
                )
            else:
                print(f"No local files found in: {local_prefix}")
        else:
            print(f"Local directory does not exist: {local_prefix}")
        
        # Try GCS if no local files found
        try:
            # Initialize Google Cloud Storage client
            client = storage.Client()
            bucket = client.bucket(bucket_name)
            
            # List blobs with the session prefix
            prefix = f"visualizations/{session_id}/"
            print(f"Listing GCS blobs with prefix: {prefix}")
            blobs = list(bucket.list_blobs(prefix=prefix))
            
            # Check if any visualizations exist
            if not blobs:
                print(f"No GCS blobs found with prefix: {prefix}")
                raise HTTPException(
                    status_code=404,
                    detail=f"No visualizations found for session: {session_id}"
                )
            
            # Sort by name to get the most recent (assuming timestamp in filename)
            latest_blob = sorted(blobs, key=lambda b: b.name, reverse=True)[0]
            print(f"Found latest GCS blob: {latest_blob.name}")
            
            # Generate the public URL
            url = f"https://storage.googleapis.com/{bucket_name}/{latest_blob.name}"
            print(f"Redirecting to GCS URL: {url}")
            
            # Redirect to the image
            return RedirectResponse(url=url)
        except Exception as gcs_error:
            logging.error(f"GCS error: {str(gcs_error)}")
            raise HTTPException(
                status_code=404,
                detail=f"No visualizations found in GCS for session: {session_id}. Error: {str(gcs_error)}"
            )
    
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error retrieving visualization: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Error retrieving visualization: {str(e)}"
        )