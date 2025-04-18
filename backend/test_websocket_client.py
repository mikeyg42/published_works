#!/usr/bin/env python
"""
WebSocket client for testing maze solver connections
"""
import asyncio
import websockets
import json
import time
import sys
import argparse

# Default timeout in seconds
TIMEOUT_SECONDS = 120

async def test_websocket_connection(url="ws://localhost:8000/maze-solver", timeout=TIMEOUT_SECONDS):
    """Test a websocket connection to the maze solver endpoint"""
    print(f"Connecting to {url}")
    print(f"Connection timeout set to {timeout} seconds")
    
    try:
        # Create a simple test message
        test_message = {
            "type": "test",
            "message": "Hello from test client",
            "timestamp": time.time()
        }
        
        # Connect without extra headers
        async with websockets.connect(url) as websocket:
            print("✅ Connection established")
            
            # Send test message
            await websocket.send(json.dumps(test_message))
            print("✅ Test message sent")
            
            # Wait for a response with timeout
            response_task = asyncio.create_task(websocket.recv())
            try:
                response = await asyncio.wait_for(response_task, timeout=timeout)
                response_data = json.loads(response)
                print(f"✅ Response received: {response_data}")
                
                if response_data.get("type") == "test_response":
                    print("✅ Test PASSED - Server responded correctly to test message")
                    return True
                elif response_data.get("type") == "internal_error":
                    error_msg = response_data.get("error", "No error details provided")
                    print(f"❌ Server reported an error: {error_msg}")
                    print("Check server logs for more details about this error")
                    return False
                else:
                    print(f"❌ Unexpected response type: {response_data.get('type')}")
                    return False
                
            except asyncio.TimeoutError:
                print(f"❌ Response timeout after {timeout} seconds")
                return False
                
    except websockets.exceptions.ConnectionClosedOK as e:
        print(f"ℹ️ Connection closed normally with code {e.code}: {e.reason}")
        return False  # Connection closed too early is a failure for this test
        
    except Exception as e:
        print(f"❌ Error in WebSocket test: {type(e).__name__}: {str(e)}")
        print()
        print("If you see this error frequently:")
        print("1. Check the server logs for errors")
        print("2. Increase the TIMEOUT_SECONDS value in this script")
        print("3. Verify the maze data isn't too complex for the solver")
        print("4. Ensure your server has sufficient memory and CPU resources")
        return False

async def test_minimal_solution(url="ws://localhost:8000/maze-solver", timeout=TIMEOUT_SECONDS):
    """Test sending a minimal maze and getting a solution"""
    print(f"Connecting to {url}")
    print(f"Connection timeout set to {timeout} seconds")
    
    try:
        # Create a very simple test maze that matches the format used by the frontend
        minimal_maze = {
            "allConnComponents": [
                {
                    "adjacencyList": {
                        "1": ["2", "3"],
                        "2": ["1", "4"],
                        "3": ["1", "4"],
                        "4": ["2", "3"]
                    }
                }
            ],
            "dimensions": {
                "rows": 2,
                "cols": 2,
                "hexWidth": 30,
                "hexHeight": 30,
                "padding": {
                    "horizontal": 10,
                    "vertical": 10
                }
            },
            "session_id": f"test_{int(time.time())}"
        }
        
        # Connect without any extra headers
        async with websockets.connect(url) as websocket:
            print("✅ Connection established")
            
            # Send maze data
            await websocket.send(json.dumps(minimal_maze))
            print("✅ Maze data sent")
            
            # Wait for processing_started message
            got_processing_started = False
            got_solution = False
            
            # Loop until we get a solution or timeout
            start_time = time.time()
            while time.time() - start_time < timeout:
                response_task = asyncio.create_task(websocket.recv())
                try:
                    response = await asyncio.wait_for(response_task, timeout=10)
                    data = json.loads(response)
                    
                    if data.get("type") == "processing_started":
                        print("✅ Received processing_started message")
                        got_processing_started = True
                    
                    elif data.get("type") == "solution":
                        print("✅ Received solution")
                        print(f"Solution has {len(data.get('data', []))} components")
                        got_solution = True
                        break
                    
                    elif data.get("type") == "internal_error":
                        error_msg = data.get("error", "No error details provided")
                        print(f"❌ Server reported an error: {error_msg}")
                        print("Check server logs for more details about this error")
                        return False
                        
                    else:
                        print(f"Received message type: {data.get('type')}")
                    
                except asyncio.TimeoutError:
                    if got_processing_started and not got_solution:
                        print("⏳ Still waiting for solution...")
                    else:
                        print("⏳ Waiting for server response...")
            
            if not got_solution:
                print("❌ Test FAILED - Solution was not received")
                return False
                
            print("✅ Test PASSED - Received valid solution")
            return True
                
    except websockets.exceptions.ConnectionClosedOK as e:
        if got_processing_started and not got_solution:
            print(f"⚠️ Connection closed normally, but no solution was received")
            print(f"  Close code: {e.code}, reason: {e.reason}")
            return False
        else:
            print(f"ℹ️ Connection closed normally: {e}")
            return got_solution  # Success depends on if we got a solution first
            
    except Exception as e:
        print(f"❌ Error in WebSocket test: {type(e).__name__}: {str(e)}")
        print()
        print("If you see this error frequently:")
        print("1. Check the server logs for errors")
        print("2. Increase the TIMEOUT_SECONDS value in this script")
        print("3. Verify the maze data isn't too complex for the solver")
        print("4. Ensure your server has sufficient memory and CPU resources")
        return False

