# Maze Solver Visualization

This document explains the maze component visualization feature and how to test it locally.

## Overview

The visualization feature provides a way to verify that the backend correctly identifies the longest paths in maze components. It creates a comprehensive image showing:

1. A grid view of all components with unique colors
2. The longest path through each component highlighted
3. Abstract graph views of each component with paths highlighted

## WebSocket Visualization Flow

When the frontend sends a maze solving request to the backend via WebSocket, the following flow occurs:

1. Client connects to the WebSocket endpoint (`/maze-solver`)
2. Client sends maze data with a `session_id` (or one will be generated)
3. Backend sends a `processing_started` acknowledgment
4. Backend processes the maze and finds the longest paths
5. Backend sends the solution results as a `solution` message
6. Backend asynchronously generates a visualization of the maze and paths
7. Visualization is uploaded to Google Cloud Storage (or saved locally in development)
8. Backend sends a `visualization_ready` message with the URL to the visualization
9. Client can display the visualization using the provided URL or the API endpoint

### WebSocket Message Types

The backend sends the following WebSocket message types:

1. `processing_started` - Initial acknowledgment with session_id
2. `solution` - Contains the solution paths for each component
3. `visualization_ready` - Contains URL to the visualization image
4. `visualization_error` - Sent if visualization generation fails

### Visualization API Endpoint

The visualization can also be accessed via a RESTful API endpoint:

```
GET /api/visualize/maze/{session_id}/latest
```

This endpoint either:
- Redirects to the image in Google Cloud Storage (production)
- Serves the local file directly (development)

## Local Development

### Setup

1. Make sure you have Python 3.x installed
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Start the development server with the provided script:
   ```bash
   ./dev_server.sh
   ```

### Testing Visualization

There are multiple ways to test the visualization feature:

#### Method 1: Using the Comprehensive Test Script

Run the comprehensive WebSocket flow test script:

```bash
python test_visualization_flow.py
```

This script:
- Connects to the WebSocket server
- Sends sample maze data with a test session ID
- Waits for the solution and visualization_ready messages
- Attempts to access the visualization via the API endpoint
- Provides a detailed report of the test results

#### Method 2: Using the Direct Visualization Test

Run the direct visualization test script:

```bash
python test_visualization.py
```

This will:
- Create a sample visualization for test data
- Save it to `visualizations/test-session/`
- Output the URL to access it

#### Method 3: Using WebSocket Test

To test the full flow including WebSocket communication:

```bash
python test_websocket.py
```

This will:
- Connect to the WebSocket server
- Send sample maze data
- Receive the solution
- Wait for the visualization_ready message
- Print the URL to access the visualization

#### Method 4: Using the Test HTML Page

Open `test_visualization.html` in your browser. This page allows you to:
- Enter a session ID (defaults to "test-session")
- View the visualization directly in the browser
- Try different session IDs

## Production Deployment

In production, the visualization images are stored in Google Cloud Storage. You need to:

1. Create a GCS bucket named "maze-solver-visualizations" (or set `GCS_BUCKET_NAME` env var)
2. Grant the Cloud Run service account appropriate permissions
3. Deploy the service to Cloud Run

## How It Works

1. When the backend solves a maze, it sends the solution to the frontend
2. After sending the solution, it generates a visualization asynchronously
3. The visualization is uploaded to GCS (or saved locally in development)
4. A WebSocket message with `type: "visualization_ready"` is sent to the client
5. The client can access the visualization using the API endpoint

## Troubleshooting

If visualizations aren't appearing:

1. Check the server logs for any errors during visualization generation
2. Ensure the session ID is consistent between the WebSocket request and API endpoint
3. Verify that the directory structure exists for local development (`visualizations/{session_id}/`)
4. Check GCS bucket permissions if using production mode
5. Ensure the WebSocket connection remains open long enough to receive the visualization_ready message 