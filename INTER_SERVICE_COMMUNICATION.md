# Inter-Service Communication Optimization

## Current Architecture Issues

### Problem 1: Request/Response Pattern
Currently using HTTP request/response for:
- Frontend → Maze Solver Service
- Maze Solver Service → GPU Renderer Service

This creates latency and doesn't support real-time updates well.

### Problem 2: Data Duplication
The maze solver generates GPU renderer data but has to send it back to frontend, which then forwards it to GPU renderer.

## Proposed Optimizations

### Option 1: Service-to-Service Direct Communication
1. **Streamlined endpoint returns task_id immediately**
2. **Maze Solver calls GPU Renderer directly** (server-to-server)
3. **Frontend polls for both solve + render status**

```
Frontend → POST /api/generate-and-solve → { task_id: "xyz" }
       ↓
Frontend → GET /api/status/{task_id} → { status: "rendering", progress: 45% }
       ↓
Frontend → GET /api/status/{task_id} → { status: "complete", image_url: "..." }

Meanwhile (server-to-server):
Maze Solver → GPU Renderer (direct HTTP calls)
```

### Option 2: Event-Driven with Pub/Sub
Use Google Cloud Pub/Sub for async communication:

```
Frontend → Maze Solver → [Pub/Sub topic] → GPU Renderer
                       ↓
Frontend ← [WebSocket/SSE] ← Status Updates
```

### Option 3: Shared State via Cloud Storage/Redis
1. Maze Solver writes results to Redis/GCS with task_id
2. GPU Renderer reads from same storage
3. Frontend polls status endpoint

## Recommended Immediate Solution

For deployment today, implement **Option 1** with server-to-server communication:

1. **Backend calls GPU renderer directly** instead of returning data to frontend
2. **Single status endpoint** for frontend polling
3. **Reduced data transfer** and improved performance

This requires minimal changes and works within current Cloud Run architecture.

## Implementation for Today's Deployment

Add to StreamlinedResponse:
- `task_id` for tracking
- `status` with values: "generating", "solving", "rendering", "complete"
- `image_url` when rendering complete

Frontend can poll single endpoint instead of managing two service calls.