async def test_simplest_solution(url="ws://localhost:8000/maze-solver", timeout=TIMEOUT_SECONDS, skip_rust=False):
    """Test sending the simplest possible maze format"""
    print(f"Connecting to {url}")
    print(f"Connection timeout set to {timeout} seconds")
    print(f"Using {'OR-Tools only' if skip_rust else 'both Rust and OR-Tools'}")
    
    try:
        # Create the absolute simplest test maze possible
        simplest_maze = {
            "largeComponents": [
                {
                    "1": ["2"],
                    "2": ["1"]
                }
            ],
            "dimensions": {
                "rows": 1,
                "cols": 2
            },
            "session_id": f"simple_test_{int(time.time())}",
            "skip_rust": skip_rust  # Add this flag to skip Rust solver
        }
        
        # Connect without any extra headers
        async with websockets.connect(url) as websocket:
            print("✅ Connection established")
            
            # Send maze data
            await websocket.send(json.dumps(simplest_maze))
            print(f"✅ Sent data: {json.dumps(simplest_maze)}")
            
            # Track message types we've received
            processing_started = False
            solution_received = False
            error_received = False
            
            # Loop until we get a solution or timeout
            start_time = time.time()
            while time.time() - start_time < timeout:
                try:
                    response_task = asyncio.create_task(websocket.recv())
                    response = await asyncio.wait_for(response_task, timeout=10)
                    print(f"📥 Raw response: {response}")
                    
                    # Try to parse as JSON
                    try:
                        data = json.loads(response)
                        msg_type = data.get("type", "unknown")
                        print(f"📦 Parsed response type: {msg_type}")
                        
                        if msg_type == "processing_started":
                            print("✅ Received processing_started message")
                            processing_started = True
                        
                        elif msg_type == "solution":
                            print("✅ Received solution")
                            print(f"Solution: {data}")
                            solution_received = True
                            return True
                        
                        elif msg_type == "internal_error":
                            error_msg = data.get("error", "No error details provided")
                            print(f"❌ Server reported an error: {error_msg}")
                            print("Check server logs for more details about this error")
                            error_received = True
                            return False
                            
                        else:
                            print(f"Received message type: {msg_type}")
                    
                    except json.JSONDecodeError:
                        print(f"⚠️ Could not parse response as JSON")
                    
                except asyncio.TimeoutError:
                    print("⏳ Waiting for server response...")
                except websockets.exceptions.ConnectionClosed as e:
                    print(f"ℹ️ Connection closed: {e}")
                    break
            
            # Check what happened
            if solution_received:
                print("✅ Test PASSED - Received solution successfully")
                return True
            elif error_received:
                print("❌ Test FAILED - Server reported an error")
                return False
            else:
                print("❌ Test FAILED - Did not receive a proper solution or error")
                return False
                
    except websockets.exceptions.ConnectionClosedOK as e:
        print(f"ℹ️ Connection closed normally with code {e.code}: {e.reason}")
        return False
        
    except Exception as e:
        print(f"❌ Error in WebSocket test: {type(e).__name__}: {str(e)}")
        return False

def check_rust_solver_availability():
    """Check if the Rust solver is available and properly installed."""
    try:
        import importlib
        try:
            solver = importlib.import_module("rust_maze_solver")
            print("✅ Rust solver module found!")
            
            if hasattr(solver, "process_and_solve_maze"):
                print("✅ process_and_solve_maze function found in the Rust module")
                return True
            else:
                print("❌ process_and_solve_maze function NOT found in the Rust module")
                print(f"Available attributes: {dir(solver)}")
                return False
                
        except ImportError as e:
            print(f"❌ Could not import rust_maze_solver: {e}")
            print("Testing for other similarly named modules...")
            
            import pkgutil
            all_modules = [m.name for m in pkgutil.iter_modules()]
            relevant_modules = [m for m in all_modules if 'maze' in m or 'rust' in m or 'solver' in m]
            
            if relevant_modules:
                print(f"Found potentially relevant modules: {relevant_modules}")
            else:
                print("No relevant modules found")
                
            return False
            
    except Exception as e:
        print(f"❌ Error checking Rust solver: {type(e).__name__}: {e}")
        return False

if __name__ == "__main__":
    # Create command line parser
    parser = argparse.ArgumentParser(description="Test the maze solver WebSocket connection")
    parser.add_argument("--url", default="ws://localhost:8000/maze-solver", 
                        help="WebSocket URL to connect to")
    parser.add_argument("--timeout", type=int, default=TIMEOUT_SECONDS,
                        help="Timeout in seconds")
    parser.add_argument("--test", choices=["both", "connect", "solution", "simplest", "or-tools-only", "check-rust"], default="both",
                        help="Which test to run")
    
    args = parser.parse_args()
    
    # Check Rust solver availability if requested
    if args.test == "check-rust":
        print("===== Checking Rust Solver Availability =====")
        check_rust_solver_availability()
        sys.exit(0)
    
    # Run the selected tests
    if args.test in ["both", "connect"]:
        print("===== Testing WebSocket Connection =====")
        asyncio.run(test_websocket_connection(args.url, args.timeout))
    
    if args.test in ["both", "solution"]:
        print("\n===== Testing Minimal Solution =====")
        asyncio.run(test_minimal_solution(args.url, args.timeout))
        
    if args.test == "simplest":
        print("\n===== Testing Simplest Solution =====")
        asyncio.run(test_simplest_solution(args.url, args.timeout))
        
    if args.test == "or-tools-only":
        print("\n===== Testing OR-Tools Only Solution =====")
        asyncio.run(test_simplest_solution(args.url, args.timeout, skip_rust=True)) 