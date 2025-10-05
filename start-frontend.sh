#!/bin/bash

# Start Frontend Server Script
# Usage: ./start-frontend.sh

set -e

echo "🎨 Starting Frontend Server..."

# Navigate to project root
cd "$(dirname "$0")"

# Navigate to frontend directory
cd frontend

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "❌ Node modules not found. Installing dependencies..."
    npm install
fi

# Start Angular development server with SSL
echo "🔧 Starting Angular server on https://localhost:4200"
exec npm start