# GPU Maze Renderer - Cloud Deployment Guide

## Overview
This directory contains a high-performance GPU-accelerated maze path tracer built with Rust and WebGPU, designed for deployment on Google Cloud Run with NVIDIA T4 GPUs.

## Features
- **WebGPU/Vulkan Backend**: Hardware-accelerated rendering using modern GPU APIs
- **Path Tracing**: Physically accurate lighting simulation
- **HTTP API**: RESTful interface for rendering maze visualizations
- **Scalable**: Auto-scaling Cloud Run service (0-3 instances)
- **Production Ready**: Robust error handling and resource management

## Architecture

### Core Components
- **PathTracer**: Main rendering engine using wgpu crate
- **HTTP Server**: Warp-based REST API for render requests
- **Maze Data**: JSON-based hexagonal maze format support
- **Image Output**: PNG export with proper GPU buffer management

### GPU Requirements
- NVIDIA T4 GPU (Cloud Run)
- Vulkan 1.2+ support
- 8GB VRAM recommended for complex scenes

## API Endpoints

### Health Check
```bash
GET /health
```
Response: `{"status": "healthy", "service": "gpu-maze-renderer"}`

### Render Request
```bash
POST /render
Content-Type: application/json

{
  "maze_data": {
    "hexagons": [...],
    "graph": [[...]],
    "solution": [...],
    "dimensions": {...}
  },
  "width": 1024,      // Optional, default: 1024
  "height": 1024,     // Optional, default: 1024
  "samples": 256      // Optional, default: 256
}
```

Response:
```json
{
  "task_id": "uuid-string",
  "status": "queued",
  "message": "Rendering task queued successfully"
}
```

### Status Check
```bash
GET /status/{task_id}
```

Response:
```json
{
  "task_id": "uuid-string",
  "status": "completed|processing|queued|error",
  "progress": 1.0,
  "image_url": "/image/{task_id}",
  "error": null
}
```

### Image Download
```bash
GET /image/{task_id}
```
Returns the rendered PNG image.

## Deployment

### Prerequisites
1. Google Cloud SDK installed and configured
2. Docker installed
3. Project with Cloud Run and Container Registry APIs enabled
4. GPU quotas requested for your GCP project

### Quick Deploy
```bash
# Set your project ID
export PROJECT_ID="your-gcp-project-id"

# Run deployment script
./deploy.sh
```

### Manual Deployment
```bash
# Build image
docker build -t gcr.io/$PROJECT_ID/gpu-maze-renderer:latest .

# Push to registry
docker push gcr.io/$PROJECT_ID/gpu-maze-renderer:latest

# Deploy to Cloud Run
gcloud run services replace cloud-run-gpu.yaml \
    --region=us-central1 \
    --platform=managed
```

## Configuration

### Environment Variables
- `RUST_LOG`: Log level (default: "info")
- `WGPU_BACKEND`: GPU backend (default: "vulkan")

### Resource Limits
- **CPU**: 2 cores
- **Memory**: 8GB
- **GPU**: 1x NVIDIA T4
- **Timeout**: 10 minutes
- **Concurrency**: 1 request per instance

### Scaling
- **Min Scale**: 0 (scales to zero when idle)
- **Max Scale**: 3 instances
- **Auto-scaling**: Based on request volume

## Performance

### Benchmarks (T4 GPU)
- 1024x1024 @ 256 samples: ~60 seconds
- 512x512 @ 256 samples: ~15 seconds
- Simple mazes (< 100 cells): ~5-10 seconds

### Optimization Features
- Compute shader-based path tracing
- Optimized buffer management
- Async rendering pipeline
- Memory-efficient texture handling

## Development

### Local Testing
```bash
# Build for local testing
cargo build --release

# Run standalone (file output)
./target/release/maze-gpu-renderer --maze test_maze.json --samples 64

# Run server mode
./target/release/maze-gpu-renderer --server
```

### Testing Server Mode
```bash
# Health check
curl http://localhost:8080/health

# Submit render job
curl -X POST http://localhost:8080/render \
  -H "Content-Type: application/json" \
  -d @test_request.json

# Check status
curl http://localhost:8080/status/{task_id}

# Download image
curl http://localhost:8080/image/{task_id} --output result.png
```

## Monitoring & Logging

### Cloud Run Logs
```bash
gcloud logs read --service gpu-maze-renderer \
    --region us-central1 \
    --limit 100
```

### Metrics
- Request latency
- GPU utilization
- Memory usage
- Error rates

## Troubleshooting

### Common Issues
1. **GPU Not Available**: Ensure T4 quota is available in your region
2. **Memory Issues**: Reduce image resolution or sample count
3. **Timeout**: Increase timeout in cloud-run-gpu.yaml
4. **Cold Starts**: First request may take 30-60 seconds

### Debug Commands
```bash
# Check service status
gcloud run services describe gpu-maze-renderer --region us-central1

# View recent logs
gcloud logs read --service gpu-maze-renderer --limit 50

# Test locally with Vulkan
WGPU_BACKEND=vulkan cargo run --release -- --server
```

## Security Notes
- Service currently allows unauthenticated access
- For production, implement proper authentication
- Consider rate limiting for public APIs
- GPU resources are isolated per instance

## Cost Optimization
- Service scales to zero when idle
- GPU instances are more expensive than CPU-only
- Consider using CPU fallback for simple renders
- Monitor usage via Cloud Monitoring