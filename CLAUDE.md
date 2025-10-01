# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A full-stack maze solver application featuring a FastAPI backend with Rust optimization and an Angular frontend with Three.js/WebGPU visualization. The backend solves maze component pathfinding problems using OR-Tools constraint programming and generates visualizations. The frontend provides an interactive 3D hexagonal maze interface with advanced path tracing rendering.

## Architecture

### Backend (Python + Rust)
- **FastAPI Server** (`backend/main.py`): Handles WebSocket and REST endpoints for maze solving
- **MazeSolver** (`backend/solver/maze_solver.py`): Core solver using OR-Tools CP-SAT and optional Rust acceleration
- **Rust Extension** (`backend/rust/`): PyO3-based native extension for performance-critical pathfinding
- **Redis Cache** (`backend/redis_cache/cache.py`): Session-based caching of maze data and solutions
- **GraphVisualizer** (`backend/visualizer/graph_visualizer.py`): Generates component visualization images
- **GCS Integration** (`backend/utils/gcs_utils.py`): Google Cloud Storage uploads for production visualizations

### Frontend (Angular + Three.js)
- **HexMaze Component** (`frontend/src/app/hex-maze/`): Main 3D maze visualization
- **MazeSceneManager** (`services/maze-scene-manager.ts`): Three.js scene management and rendering
- **PathTracingWebGPUService** (`services/pathTracing_webgpu.service.ts`): WebGPU-based path tracing renderer
- **MazeSolverService** (`services/maze-solver.service.ts`): WebSocket client for backend communication
- **Animation Services**: Camera, lighting, and path animation controllers

### WebSocket Flow
1. Client connects to `/api/maze-solver` and sends maze data with `session_id`
2. Backend sends `processing_started` acknowledgment
3. Backend processes maze and sends `solution` with paths
4. Backend asynchronously generates visualization and uploads to GCS/local storage
5. Backend sends `visualization_ready` with image URL
6. Client can access visualization via `/api/visualize/{session_id}` endpoint

## Development Commands

### Backend

**Start development server:**
```bash
cd backend
ENVIRONMENT=development uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

**Build Rust extension:**
```bash
cd backend/rust
maturin develop --release
```

**Run with Redis (required for session caching):**
```bash
# Start Redis locally first
redis-server

# Set Redis URL if non-standard
export REDIS_URL=redis://localhost:6379/0
```

**Install Python dependencies:**
```bash
pip install -r requirements.txt
pip install -e .
```

### Frontend

**Start development server:**
```bash
cd frontend
npm run start  # Runs with SSL on https://localhost:4200
```

**Build for production:**
```bash
npm run build
```

**Run tests:**
```bash
npm test
```

### Docker

**Build and run containerized backend:**
```bash
docker build -t maze-solver-backend .
docker run -p 8080:8080 \
  -e ENVIRONMENT=production \
  -e GOOGLE_STORAGE_BUCKET=maze-solver-visualizations \
  -e REDIS_URL=redis://your-redis-host:6379/0 \
  maze-solver-backend
```

## Key Environment Variables

### Backend
- `ENVIRONMENT`: `development` or `production` (affects CORS, visualization storage)
- `GOOGLE_STORAGE_BUCKET`: GCS bucket name for visualization uploads (production)
- `REDIS_URL`: Redis connection string (default: `redis://localhost:6379/0`)
- `MAZE_CACHE_TTL`: Session cache TTL in seconds (default: 600)
- `CPU_LIMIT`: Thread pool size for solver (default: 4)
- `K_SERVICE`: Auto-set in Cloud Run, disables local file operations

### Frontend
- Frontend environment configs in `frontend/src/environments/`
- WebSocket endpoint configured per environment (dev vs prod)

## Testing Visualization

See `VISUALIZATION_README.md` for comprehensive testing instructions. Quick test:

```bash
# Test WebSocket + visualization flow
python test_websocket.py

# Direct visualization test
python test_visualization.py
```

## Important Notes

- **Rust Extension**: The Rust solver (`rust_maze_solver.so`) must be built before running backend. Use `maturin develop` or install from wheel.
- **Redis Requirement**: Redis is required for session caching in REST API flows. WebSocket flows cache in-process.
- **CORS Configuration**: Development allows localhost origins. Production restricted to `michaelglendinning.com`.
- **Visualization Storage**: Development saves to local `visualizations/{session_id}/` directory. Production uploads to GCS.
- **WebSocket vs REST**: WebSocket (`/api/maze-solver`) provides real-time progress. REST (`/api/rest/maze-solver`) returns solutions immediately but requires separate call to `/api/visualize/generate/{session_id}` for images.
- **Session IDs**: Auto-generated if not provided by client. Used for caching and visualization retrieval.

## Deployment

The application deploys to Google Cloud Run:
- Backend: Containerized FastAPI service
- Frontend: Static Angular build (served separately)
- GCS: Visualization image storage
- Redis: Managed Redis instance for session cache

Dockerfile includes multi-stage build with Rust compilation and Python dependency installation.