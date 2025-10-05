#!/bin/bash

# Start Backend Server Script
# Usage: ./start-backend.sh

set -e

echo "🚀 Starting Backend Server..."

# Navigate to project root
cd "$(dirname "$0")"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "❌ Virtual environment not found. Please run setup first."
    exit 1
fi

# Activate virtual environment
echo "📦 Activating virtual environment..."
source venv/bin/activate

# Set Python path for backend imports
export PYTHONPATH="/home/mg/projects/website:$PYTHONPATH"

# Check if Redis is running (optional for session caching)
if ! pgrep -x "redis-server" > /dev/null; then
    echo "⚠️  Redis not running. Starting Redis server..."
    redis-server --daemonize yes --port 6379
    sleep 2
fi

# Navigate to backend directory and start server
echo "🔧 Starting FastAPI server on http://0.0.0.0:8000"
cd backend
exec uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000