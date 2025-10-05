#!/bin/bash

# Start Both Development Servers Script
# Usage: ./start-dev-servers.sh

set -e

echo "🚀 Starting Development Environment..."

# Navigate to project root
cd "$(dirname "$0")"

# Make scripts executable
chmod +x start-backend.sh start-frontend.sh

# Start backend in background
echo "🔧 Starting backend server in background..."
./start-backend.sh &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 3

# Start frontend in foreground
echo "🎨 Starting frontend server..."
./start-frontend.sh &
FRONTEND_PID=$!

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down servers..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    exit
}

# Trap signals to cleanup properly
trap cleanup INT TERM

# Wait and show status
echo ""
echo "✅ Both servers starting up!"
echo "📊 Backend:  http://localhost:8000"
echo "🌐 Frontend: https://localhost:4200"
echo ""
echo "Press Ctrl+C to stop both servers"

# Wait for both processes
wait