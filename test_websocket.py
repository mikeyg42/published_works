#!/usr/bin/env python3
"""
Test WebSocket client to send maze data and handle visualization response.
"""
import asyncio
import json
import uuid
import websockets
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Sample maze data
SAMPLE_MAZE_DATA = {
    "session_id": f"test-{uuid.uuid4().hex[:8]}",
    "largeComponents": [
        {
            "1": ["2", "6"],
            "2": ["1", "3", "7"],
            "3": ["2", "4", "7", "8"],
            "4": ["1", "5", "9"],
            "5": ["4", "9", "10"],
            "6": ["1"],
            "7": ["2", "3"],
            "8": ["3", "9"],
            "9": ["4", "5", "10"],

        },
        {
            "10": ["11", "13"],
            "11": ["10", "12", "14"],
            "12": ["11", "15"],
            "13": ["10", "14"],
            "14": ["11", "13", "15"],
            "15": ["12", "14"]
        }
    ],
    "dimensions": {
        "rows": 5,
        "cols": 5
    }
}

async def test_websocket_connection():
    """Connect to WebSocket server, send data, and handle responses."""
    # Use either the main WebSocket endpoint or the dedicated one
    # uri = "ws://localhost:8000/maze-solver"  # Main WebSocket endpoint
    uri = "ws://localhost:8000/api/ws/solve"   # API router WebSocket endpoint
    
    # Additional headers to simulate a browser request (for CORS)
    headers = {
        "Origin": "http://localhost:4200",  # Pretend we're coming from Angular
        "User-Agent": "Mozilla/5.0 (Test Client)"
    }
    
    try:
        logger.info(f"Connecting to {uri}...")
        async with websockets.connect(uri, extra_headers=headers) as websocket:
            logger.info("Connected successfully")
            
            # Send maze data
            message = json.dumps(SAMPLE_MAZE_DATA)
            logger.info(f"Sending maze data with session_id: {SAMPLE_MAZE_DATA['session_id']}")
            await websocket.send(message)
            
            # Wait for responses
            while True:
                try:
                    response = await websocket.recv()
                    logger.info(f"Received: {response[:100]}...")  # Log first 100 chars
                    
                    # Parse JSON response
                    try:
                        parsed = json.loads(response)
                        
                        # Check for visualization ready message
                        if parsed.get("type") == "visualization_ready":
                            logger.info(f"Visualization URL: {parsed.get('url')}")
                            logger.info(f"Access via: http://localhost:8000/api/visualize/maze/{SAMPLE_MAZE_DATA['session_id']}/latest")
                        
                        # Check if it's the final solution
                        if parsed.get("type") == "solution":
                            logger.info("Received solution")
                    except json.JSONDecodeError:
                        logger.error("Failed to parse response as JSON")
                        
                except websockets.exceptions.ConnectionClosedOK:
                    logger.info("WebSocket connection closed normally")
                    break
                except websockets.exceptions.ConnectionClosedError as e:
                    logger.error(f"WebSocket connection closed with error: {e}")
                    break
                    
    except Exception as e:
        logger.error(f"WebSocket connection error: {e}")

if __name__ == "__main__":
    asyncio.run(test_websocket_connection()) 