#!/usr/bin/env python3
"""
Test script for the maze solver WebSocket visualization flow.
"""
import asyncio
import websockets
import json
import uuid
import time
import sys
import os
import requests
from urllib.parse import urljoin

# Configuration - adjust as needed
WS_URL = "ws://localhost:8000/maze-solver"
API_BASE_URL = "http://localhost:8000"
TIMEOUT_SECONDS = 120  # Increased timeout to 2 minutes

# Sample maze data - a simple 3x3 grid with one component
SAMPLE_MAZE_DATA = {
    "session_id": f"test_session_{uuid.uuid4().hex[:8]}",
    "largeComponents": [
        {
            "1": ["2", "4"],
            "2": ["1", "3", "5"],
            "3": ["2", "6"],
            "4": ["1", "5", "7"],
            "5": ["2", "4", "6", "8"],
            "6": ["3", "5", "9"],
            "7": ["4", "8"],
            "8": ["5", "7", "9"],
            "9": ["6", "8"]
        }
    ],
    "dimensions": {
        "rows": 2,
        "cols": 5
    }
}

async def test_visualization_flow():
    """Test the WebSocket visualization flow."""
    print(f"Testing WebSocket visualization flow with session ID: {SAMPLE_MAZE_DATA['session_id']}")
    print(f"Connecting to WebSocket at: {WS_URL}")
    
    # Set up WebSocket connection with detailed logging and a longer ping timeout
    try:
        # Using a longer ping_timeout to prevent premature connection closure
        # and adding extra_headers to help with connection tracking
        headers = {
            "User-Agent": "WebSocketTestClient/1.0",
            "X-Test-Session-ID": SAMPLE_MAZE_DATA['session_id']
        }
        
        # More detailed connection attempt logging
        print(f"Opening connection to {WS_URL} with headers: {headers}")
        print(f"Connection timeout set to {TIMEOUT_SECONDS} seconds")
        
        async with websockets.connect(
            WS_URL,
            extra_headers=headers,
            ping_interval=30,  # Send a ping every 30 seconds
            ping_timeout=20,   # Wait 20 seconds for pong response
            close_timeout=10   # Give 10 seconds for graceful closure
        ) as websocket:
            print("Connected to WebSocket server")
            print(f"Local endpoint: {websocket.local_address}")
            print(f"Remote endpoint: {websocket.remote_address}")
            
            # Send maze data
            print("Sending maze data...")
            await websocket.send(json.dumps(SAMPLE_MAZE_DATA))
            print("Data sent successfully, waiting for responses...")
            
            # Track status
            solution_received = False
            visualization_received = False
            visualization_url = None
            
            # Wait for responses (with timeout)
            start_time = time.time()
            timeout = TIMEOUT_SECONDS  # Use the new timeout variable
            
            while time.time() - start_time < timeout:
                try:
                    # Set a timeout for receive operation
                    response = await asyncio.wait_for(websocket.recv(), timeout=5)
                    print(f"Received: {response[:200]}...")
                    
                    # Parse response
                    try:
                        data = json.loads(response)
                        
                        # Check message type
                        if 'type' in data:
                            if data['type'] == 'solution':
                                solution_received = True
                                print("✅ Solution received")
                                
                                # Print solution summary
                                if 'data' in data and isinstance(data['data'], list):
                                    for i, path in enumerate(data['data']):
                                        print(f"  Component {i+1}: Path length = {len(path)}")
                                
                            elif data['type'] == 'visualization_ready':
                                visualization_received = True
                                visualization_url = data.get('url')
                                print(f"✅ Visualization ready at: {visualization_url}")
                                
                                # Also check the API access URL
                                api_url = data.get('access_url')
                                if api_url:
                                    full_api_url = urljoin(API_BASE_URL, api_url)
                                    print(f"  API access URL: {full_api_url}")
                                
                            elif data['type'] == 'internal_error':
                                print(f"❌ Error from server: {data.get('error')}")
                                
                            elif data['type'] == 'processing_started':
                                print(f"ℹ️ Processing started for session: {data.get('session_id')}")
                                
                            else:
                                print(f"ℹ️ Received message of type: {data['type']}")
                    except json.JSONDecodeError:
                        print(f"Failed to parse response as JSON: {response}")
                
                except asyncio.TimeoutError:
                    # No response in 5 seconds, but we'll continue waiting until the total timeout
                    print("Waiting for response...")
                    
                # If we've received both solution and visualization, we're done
                if solution_received and visualization_received:
                    break
            
            # Final status
            print("\nTest Summary:")
            print(f"  Solution received: {'✅ Yes' if solution_received else '❌ No'}")
            print(f"  Visualization received: {'✅ Yes' if visualization_received else '❌ No'}")
            
            # Try to access the visualization API if we have a session ID
            if solution_received and not visualization_received:
                print("\nAttempting to access visualization through API...")
                api_url = f"/api/visualize/maze/{SAMPLE_MAZE_DATA['session_id']}/latest"
                full_api_url = urljoin(API_BASE_URL, api_url)
                
                try:
                    response = requests.get(full_api_url, allow_redirects=False)
                    if response.status_code == 200 or response.status_code == 302:
                        print(f"✅ Visualization available through API at: {full_api_url}")
                        
                        # If it's a redirect, show the destination
                        if response.status_code == 302:
                            print(f"  Redirects to: {response.headers.get('Location')}")
                    else:
                        print(f"❌ API returned status code {response.status_code}")
                        print(f"  Response: {response.text}")
                except Exception as e:
                    print(f"❌ Failed to access API: {str(e)}")
            
            return solution_received, visualization_received, visualization_url
            
    except Exception as e:
        error_type = type(e).__name__
        print(f"❌ Error in WebSocket test: {error_type}: {str(e)}")
        
        if isinstance(e, websockets.exceptions.ConnectionClosedError):
            print(f"Connection closed with code: {e.code}, reason: {e.reason}")
            print("This usually means the server closed the connection unexpectedly.")
            print("Common causes:")
            print("  - Server-side timeout")
            print("  - Process error during maze solving")
            print("  - Memory or resource limits exceeded")
        elif isinstance(e, websockets.exceptions.ConnectionClosedOK):
            print(f"Connection closed normally with code: {e.code}, reason: {e.reason}")
            print("This means the server completed its work but closed before sending all expected messages.")
        elif isinstance(e, websockets.exceptions.WebSocketException):
            print("WebSocket protocol error - check server logs for details")
        elif isinstance(e, asyncio.TimeoutError):
            print("Connection timed out - server did not respond within the timeout period")
        
        # Additional debug info
        print("\nIf you see this error frequently:")
        print("1. Check the server logs for errors")
        print("2. Increase the TIMEOUT_SECONDS value in this script")
        print("3. Verify the maze data isn't too complex for the solver")
        print("4. Ensure your server has sufficient memory and CPU resources")
        
        return False, False, None

if __name__ == "__main__":
    print("=" * 60)
    print("Maze Solver Visualization Flow Test")
    print("=" * 60)
    
    # Run the test
    result = asyncio.run(test_visualization_flow())
    
    # Print final results and exit with appropriate code
    if result[0] and result[1]:  # Both solution and visualization received
        print("\n✅ Test PASSED - Both solution and visualization were received")
        sys.exit(0)
    elif result[0]:  # Only solution received
        print("\n⚠️ Test PARTIAL - Solution was received but visualization was not")
        sys.exit(1)
    else:  # Neither received
        print("\n❌ Test FAILED - Solution was not received")
        sys.exit(2) 