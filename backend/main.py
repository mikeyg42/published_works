"""
Main FastAPI application for Backend Service #1
Properly integrated with consolidated Redis cache module
"""
from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.websockets import WebSocket
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketDisconnect
from contextlib import asynccontextmanager
import json
import time
import datetime
import asyncio
import logging
import httpx
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any, List
import uuid

# ========== REDIS IMPORTS - SIMPLIFIED ==========
# TODO: Re-enable Redis caching later - for now just focus on basic functionality

# ========== BACKEND IMPORTS - NON-REDIS ONLY ==========
from backend.config import settings  # App config (NO Redis settings)
from backend.solver.maze_solver import MazeSolver
from backend.models import (
    # These are backend-specific models only
    MazeSolveRequest,
    MazeSolveResponse,
    StreamlinedRequest,
    StreamlinedResponse,
    HealthCheckResponse,
    ErrorResponse,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager - handles startup and shutdown
    """
    # ========== STARTUP ==========
    try:
        logger.info("="*50)
        logger.info("Starting Backend Service #1")
        logger.info("="*50)
        
        # Initialize Redis services (handles ALL Redis setup)
        logger.info("Initializing Redis services...")
        redis_services = await setup_redis()
        
        # Store Redis services in app state
        app.state.redis = redis_services
        app.state.cache = redis_services.cache
        app.state.rate_limiter = redis_services.rate_limiter
        app.state.maze_cache = redis_services.maze_cache
        
        # Log Redis status
        if redis_services.is_healthy:
            logger.info("✅ Redis services initialized successfully")
        else:
            logger.warning("⚠️ Redis unavailable - running in degraded mode")
        
        # Initialize maze solver
        app.state.maze_solver = MazeSolver()
        await app.state.maze_solver.start_queue_processor()
        logger.info("✅ Maze solver initialized")
        
        logger.info("="*50)
        logger.info("All services started successfully")
        logger.info("="*50)
        
    except Exception as e:
        logger.error(f"Failed to initialize services: {e}")
        raise
    
    yield  # Application runs here
    
    # ========== SHUTDOWN ==========
    try:
        logger.info("="*50)
        logger.info("Shutting down Backend Service #1")
        logger.info("="*50)
        
        # Stop maze solver
        if hasattr(app.state, 'maze_solver'):
            await app.state.maze_solver.stop_queue_processor()
            logger.info("✅ Maze solver stopped")
        
        # Shutdown Redis services
        await teardown_redis()
        logger.info("✅ Redis services shut down")
        
        logger.info("="*50)
        logger.info("All services shut down successfully")
        logger.info("="*50)
        
    except Exception as e:
        logger.error(f"Error during shutdown: {e}")


# Create FastAPI app with lifespan
app = FastAPI(
    title=settings.API_TITLE,
    description=settings.API_DESCRIPTION,
    version=settings.API_VERSION,
    lifespan=lifespan,
    root_path=""  # Important for Cloud Run
)

# ========== MIDDLEWARE SETUP ==========
# Order matters! Add middleware in reverse order of execution

# 1. CORS middleware (should be one of the first to execute)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS", "HEAD"],
    allow_headers=settings.CORS_ALLOW_HEADERS,
    expose_headers=settings.CORS_EXPOSE_HEADERS,
)

# 2. Trusted Host middleware (security)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=settings.TRUSTED_HOSTS,
)

# 3. Redis-specific middleware (from redis_cache module)
app.add_middleware(create_rate_limit_middleware())
app.add_middleware(create_cache_headers_middleware())
app.add_middleware(create_redis_health_middleware())

# 4. Security Headers Middleware (general security)
@app.middleware("http")
async def add_security_headers(request, call_next):
    """Add security headers to all responses"""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Request-ID"] = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    return response

# 5. Request Logging Middleware (observability)
@app.middleware("http")
async def log_requests(request, call_next):
    """Log all incoming requests and responses"""
    # Skip logging for health checks
    if request.url.path in ["/health", "/metrics"]:
        return await call_next(request)
    
    start_time = time.time()
    
    # Log request
    logger.info(
        f"Request: {request.method} {request.url.path} "
        f"from {request.client.host if request.client else 'unknown'}"
    )
    
    # Process request
    response = await call_next(request)
    
    # Calculate duration
    duration = time.time() - start_time
    
    # Log response
    logger.info(
        f"Response: {request.method} {request.url.path} "
        f"status={response.status_code} duration={duration:.3f}s"
    )
    
    # Add timing header
    response.headers["X-Process-Time"] = f"{duration:.3f}"
    
    return response

# ========== API ROUTES ==========

router = APIRouter()


@router.get("/")
async def root():
    """Root endpoint - redirects to docs"""
    return {"message": "Maze Solver API", "docs": "/docs"}


@router.get("/health", response_model=HealthCheckResponse)
async def health_check():
    """Health check endpoint with Redis status"""
    redis_health = await get_redis_health()
    
    # Determine overall health
    if redis_health["overall_health"] == "healthy":
        status = "healthy"
    elif redis_health["redis_connected"]:
        status = "degraded"
    else:
        status = "degraded"  # App still works without Redis
    
    return HealthCheckResponse(
        status=status,
        timestamp=datetime.datetime.utcnow().isoformat(),
        version=settings.API_VERSION,
        details={
            "redis": redis_health["overall_health"],
            "maze_solver": "healthy",
        }
    )


@router.post("/api/cache/query", response_model=CacheQueryResponse)
async def query_cache(request: CacheQueryRequest):
    """
    Query for compatible cached mazes based on canvas dimensions.
    """
    # Check if maze cache is available
    if not app.state.maze_cache:
        # Return empty results if cache unavailable (graceful degradation)
        return CacheQueryResponse(
            cache_hits=[],
            count=0,
            message="Cache service temporarily unavailable"
        )
    
    try:
        # Create request info for cache query
        request_info = {
            "device_fingerprint": request.device_fingerprint,
            "ip": "query",
            "user_agent": "",
            "accept_language": "",
        }
        
        # Query compatible mazes
        compatible_mazes = await app.state.maze_cache.find_compatible_mazes(
            target_width=request.target_width,
            target_height=request.target_height,
            request_info=request_info,
            max_results=request.max_results,
        )
        
        # Format response
        cache_hits = []
        for maze_data, solutions in compatible_mazes:
            dimensions = maze_data.get('dimensions', {})
            cache_hits.append({
                "rows": dimensions.get('rows', 0),
                "cols": dimensions.get('cols', 0),
                "hexWidth": dimensions.get('hexWidth', 0),
                "hexHeight": dimensions.get('hexHeight', 0),
                "solution_count": len([s for s in solutions if s]),
                "resized_for_canvas": f"{request.target_width}x{request.target_height}",
            })
        
        return CacheQueryResponse(
            cache_hits=cache_hits,
            count=len(cache_hits),
            message=f"Found {len(cache_hits)} compatible cached maze(s)",
        )
        
    except Exception as e:
        logger.error(f"Cache query error: {e}")
        # Return empty results on error (graceful degradation)
        return CacheQueryResponse(
            cache_hits=[],
            count=0,
            message="Cache query failed"
        )


@router.get("/api/cache/stats", response_model=CacheStatsResponse)
async def get_cache_stats():
    """Get comprehensive cache statistics"""
    if not app.state.maze_cache:
        raise HTTPException(
            status_code=503,
            detail="Cache service not available"
        )
    
    try:
        stats = await app.state.maze_cache.get_cache_stats()
        
        # Add rate limiter stats if available
        if app.state.rate_limiter:
            rl_stats = await app.state.rate_limiter.get_stats()
            stats.update({"rate_limiter": rl_stats})
        
        return CacheStatsResponse(**stats)
        
    except Exception as e:
        logger.error(f"Cache stats error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get cache stats: {str(e)}"
        )


@router.post("/api/maze-solver", response_model=MazeSolveResponse)
@router.post("/api/rest/maze-solver", response_model=MazeSolveResponse)
async def solve_maze(request: MazeSolveRequest):
    """
    Solve a maze with the DFS algorithm.
    Optionally caches the solution if Redis is available.
    """
    try:
        # Generate session ID if not provided
        if not request.session_id:
            request.session_id = f"solve_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        
        # Solve the maze
        solver_data = request.dict()
        result = await app.state.maze_solver.solve_maze(
            solver_data,
            websocket=None,
            direct=True
        )
        
        # Try to cache if Redis is available
        if app.state.maze_cache and app.state.cache:
            try:
                request_info = {
                    "device_fingerprint": getattr(request, 'device_fingerprint', 'default'),
                    "ip": "solver",
                    "user_agent": "",
                    "accept_language": "",
                }
                
                await app.state.maze_cache.cache_maze(
                    session_id=request.session_id,
                    maze_data=solver_data,
                    solutions=result.get("data", []),
                    request_info=request_info
                )
                logger.info(f"Cached solution for session {request.session_id}")
            except Exception as e:
                # Caching failure shouldn't break the response
                logger.warning(f"Failed to cache solution: {e}")
        
        return MazeSolveResponse(
            session_id=request.session_id,
            data=result.get("data", [])
        )
        
    except Exception as e:
        logger.error(f"Maze solving error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Maze solving failed: {str(e)}"
        )


@router.websocket("/api/websocket/maze-solver")
async def websocket_maze_solver(websocket: WebSocket):
    """WebSocket endpoint for real-time maze solving"""
    await websocket.accept()
    logger.info(f"WebSocket connection established")

    try:
        while True:
            # Receive maze data
            data = await websocket.receive_json()

            # Generate session ID
            session_id = data.get('session_id', f"ws_{int(time.time() * 1000)}")

            # Solve maze with WebSocket for real-time updates
            await app.state.maze_solver.solve_maze(
                data,
                websocket=websocket,
                direct=False
            )

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        await websocket.send_json({"error": str(e)})
        await websocket.close()


@router.websocket("/api/maze-solver-simple")
async def simple_maze_provider(websocket: WebSocket):
    """
    Simple WebSocket endpoint that generates and solves mazes without Redis caching.
    Used for testing and development.
    """
    await websocket.accept()
    logger.info("Simple maze provider WebSocket connection established")

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

            # Create simple test maze data
            test_maze_data = {
                'components': [
                    # Simple 4-node component
                    {
                        '1': ['2', '3'],
                        '2': ['1', '4'],
                        '3': ['1', '4'],
                        '4': ['2', '3']
                    }
                ],
                'dimensions': {'rows': max(10, canvas_height // 50), 'cols': max(10, canvas_width // 50)}
            }

            # Initialize solver
            solver = MazeSolver()

            # Solve the maze
            try:
                result = await solver.solve_maze(test_maze_data, direct=True)

                if result and result.get("type") == "solution":
                    # Send solution
                    await websocket.send_json({
                        "type": "solution",
                        "session_id": session_id,
                        "maze_data": test_maze_data,
                        "solution_paths": result.get("data", []),
                        "message": f"Found {len(result.get('data', []))} solution paths"
                    })
                else:
                    await websocket.send_json({
                        "type": "error",
                        "session_id": session_id,
                        "message": "Failed to solve maze"
                    })

            except Exception as e:
                logger.error(f"Maze solving error: {e}")
                await websocket.send_json({
                    "type": "error",
                    "session_id": session_id,
                    "message": f"Solver error: {str(e)}"
                })

    except Exception as e:
        logger.error(f"Simple WebSocket error: {e}")
        await websocket.close()
        while True:
            # Receive maze request
            request = await websocket.receive_json()
            logger.info(f"Received maze request: {request.get('type', 'unknown')}")

            if request.get("type") == "get_maze":
                session_id = request.get('session_id', str(uuid.uuid4()))

                # Check Redis cache using existing system (device fingerprinting + canvas size)
                cached_maze = None
                if app.state.maze_cache:
                    try:
                        # Create request info for existing cache system
                        request_info = {
                            "device_fingerprint": request.get("device_fingerprint", "unknown"),
                            "ip": "stateless_ws",
                            "user_agent": request.get("user_agent", ""),
                            "accept_language": request.get("accept_language", ""),
                        }

                        # Use existing cache lookup logic - find compatible mazes
                        compatible_mazes = await app.state.maze_cache.find_compatible_mazes(
                            target_width=request.get("canvas_width", 1024),
                            target_height=request.get("canvas_height", 768),
                            request_info=request_info,
                            max_results=1  # Just need one compatible maze
                        )

                        if compatible_mazes:
                            # Get the best matching maze (first result)
                            maze_data, solutions = compatible_mazes[0]
                            cached_data = {
                                "maze_data": maze_data,
                                "solution_data": solutions,
                                "solutions": solutions  # Backup key
                            }
                        else:
                            cached_data = None

                        if cached_data:
                            cached_maze = cached_data
                            logger.info(f"Cache hit for session {session_id}")

                    except Exception as e:
                        logger.warning(f"Cache lookup failed: {e}, generating new maze")

                if cached_maze:
                    # Return cached maze + solution
                    await websocket.send_json({
                        "type": "maze_ready",
                        "session_id": session_id,
                        "maze_data": cached_maze.get("maze_data"),
                        "solution_data": cached_maze.get("solution_data", cached_maze.get("solutions")),
                        "cache_hit": True
                    })

                else:
                    # Generate new maze + solution using existing solver
                    try:
                        logger.info(f"Generating new maze for session {session_id}")

                        # Create maze request in expected format
                        maze_request = {
                            "canvas_width": request.get("canvas_width", 1024),
                            "canvas_height": request.get("canvas_height", 768),
                            "complexity": request.get("complexity", 0.7),
                            "session_id": session_id,
                            "device_fingerprint": request.get("device_fingerprint", "unknown")
                        }

                        # Use existing streamlined generation (bypasses WebSocket queue)
                        result = await app.state.maze_solver.solve_maze(
                            maze_request,
                            websocket=None,
                            direct=True
                        )

                        if result and result.get("type") == "solution":
                            # Cache the new result using existing system
                            if app.state.maze_cache:
                                try:
                                    request_info = {
                                        "device_fingerprint": request.get("device_fingerprint", "unknown"),
                                        "ip": "stateless_ws",
                                        "user_agent": request.get("user_agent", ""),
                                        "accept_language": request.get("accept_language", ""),
                                    }

                                    await app.state.maze_cache.cache_maze(
                                        session_id=session_id,
                                        maze_data=result.get("maze_data"),
                                        solutions=result.get("data"),
                                        request_info=request_info
                                    )

                                except Exception as e:
                                    logger.warning(f"Failed to cache new maze: {e}")

                            # Return new maze + solution
                            await websocket.send_json({
                                "type": "maze_ready",
                                "session_id": session_id,
                                "maze_data": result.get("maze_data"),
                                "solution_data": result.get("data"),
                                "cache_hit": False
                            })
                        else:
                            # Generation failed
                            await websocket.send_json({
                                "type": "error",
                                "message": "Failed to generate maze and solution"
                            })

                    except Exception as e:
                        logger.error(f"Maze generation error: {e}")
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Maze generation failed: {str(e)}"
                        })
            else:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Unknown request type: {request.get('type')}"
                })

    except WebSocketDisconnect:
        logger.info("Stateless maze provider WebSocket disconnected")
    except Exception as e:
        logger.error(f"Stateless WebSocket error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except:
            pass  # Connection might be closed
        finally:
            try:
                await websocket.close()
            except:
                pass


@router.post("/api/streamlined", response_model=StreamlinedResponse)
async def streamlined_maze_generation(request: StreamlinedRequest):
    """
    Streamlined endpoint: generates maze and sends to GPU renderer.
    This is the main endpoint for the full maze generation pipeline.
    """
    session_id = f"streamlined_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    
    try:
        # Step 1: Generate maze using TypeScript generator
        logger.info(f"Generating maze for canvas {request.canvas_width}x{request.canvas_height}")
        
        # Path to TypeScript maze generator
        script_dir = Path(__file__).parent / "backend" / "maze_generator"
        ts_script = script_dir / "generateMaze.ts"
        
        if not ts_script.exists():
            raise HTTPException(
                status_code=500,
                detail="Maze generator script not found"
            )
        
        # Execute TypeScript maze generator
        cmd = [
            "node", "-r", "ts-node/register",
            str(ts_script),
            str(request.canvas_width),
            str(request.canvas_height)
        ]
        
        result = subprocess.run(
            cmd,
            cwd=str(script_dir),
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Maze generation failed: {result.stderr}"
            )
        
        # Parse maze data
        maze_data = json.loads(result.stdout.strip())
        
        # Step 2: Solve the maze
        # Convert to solver format
        components = []  # Convert maze_data to components format
        solver_data = {
            "components": components,
            "dimensions": maze_data["dimensions"],
            "session_id": session_id,
            "device_fingerprint": request.device_fingerprint,
        }
        
        solve_result = await app.state.maze_solver.solve_maze(
            solver_data,
            websocket=None,
            direct=True
        )
        
        # Step 3: Cache if available
        if app.state.cache:
            try:
                cache_data = {
                    "maze_data": maze_data,
                    "solution": solve_result,
                    "canvas_size": {
                        "width": request.canvas_width,
                        "height": request.canvas_height
                    },
                    "timestamp": int(time.time())
                }
                
                await app.state.cache.set(
                    f"maze:{session_id}",
                    cache_data,
                    ttl=3600
                )
            except Exception as e:
                logger.warning(f"Failed to cache maze: {e}")
        
        # Step 4: Send to GPU renderer
        gpu_request = {
            "session_id": session_id,
            "maze_data": maze_data,
            "solutions": solve_result.get("data", []),
            "width": request.canvas_width,
            "height": request.canvas_height,
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            gpu_response = await client.post(
                f"{settings.GPU_RENDERER_URL}/render",
                json=gpu_request
            )
            
            if gpu_response.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail="GPU renderer service error"
                )
            
            gpu_result = gpu_response.json()
        
        return StreamlinedResponse(
            session_id=session_id,
            status="queued",
            message="Maze generated and sent to GPU renderer",
            render_task_id=gpu_result.get("task_id"),
            stream_url=gpu_result.get("stream_url"),
            status_url=f"{settings.GPU_RENDERER_URL}/status/{gpu_result.get('task_id')}",
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Streamlined generation error: {e}")
        raise HTTPException(
            status_code=500,
            detail="Maze generation failed"
        )


# Include router
app.include_router(router)


# ========== ERROR HANDLERS ==========

@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    """Custom HTTP exception handler"""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.detail,
            "status_code": exc.status_code,
            "timestamp": datetime.datetime.utcnow().isoformat(),
            "path": request.url.path,
        }
    )


@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    """Catch-all exception handler"""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "status_code": 500,
            "timestamp": datetime.datetime.utcnow().isoformat(),
            "path": request.url.path,
        }
    )


if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8080,
        reload=False,
        log_level="info",
    )
