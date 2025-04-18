#!/bin/bash
# Start development server with correct environment settings

# Navigate to project root
cd "$(dirname "$0")"

# Create necessary directories
mkdir -p visualizations/test-session

# Set environment variables for development
export PYTHONPATH=.
export GCS_BUCKET_NAME="maze-solver-visualizations-dev"

# Run FastAPI server
python3 -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000 