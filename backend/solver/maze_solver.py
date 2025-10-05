import networkx as nx
from typing import List, Dict
from fastapi import WebSocket
import json
import asyncio
import concurrent.futures
import os
import time
from backend.visualizer.graph_visualizer import GraphVisualizer
from ortools.sat.python import cp_model
from ortools.sat.python.cp_model import CpModel, CpSolver
import random
from contextlib import asynccontextmanager
import threading
import weakref
from backend.utils.gcs_utils import upload_bytes_to_gcs
from datetime import datetime
from typing import Union
import numpy as np
import importlib.util
from redis_cache import cache_maze 


GraphLike = Union[nx.Graph, nx.DiGraph, nx.MultiGraph, dict[str, list[str]]]

class MazeSolver:
    def __init__(self, output_dir: str = "maze_viz"):
        self._image_counter = 0
        self._output_dir = output_dir
        
        # Only create the directory if not running in Cloud Run (or similar env)
        is_cloud_run = os.environ.get("K_SERVICE", None) is not None  # Check if running in Cloud Run
        if not is_cloud_run:
            # Check if the specifivc output_dir exists and create if needed
            if not os.path.exists(self._output_dir):
                try:
                    os.makedirs(self._output_dir, exist_ok=True)
                    print(f"Created output directory: {self._output_dir}")
                except OSError as e:
                    print(f"Error creating directory {self._output_dir}: {e}")
                    self._output_dir = "tmp"
                    pass
 
        self.visualizer = GraphVisualizer(output_dir=self._output_dir, in_memory=is_cloud_run)
        
        # Track active solving tasks
        self._active_tasks = weakref.WeakValueDictionary()
        self._task_lock = asyncio.Lock()
        
        # Initialize queue and processor task
        self._task_queue = asyncio.Queue()
        self._queue_processor_task = None
        
        # Initialize other variables
        self._cancel_events = {}
        self._cancel_locks = {}
        self._thread_pool = concurrent.futures.ThreadPoolExecutor(max_workers=int(os.environ.get("CPU_LIMIT", 4)))
        self._thread_pool_lock = threading.Lock()
        
        # Map of session_id ➜ (original_data, all_solutions) for on-demand visualization
        # NOTE: In-memory only; consider persistence/TTL if large scale
        self._session_store: dict[str, tuple[dict, List[List[str]]]] = {}
    
    async def start_queue_processor(self):
        """Start the queue processor if it's not already running"""
        if self._queue_processor_task is None or self._queue_processor_task.done():
            self._queue_processor_task = asyncio.create_task(self._process_queue())
            
    async def _process_queue(self):
        """Process the queue of maze solving requests"""
        while True:
            try:
                # Get the next task from the queue
                websocket, data, task_id = await self._task_queue.get()
                
                # Check if the websocket is still open before processing
                if websocket.client_state.CONNECTED:
                    print(f"Processing queued task {task_id}")
                    # Process the request and send the result
                    try:
                        result = await self._solve_maze_internal(data, websocket, task_id)
                        if websocket.client_state.CONNECTED:
                            await websocket.send_json(result)
                    except asyncio.CancelledError:
                        print(f"Task {task_id} was cancelled")
                    except Exception as e:
                        print(f"Error processing task {task_id}: {e}")
                        if websocket.client_state.CONNECTED:
                            await websocket.send_json({
                                "type": "internal_error",
                                "error": f"An unexpected error occurred: {str(e)}"
                            })
                else:
                    print(f"Skipping task {task_id} as client disconnected")
                
                # Mark the task as done
                self._task_queue.task_done()
                
            except asyncio.CancelledError:
                # Queue processor itself was cancelled
                print("Queue processor cancelled")
                break
            except Exception as e:
                print(f"Error in queue processor: {e}")
                # Wait a bit before trying again to avoid tight error loops
                await asyncio.sleep(1)
    
    @asynccontextmanager
    async def _register_task(self, websocket, task_id):
        """Context manager to register and unregister a solving task"""
        task = asyncio.current_task()
        try:
            async with self._task_lock:
                self._active_tasks[websocket] = task
            yield
        finally:
            async with self._task_lock:
                self._active_tasks.pop(websocket, None)
    
    async def cancel_tasks_for_websocket(self, websocket):
        """Cancel any running tasks for a specific websocket"""
        async with self._task_lock:
            if websocket in self._active_tasks:
                self._active_tasks[websocket].cancel()
                print(f"Cancelling task for disconnected client")
    
    async def solve_maze(self, data: dict, websocket: WebSocket = None, direct=False):
        """Queue a maze solving request or process directly if direct=True"""
        if direct or websocket is None:
            # Direct call (not via websocket) or explicitly requested direct processing
            # Just solve immediately
            print(f"Direct processing requested for session_id: {data.get('session_id')}")
            return await self._solve_maze_internal(data, websocket, "direct")
        
        # Generate a unique task ID
        task_id = f"task_{int(time.time() * 1000)}"
        
        # Start the queue processor if needed
        await self.start_queue_processor()
        
        # Queue the task
        await self._task_queue.put((websocket, data, task_id))
        
        # Inform client the task was queued
        await websocket.send_json({
            "type": "queued",
            "task_id": task_id,
            "position": self._task_queue.qsize()
        })
        
        # Return immediately - actual processing happens in the queue
        return None
    
    async def _solve_maze_internal(self, data: dict, websocket: WebSocket = None, task_id="task"):
        """Internal method that actually solves the maze"""
        try:
            # Use the context manager to register this task
            if websocket:
                async with self._register_task(websocket, task_id):
                    return await self._solve_maze_implementation(data, websocket, skip_queue_message=True)
            else:
                return await self._solve_maze_implementation(data, websocket, skip_queue_message=True)
        except asyncio.CancelledError:
            print(f"Task {task_id} cancelled during execution")
            raise
        except Exception as e:
            print(f"Error in _solve_maze_internal: {e}")
            raise
    
    async def _solve_maze_implementation(self, data: dict, websocket: WebSocket = None, skip_queue_message=False):
        """The actual implementation of maze solving - moved from solve_maze"""
        try:
            # Inform client task has started processing
            if websocket and not skip_queue_message:
                # Generate a unique task ID
                task_id = f"task_{int(time.time() * 1000)}"
                
                # Inform client the task was queued
                await websocket.send_json({
                    "type": "queued",
                    "task_id": task_id,
                    "position": self._task_queue.qsize()
                })
            
            # Handle restructured data from frontend
            if 'components' not in data:
                # Check if this is the new structure with nested allConnComponents
                if 'allConnComponents' in data:
                    # Extract components from the nested structure
                    print("Received nested component structure, restructuring...")
                    components = []
                    
                    if not isinstance(data['allConnComponents'], list):
                        error_msg = f"'allConnComponents' must be a list, got {type(data['allConnComponents']).__name__}"
                        print(error_msg)
                        if websocket:
                            await websocket.send_json({
                                "type": "internal_error",
                                "error": error_msg
                            })
                        return {"type": "internal_error", "error": error_msg}
                    
                    for comp_data in data['allConnComponents']:
                        if isinstance(comp_data, dict) and 'adjacencyList' in comp_data:
                            if comp_data['adjacencyList'] is not None:
                                components.append(comp_data['adjacencyList'])
                            else:
                                print("Warning: Found None adjacencyList in component, skipping")
                    
                    # Restructure data to expected format
                    data = {
                        'components': components,
                        'dimensions': data.get('dimensions', {}),
                        'session_id': data.get('session_id')  # Preserve session_id during restructuring
                    }
                    print(f"Restructured data contains {len(components)} components")
                    
                    # Check if any components were actually found
                    if not components:
                        error_msg = "No valid components found in allConnComponents"
                        print(error_msg)
                        if websocket:
                            await websocket.send_json({
                                "type": "internal_error",
                                "error": error_msg
                            })
                        return {"type": "internal_error", "error": error_msg}
                else:
                    error_msg = "Missing required field 'components' in input data"
                    print(error_msg)
                    if websocket:
                        await websocket.send_json({
                            "type": "internal_error",
                            "error": error_msg
                        })
                    return {"type": "internal_error", "error": error_msg}
            
            if not data['components']:
                error_msg = "No maze components provided"
                print(error_msg)
                if websocket:
                    await websocket.send_json({
                        "type": "internal_error",
                        "error": error_msg
                    })
                return {"type": "internal_error", "error": error_msg}
            
            # Extract dimensions if available
            dimensions = data.get('dimensions', {})
            rows = dimensions.get('rows')
            cols = dimensions.get('cols')
            print(f"Grid dimensions: {rows} rows x {cols} columns")
            
            # Ensure session_id is present - create one if not provided
            if 'session_id' not in data:
                data['session_id'] = f"session_{int(time.time())}_{random.randint(1000, 9999)}"
                print(f"Generated session_id: {data['session_id']}")
            else:
                print(f"Using provided session_id: {data['session_id']}")
            
            # Standardize dimension keys for visualizer
            viz_dimensions = {
                'rows': rows,
                'cols': cols 
            }
        
            solutions = []
            visualizations = []
            
            # First, identify which components need Rust vs OR-Tools
            small_components = []
            small_indices = []
            large_components = []
            large_indices = []
            
            # Process each component based on size
            try:
                for i, component in enumerate(data['components']):
                    # Skip None components
                    if component is None:
                        print(f"Warning: Component {i} is not a dictionary: {type(component)}")
                        continue
                        
                    # Check if component is a dictionary before using keys
                    if isinstance(component, dict):
                        node_count = len(component.keys())
                        
                        # If skip_rust is True, all components go to OR-Tools
                        if data.get('skip_rust', False):
                            large_components.append(component.copy())
                            large_indices.append(i)
                            print(f"Component {i} using OR-Tools (skip_rust=True)")
                        elif node_count <= 240: 
                            small_components.append(component.copy())
                            small_indices.append(i)
                            print(f"Component {i} using Rust solver")
                        else:
                            large_components.append(component.copy())
                            large_indices.append(i)
                            print(f"Component {i} using OR-Tools solver")
                    else:
                        print(f"Warning: Component {i} is not a dictionary: {type(component)}")
                        # Handle list component case - convert to dict if possible
                        # For example, if the component is a list of connections
                        if isinstance(component, list):
                            # Attempt to convert list to adjacency dict format
                            adj_dict = {}
                            for item in component:
                                if isinstance(item, dict) and 'from' in item and 'to' in item:
                                    from_node = str(item['from'])
                                    to_node = str(item['to'])
                                    
                                    if from_node not in adj_dict:
                                        adj_dict[from_node] = []
                                    if to_node not in adj_dict:
                                        adj_dict[to_node] = []
                                        
                                    adj_dict[from_node].append(to_node)
                                    adj_dict[to_node].append(from_node)
                            
                            # Add the converted component
                            if adj_dict:
                                node_count = len(adj_dict)
                                if node_count <= 250:
                                    small_components.append(adj_dict)
                                    small_indices.append(i)
                                else:
                                    large_components.append(adj_dict)
                                    large_indices.append(i)
            except Exception as e:
                error_msg = f"Error processing components: {str(e)}"
                print(error_msg)
                if websocket:
                    await websocket.send_json({
                        "type": "internal_error",
                        "error": error_msg
                    })
                return {"type": "internal_error", "error": error_msg}
                
            # Ensure we have at least some valid components
            if not small_components and not large_components:
                error_msg = "No valid components found to process"
                print(error_msg)
                if websocket:
                    await websocket.send_json({
                        "type": "internal_error",
                        "error": error_msg
                    })
                return {"type": "internal_error", "error": error_msg}
            
            # Check for cancellation
            if websocket and not websocket.client_state.CONNECTED:
                print("Client disconnected, cancelling computation")
                raise asyncio.CancelledError("Client disconnected")
            
            # Check if we're skipping the Rust solver
            skip_rust = data.get('skip_rust', False)
            
            # First check if rust solver is available
            try:
                rust_spec = importlib.util.find_spec("rust_maze_solver")
                rust_available = rust_spec is not None
                if not rust_available:
                    print("Warning: rust_maze_solver module not found, using OR-Tools for all components")
                    skip_rust = True
            except Exception as e:
                print(f"Error checking for Rust solver: {e}")
                skip_rust = True
            
            # Launch both solvers concurrently
            small_task = None
            large_task = None
            loop = asyncio.get_running_loop()
            
            # Create task for small components (Rust)
            if small_components and not skip_rust:
                # Create a Rust-compatible data structure
                rust_data = {
                    'components': small_components
                }
                json_small_data = json.dumps(rust_data)
                
                # Launch Rust solver as async task
                small_task = asyncio.create_task(self._run_rust_solver(json_small_data, loop, websocket))
                print(f"Launched Rust solver for {len(small_components)} components")
            else:
                if small_components:
                    print(f"Skipping Rust solver for {len(small_components)} components (using OR-Tools instead)")
                    # If skip_rust is True, move small components to large_components
                    large_components.extend(small_components)
                    large_indices.extend(small_indices)
                    small_components = []
                    small_indices = []
                
                print("No small components for Rust solver")
                small_task = asyncio.create_task(asyncio.sleep(0))  # Dummy task
            
            # Create task for large components (OR-Tools)
            if large_components:
                # Launch OR-Tools solver as async task
                large_task = asyncio.create_task(self._run_ortools_solver(large_components, large_indices, dimensions, websocket))
                print(f"Launched OR-Tools solver for {len(large_components)} components")
            else:
                print("No large components for OR-Tools solver")
                large_task = asyncio.create_task(asyncio.sleep(0))  # Dummy task
            
            # Wait for both tasks to complete
            try:
                small_solutions, or_tools_solutions = await asyncio.gather(
                    small_task, large_task, 
                    return_exceptions=True  # Don't let one failure cancel the other task
                )
                
                # Handle possible exceptions from tasks
                rust_failed = False
                if isinstance(small_solutions, Exception):
                    if isinstance(small_solutions, asyncio.CancelledError):
                        raise small_solutions
                    print(f"Rust solver failed: {small_solutions}")
                    rust_failed = True
                    small_solutions = [[] for _ in small_components]
                
                or_tools_failed = False
                if isinstance(or_tools_solutions, Exception):
                    if isinstance(or_tools_solutions, asyncio.CancelledError):
                        raise or_tools_solutions
                    print(f"OR-Tools solver failed: {or_tools_solutions}")
                    or_tools_failed = True
                    or_tools_solutions = [[] for _ in large_components]
                
                # --- Fallback mechanisms ---
                # If Rust solver failed during execution (after successful import),
                # try OR-Tools on the small components as a fallback.
                # Note: If the *initial* import failed, components were already moved.
                if rust_failed and small_components:
                    print("Trying OR-Tools as fallback for Rust solver...")
                    fallback_task = asyncio.create_task(self._run_ortools_solver(
                        small_components, small_indices, dimensions, websocket))
                    
                    try:
                        small_solutions = await fallback_task
                        print(f"OR-Tools fallback succeeded for {len(small_components)} components")
                    except Exception as e:
                        print(f"OR-Tools fallback failed: {e}")
                        small_solutions = [[] for _ in small_components]
                
                # If OR-Tools failed, try Rust for components under 350 nodes
                if or_tools_failed and large_components:
                    small_enough_components = []
                    small_enough_indices = []
                    too_large_components = []
                    too_large_indices = []
                    
                    # Filter components under 350 nodes
                    for i, component in enumerate(large_components):
                        if len(component) < 350:
                            small_enough_components.append(component)
                            small_enough_indices.append(large_indices[i])
                        else:
                            too_large_components.append(component)
                            too_large_indices.append(large_indices[i])
                    
                    if small_enough_components:
                        print(f"Trying Rust as fallback for {len(small_enough_components)} OR-Tools components...")
                        
                        # Create a Rust-compatible data structure
                        rust_data = {
                            'components': small_enough_components
                        }
                        json_fallback_data = json.dumps(rust_data)
                        
                        try:
                            loop = asyncio.get_running_loop()
                            fallback_solutions = await self._run_rust_solver(json_fallback_data, loop, websocket)
                            
                            # Insert fallback solutions
                            for idx, sol_idx in enumerate(small_enough_indices):
                                if idx < len(fallback_solutions):
                                    pos = large_indices.index(sol_idx)
                                    or_tools_solutions[pos] = fallback_solutions[idx]
                            
                            print(f"Rust fallback succeeded for {len(small_enough_components)} components")
                        except Exception as e:
                            print(f"Rust fallback failed: {e}")
                            
                    if too_large_components:
                        for comp_idx, comp in zip(too_large_indices, too_large_components):
                            # build graph
                            G = nx.Graph(comp)

                            # numpy-based degree filter for degree==2
                            nodes = np.array(list(comp.keys()))
                            degs = np.array([len(comp[n]) for n in nodes], dtype=int)
                            # articulation + degree==2
                            art_pts = set(nx.articulation_points(G))
                            cand = nodes[(degs == 2) & np.isin(nodes, list(art_pts))]

                            # balance threshold
                            n_nodes = len(nodes)
                            threshold = max(1, n_nodes // 10)

                            def piece_size_after_removal(rem, start):
                                idx_map = {n:i for i,n in enumerate(nodes)}
                                visited = np.zeros(n_nodes, bool)
                                visited[idx_map[rem]] = True
                                stack = [idx_map[start]]
                                count = 0
                                while stack:
                                    u = stack.pop()
                                    count += 1
                                    for nbr in comp[nodes[u]]:
                                        j = idx_map[nbr]
                                        if not visited[j]:
                                            visited[j] = True
                                            stack.append(j)
                                return count

                            filtered = []
                            for cut in cand:
                                nbrs = list(G.neighbors(cut))
                                size1 = piece_size_after_removal(cut, nbrs[0])
                                size2 = n_nodes - 1 - size1
                                if size1 >= threshold and size2 >= threshold:
                                    filtered.append(cut)

                            best = []
                            for cut in filtered:
                                G.remove_node(cut)
                                parts = list(nx.connected_components(G))
                                if len(parts) != 2:
                                    G = nx.Graph(comp)
                                    continue
                                sol_parts = []
                                for part in parts:
                                    sub_adj = {n: [nbr for nbr in comp[n] if nbr in part] for n in part}
                                    sol = self._solve_with_cp_sat_fixed_start(sub_adj, start_node=cut)
                                    if not sol:
                                        break
                                    sol_parts.append(sol)
                                if len(sol_parts) == 2:
                                    merged = sol_parts[0] + sol_parts[1][::-1][1:]
                                    if len(merged) > len(best):
                                        best = merged
                                G = nx.Graph(comp)
                            or_tools_solutions[large_indices.index(comp_idx)] = best

                        
            except asyncio.CancelledError:
                print("Main computation cancelled")
                raise
            except Exception as e:
                print(f"Error waiting for solvers: {e}")
                # Provide empty results if both failed
                small_solutions = [[] for _ in small_components]
                or_tools_solutions = [[] for _ in large_components]
            
            # Check for cancellation again
            if websocket and not websocket.client_state.CONNECTED:
                print("Client disconnected, cancelling before result processing")
                raise asyncio.CancelledError("Client disconnected")
            
            # Make sure results are lists
            if small_solutions is None:
                print("WARNING: small_solutions is None, using empty list")
                small_solutions = []
            
            if or_tools_solutions is None:
                print("WARNING: or_tools_solutions is None, using empty list")
                or_tools_solutions = []
            
            # Merge solutions from both solvers
            all_solutions = [None] * len(data['components'])
            
            # Handle edge cases where indices might be empty
            if not small_indices and not large_indices:
                print("WARNING: No indices found for components, returning empty solution")
                all_solutions = []
            else:
                # Insert small component solutions
                for i, idx in enumerate(small_indices):
                    if i < len(small_solutions) and idx < len(all_solutions):
                        all_solutions[idx] = small_solutions[i]
                
                # Insert large component solutions
                for i, idx in enumerate(large_indices):
                    if i < len(or_tools_solutions) and idx < len(all_solutions):
                        all_solutions[idx] = or_tools_solutions[i]
            
            # If we processed all components with Rust (no large components),
            # ensure the solutions array is properly filled
            if not large_components and small_indices:
                print(f"All {len(small_indices)} components were processed by Rust")
                
                # If the array still has None values, the indices might be mismatched
                if None in all_solutions:
                    print("Warning: Some solutions are None, reconstructing array")
                    # Create a mapping of original indices to solutions
                    solution_map = {idx: sol for idx, sol in zip(small_indices, small_solutions) if idx < len(all_solutions)}
                    # Rebuild the all_solutions array
                    all_solutions = [solution_map.get(i, []) for i in range(len(data['components']))]
            
            # Ensure no null values in the array
            all_solutions = [solution if solution is not None else [] for solution in all_solutions]
            
            # Log solution summary
            solution_lengths = [len(sol) if sol else 0 for sol in all_solutions]
            print(f"Final solution lengths: {solution_lengths}")

            # Cache in Redis for later /visualize/generate requests
            if data.get("session_id"): await cache_maze(data["session_id"], data, all_solutions)

            
            # Schedule component report generation as a background task
            # This will happen after we return the solutions to the client
            if websocket and websocket.client_state.CONNECTED:
                # Only send solution; visualization can be requested separately via REST
                await websocket.send_json({
                    "type": "solution",
                    "data": all_solutions,
                    "session_id": data.get('session_id')
                })
                return {"type": "websocket_handled"}
            else:
                # This is the REST/direct call path
                print("REST/direct call path - generating visualization without WebSocket")
                session_id = data.get('session_id', f"session_{int(time.time())}_{random.randint(1000, 9999)}")
                
                return {
                    "session_id": session_id,
                    "data": all_solutions
                }
            
        except asyncio.CancelledError:
            print("Maze solving cancelled by client disconnect")
            # Re-raise to allow cancellation handling upstream if necessary
            raise 
        except Exception as e:
            error_message = f"An unexpected error occurred: {str(e)}"
            print(f"Solver error: {error_message}")
            # For REST calls, we might want to raise an HTTPException here,
            # but for now, just re-raising to be handled by the caller in main.py
            raise
    
    async def _run_rust_solver(self, json_data, loop, websocket=None):
        """Run Rust solver asynchronously with timeout protection and cancellation"""
        try:
            def check_cancelled():
                # Check if websocket is still connected
                if websocket and not websocket.client_state.CONNECTED:
                    raise asyncio.CancelledError("Client disconnected")
            
            # Initial cancellation check
            check_cancelled()
            
            # Validate the json_data before passing to Rust
            try:
                # Parse and validate the json data
                parsed_data = json.loads(json_data)
                if not isinstance(parsed_data, dict):
                    raise ValueError(f"Expected dictionary, got {type(parsed_data).__name__}")
                
                if 'components' not in parsed_data:
                    raise ValueError("Missing 'components' in data")
                
                if not isinstance(parsed_data['components'], list):
                    raise ValueError(f"'components' must be a list, got {type(parsed_data['components']).__name__}")
                
                if not parsed_data['components']:
                    raise ValueError("'components' list is empty")
                
                # Ensure each component is valid
                for i, component in enumerate(parsed_data['components']):
                    if not isinstance(component, dict):
                        raise ValueError(f"Component {i} is not a dictionary")
                    
                    if not component:
                        raise ValueError(f"Component {i} is empty")
                    
                    # Check that keys and values are as expected
                    for key, value in component.items():
                        if not isinstance(value, list):
                            raise ValueError(f"Component {i}, neighbors of node {key} is not a list")
            except json.JSONDecodeError as e:
                raise ValueError(f"Invalid JSON: {str(e)}")
            except ValueError as e:
                raise ValueError(f"Invalid data structure: {str(e)}")
            
            # Use ThreadPoolExecutor for the CPU-bound Rust code
            with concurrent.futures.ThreadPoolExecutor() as pool:
                # Create a task that periodically checks if the client is still connected
                if websocket:
                    cancel_checker = asyncio.create_task(self._periodic_cancel_check(websocket))
                
                try:
                    # Import the Rust function just-in-time to handle import errors gracefully
                    try:
                        # We need to import this here to avoid problems with circular imports
                        import importlib.util
                        spec = importlib.util.find_spec("rust_maze_solver")
                        if spec is None:
                            print("rust_maze_solver module not found. Using fallback to OR-Tools...")
                            
                            # Extract components from the JSON data
                            components = parsed_data['components']
                            indices = list(range(len(components)))
                            
                            # Use OR-Tools as a fallback
                            return await self._run_ortools_solver(components, indices, {}, websocket)
                        
                        # If rust_maze_solver is found, import it
                        rust_module = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(rust_module)
                        
                        if not hasattr(rust_module, "process_and_solve_maze"):
                            print("rust_maze_solver module found but process_and_solve_maze function is missing")
                            raise ImportError("process_and_solve_maze function not found in rust_maze_solver module")
                        
                        rust_solver = rust_module.process_and_solve_maze
                        
                        # Debug print to confirm we found the right module and function
                        print(f"Successfully imported Rust solver: {rust_solver}")
                    except ImportError as e:
                        print(f"Error importing Rust solver: {str(e)}")
                        print(f"Python path: {os.environ.get('PYTHONPATH', 'Not set')}")
                        print(f"Current directory: {os.getcwd()}")
                        
                        # List available modules to debug
                        print("Attempting to find rust_maze_solver module...")
                        import pkgutil
                        all_modules = [m.name for m in pkgutil.iter_modules()]
                        if 'rust_maze_solver' in all_modules:
                            print("'rust_maze_solver' module found in available modules!")
                        else:
                            print("'rust_maze_solver' module NOT found in available modules.")
                            print(f"Available modules that might be relevant: {[m for m in all_modules if 'maze' in m or 'rust' in m]}")
                            
                            # Extract components from the JSON data
                            components = parsed_data['components']
                            indices = list(range(len(components)))
                            
                            # Use OR-Tools as a fallback
                            return await self._run_ortools_solver(components, indices, {}, websocket)
                        
                        raise ValueError(f"Rust solver module not available: {str(e)}")
                    
                    # Execute the Rust solver with the validated data
                    result = await asyncio.wait_for(
                        loop.run_in_executor(pool, lambda: rust_solver(json_data)),
                        timeout=360  # 6 minute timeout
                    )
                    
                    # Check that the result is valid
                    if not isinstance(result, list):
                        raise ValueError(f"Expected list result from Rust solver, got {type(result).__name__}")
                    
                    # Final cancellation check before returning
                    check_cancelled()
                    return result
                    
                finally:
                    # Clean up the cancel checker if it exists
                    if websocket:
                        cancel_checker.cancel()
                        try:
                            await cancel_checker
                        except asyncio.CancelledError:
                            pass
                    
        except asyncio.TimeoutError:
            print("Timeout in Rust solver")
            raise
        except asyncio.CancelledError:
            print("Rust solver cancelled")
            raise
        except Exception as e:
            print(f"Error in Rust solver: {str(e)}")
            raise
    
    async def _periodic_cancel_check(self, websocket, interval=1.0):
        """Periodically check if the client is still connected"""
        try:
            while True:
                if not websocket.client_state.CONNECTED:
                    # Client disconnected, raise CancelledError to interrupt parent task
                    print("Client disconnected, cancelling computation")
                    # Find and cancel the parent task
                    for task in asyncio.all_tasks():
                        if task != asyncio.current_task():
                            task.cancel()
                    raise asyncio.CancelledError("Client disconnected")
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            # This task itself was cancelled, which is expected
            pass
    
    async def _run_ortools_solver(self, components, indices, dimensions, websocket=None):
        """Run OR-Tools solver asynchronously with cancellation support"""
        try:
            # Validate inputs
            if components is None:
                print("WARNING: components is None!")
                return []
                
            if not components:
                print("WARNING: components list is empty!")
                return []
                
            if indices is None:
                print("WARNING: indices is None!")
                return []
                
            if not indices:
                print("WARNING: indices list is empty!")
                return []
                
            # Validate each component before processing
            valid_components = []
            valid_indices = []
            
            for i, (idx, component) in enumerate(zip(indices, components)):
                if component is None:
                    print(f"WARNING: Component at position {i} (index {idx}) is None, skipping")
                    continue
                    
                if not isinstance(component, dict):
                    print(f"WARNING: Component at position {i} (index {idx}) is not a dictionary, skipping")
                    continue
                    
                if not component:
                    print(f"WARNING: Component at position {i} (index {idx}) is empty, skipping")
                    continue
                    
                valid_components.append(component)
                valid_indices.append(idx)
            
            if not valid_components:
                print("WARNING: No valid components to process!")
                return []
            
            print(f"OR-Tools processing {len(valid_components)} valid components")
            
            # Create a thread pool for parallel processing
            results = []
            cancel_event = threading.Event()  # For signaling cancellation to threads
            
            with concurrent.futures.ThreadPoolExecutor() as executor:
                # Create futures for each component
                futures = []
                for idx, component in zip(valid_indices, valid_components):
                    futures.append(executor.submit(
                        self._solve_component, component, idx, dimensions, cancel_event
                    ))
                
                # Gather results as they complete
                for future in concurrent.futures.as_completed(futures):
                    # Check if websocket is still connected
                    if websocket and not websocket.client_state.CONNECTED:
                        print("Client disconnected during OR-Tools processing")
                        cancel_event.set()  # Signal all threads to stop
                        raise asyncio.CancelledError("Client disconnected")
                    
                    try:
                        result = future.result()
                        results.append(result)
                    except Exception as e:
                        print(f"Error in OR-Tools component: {str(e)}")
                        results.append([])  # Add an empty path for this component
            
            # Make sure we have the right number of results
            while len(results) < len(valid_components):
                results.append([])
                
            # Map results back to original indices
            final_results = []
            for i in range(max(indices) + 1 if indices else 0):
                if i in valid_indices:
                    idx = valid_indices.index(i)
                    if idx < len(results):
                        final_results.append(results[idx])
                    else:
                        final_results.append([])
                else:
                    final_results.append([])
                    
            return final_results
            
        except asyncio.CancelledError:
            print("OR-Tools solver cancelled")
            if 'cancel_event' in locals():
                cancel_event.set()  # Signal all threads to stop
            raise
        except Exception as e:
            print(f"Error in OR-Tools solver: {str(e)}")
            import traceback
            traceback.print_exc()
            return []  # Return empty results on error
        
    def _solve_component(self, adjacency_dict, component_idx, dimensions=None, cancel_event=None):
        """Solve a single component with cancellation support"""
        try:
            start_time = time.time()
            print(f"Solving component {component_idx} with {len(adjacency_dict)} nodes")
            
            # Check for cancellation
            if cancel_event and cancel_event.is_set():
                print(f"Component {component_idx} cancelled before processing")
                return []
            
            # Try different solution strategies and return the best one
            solutions = []
            
            # 1. First try the rank-based approach for better global optimization
            start_algo_time = time.time()
            rank_solution = self._solve_with_ranking(adjacency_dict, component_idx, cancel_event)
            rank_time = time.time() - start_algo_time
            if rank_solution:
                solutions.append((rank_solution, "rank-based", rank_time))
                print(f"Rank-based solution found path of length {len(rank_solution)} in {rank_time:.2f}s")
            
            # Check for cancellation
            if cancel_event and cancel_event.is_set():
                print(f"Component {component_idx} cancelled after rank-based solution")
                return rank_solution if solutions else []
            
            # 2. Also try the previous edge-based approach as a fallback
            if time.time() - start_time < 40:  # If we have time left
                start_algo_time = time.time()
                edge_solution = self._solve_with_edge_model(adjacency_dict, component_idx, cancel_event)
                edge_time = time.time() - start_algo_time
                if edge_solution:
                    solutions.append((edge_solution, "edge-based", edge_time))
                    print(f"Edge-based solution found path of length {len(edge_solution)} in {edge_time:.2f}s")
            
            # Check for cancellation
            if cancel_event and cancel_event.is_set():
                print(f"Component {component_idx} cancelled after edge-based solution")
                return max(solutions, key=lambda x: len(x[0]))[0] if solutions else []
            
            # 3. If we have time, also try beam search to complement other approaches
            if time.time() - start_time < 45:  # Leave at least 15s for beam search
                start_algo_time = time.time()
                beam_solution = self._beam_search_longest_path(adjacency_dict, cancel_event)
                beam_time = time.time() - start_algo_time
                if beam_solution:
                    solutions.append((beam_solution, "beam search", beam_time))
                    print(f"Beam search solution found path of length {len(beam_solution)} in {beam_time:.2f}s")
            
            # Return the best solution
            if not solutions:
                print(f"No solution found for component {component_idx}")
                return []
                
            # Find best solution based on path length
            best_solution, best_algo, best_time = max(solutions, key=lambda x: len(x[0]))
            component_size = len(adjacency_dict)
            print(f"Component {component_idx}: Best solution from {best_algo} algorithm with length {len(best_solution)}/{component_size} nodes ({len(best_solution)/component_size:.1%}) in {best_time:.2f}s")
            
            # Validate the final solution
            self._validate_path(adjacency_dict, best_solution)
            
            return best_solution
            
        except Exception as e:
            print(f"Error solving component {component_idx}: {str(e)}")
            import traceback
            traceback.print_exc()
            return []
    
    def _solve_with_edge_model(self, adjacency_dict, component_idx, cancel_event=None):
        """Legacy edge-based approach, kept as a fallback."""
        try:
            start_time = time.time()
            
            # Convert adjacency dict to a flat list of edges for CP-SAT
            edges = []
            node_to_index = {}
            
            # Assign each node a numeric index
            for i, node in enumerate(adjacency_dict.keys()):
                node_to_index[node] = i
            
            # Add edges (ensuring all vertices have an index)
            for node, neighbors in adjacency_dict.items():
                for neighbor in neighbors:
                    if neighbor in node_to_index:
                        edges.append((node_to_index[node], node_to_index[neighbor]))
            
            # Create the solver
            model = CpModel()
            
            # Variables: for each edge, whether it's in the path
            edge_vars = {}
            for i, edge in enumerate(edges):
                edge_vars[i] = model.NewBoolVar(f'edge_{i}')
            
            # Variables: for each vertex, whether it's in the path
            vertex_vars = {}
            for node in node_to_index:
                vertex_idx = node_to_index[node]
                vertex_vars[vertex_idx] = model.NewBoolVar(f'vertex_{vertex_idx}')
            
            # For each vertex, either 0, 1, or 2 incident edges must be used
            # (0 = not in path, 2 = in middle of path, 1 = endpoint)
            for node in node_to_index:
                node_idx = node_to_index[node]
                # Get all edges incident to this vertex
                incident_edges = []
                for i, (u, v) in enumerate(edges):
                    if u == node_idx or v == node_idx:
                        incident_edges.append(edge_vars[i])
                
                # If vertex is used, it must have 1 or 2 incident edges
                if incident_edges:
                    model.Add(sum(incident_edges) <= 2)
                    # Connect vertex_var with incident edges
                    model.Add(sum(incident_edges) >= vertex_vars[node_idx])
                    model.Add(sum(incident_edges) <= 2 * vertex_vars[node_idx])
                else:
                    # Isolated vertex can't be in path
                    model.Add(vertex_vars[node_idx] == 0)
            
            # Objective: maximize total vertices in path
            model.Maximize(sum(vertex_vars.values()))
            
            # Add randomization to avoid local minima
            solver = CpSolver()
            solver.parameters.max_time_in_seconds = 30.0  # 30 second timeout
            solver.parameters.randomize_search = True
            solver.parameters.random_seed = int(time.time() * 1000) % 10000
            
            status = solver.Solve(model)
            
            # Process results
            if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
                # Find the endpoints (vertices with exactly one incident edge)
                endpoints = []
                for node in node_to_index:
                    node_idx = node_to_index[node]
                    if solver.Value(vertex_vars[node_idx]) == 1:
                        # Count incident edges that are in the solution
                        incident_count = 0
                        for i, (u, v) in enumerate(edges):
                            if (u == node_idx or v == node_idx) and solver.Value(edge_vars[i]) == 1:
                                incident_count += 1
                        
                        if incident_count == 1:
                            endpoints.append(node_idx)
                
                # Reconstruct the path from one endpoint to the other
                path = []
                if len(endpoints) != 2:
                    print(f"Edge model for component {component_idx}: Found {len(endpoints)} endpoints. expected 2")
                    return []
                else:
                    # Start with one endpoint
                    current = endpoints[0]
                    path.append(current)
                    visited = set([current])
                    
                    # Keep adding vertices until we reach the other endpoint
                    while current != endpoints[1]:
                        found_next = False
                        for i, (u, v) in enumerate(edges):
                            if solver.Value(edge_vars[i]) == 1:
                                if u == current and v not in visited:
                                    current = v
                                    path.append(current)
                                    visited.add(current)
                                    found_next = True
                                    break
                                elif v == current and u not in visited:
                                    current = u
                                    path.append(current)
                                    visited.add(current)
                                    found_next = True
                                    break
                        
                        if not found_next:
                            # We hit a dead end - this shouldn't happen with valid solutions
                            print("Error in path reconstruction: hit dead end")
                            break
                
                # Convert back to original node IDs
                index_to_node = {idx: node for node, idx in node_to_index.items()}
                path_with_node_ids = [index_to_node[idx] for idx in path]
                
                # If path is valid, return it
                if self._validate_path(adjacency_dict, path_with_node_ids):
                    elapsed = time.time() - start_time
                    print(f"Edge model for component {component_idx}: Found path of length {len(path_with_node_ids)} in {elapsed:.2f}s")
                    return path_with_node_ids
                else:
                    print(f"Edge model for component {component_idx}: Invalid path")
                    return []
            else:
                print(f"Component {component_idx}: Edge model found no solution")
                return []
        except Exception as e:
            print(f"Error in edge-based solver: {str(e)}")
            import traceback
            traceback.print_exc()
            return []
    
    def _solve_with_ranking(self, adjacency_dict, component_idx, cancel_event=None):
        """Use a rank-based CP-SAT formulation to find the longest path."""
        try:
            start_time = time.time()
            
            # Convert adjacency dict to a graph representation
            G = nx.Graph()
            for node, neighbors in adjacency_dict.items():
                for neighbor in neighbors:
                    G.add_edge(node, neighbor)
            
            # Mapping between nodes and indices
            nodes = list(adjacency_dict.keys())
            node_to_idx = {node: i for i, node in enumerate(nodes)}
            idx_to_node = {i: node for node, i in node_to_idx.items()}
            
            # Create the model
            model = CpModel()
            
            # 1. Variables for each node:
            # - in_path[i] = whether node i is in the path
            # - rank[i] = position of node i in the path (or -1 if not in path)
            in_path = {}
            rank = {}
            num_nodes = len(nodes)
            
            for i, node in enumerate(nodes):
                in_path[i] = model.NewBoolVar(f'in_path_{i}')
                # Rank goes from 0 to num_nodes-1 (or -1 if not in path)
                rank[i] = model.NewIntVar(-1, num_nodes-1, f'rank_{i}')
                
                # Connect in_path and rank variables
                model.Add(rank[i] >= 0).OnlyEnforceIf(in_path[i])
                model.Add(rank[i] == -1).OnlyEnforceIf(in_path[i].Not())
            
            # 2. Path consistency constraints:
            # - Each rank 0 to path_length-1 appears exactly once
            # - Nodes with consecutive ranks must be connected in the graph
            # - No gaps in ranks
            
            # Each rank can be assigned to at most one node
            for r in range(num_nodes):
                rank_indicators = []
                for i in range(num_nodes):
                    has_rank_r = model.NewBoolVar(f'node_{i}_has_rank_{r}')
                    model.Add(rank[i] == r).OnlyEnforceIf(has_rank_r)
                    model.Add(rank[i] != r).OnlyEnforceIf(has_rank_r.Not())
                    rank_indicators.append(has_rank_r)
                model.Add(sum(rank_indicators) <= 1)
            
            # We must have rank 0 if any node is in the path
            rank0_indicators = []
            for i in range(num_nodes):
                has_rank_0 = model.NewBoolVar(f'node_{i}_has_rank_0')
                model.Add(rank[i] == 0).OnlyEnforceIf(has_rank_0)
                model.Add(rank[i] != 0).OnlyEnforceIf(has_rank_0.Not())
                rank0_indicators.append(has_rank_0)
            
            path_exists = model.NewBoolVar('path_exists')
            model.Add(sum(in_path.values()) >= 1).OnlyEnforceIf(path_exists)
            model.Add(sum(in_path.values()) == 0).OnlyEnforceIf(path_exists.Not())
            model.Add(sum(rank0_indicators) == 1).OnlyEnforceIf(path_exists)
            
            # No gaps in ranks
            for r in range(1, num_nodes):
                # If rank r is used, rank r-1 must also be used
                has_rank_r = []
                for i in range(num_nodes):
                    indicator = model.NewBoolVar(f'node_{i}_has_rank_{r}')
                    model.Add(rank[i] == r).OnlyEnforceIf(indicator)
                    model.Add(rank[i] != r).OnlyEnforceIf(indicator.Not())
                    has_rank_r.append(indicator)
                
                has_rank_prev = []
                for i in range(num_nodes):
                    indicator = model.NewBoolVar(f'node_{i}_has_rank_{r-1}')
                    model.Add(rank[i] == r-1).OnlyEnforceIf(indicator)
                    model.Add(rank[i] != r-1).OnlyEnforceIf(indicator.Not())
                    has_rank_prev.append(indicator)
                
                rank_r_exists = model.NewBoolVar(f'rank_{r}_exists')
                model.Add(sum(has_rank_r) >= 1).OnlyEnforceIf(rank_r_exists)
                model.Add(sum(has_rank_r) == 0).OnlyEnforceIf(rank_r_exists.Not())
                
                # If rank r exists, rank r-1 must exist
                model.Add(sum(has_rank_prev) >= 1).OnlyEnforceIf(rank_r_exists)
            
            # 3. Consecutive ranks must be connected in the graph
            adjacency_matrix = {}
            for node, neighbors in adjacency_dict.items():
                i = node_to_idx[node]
                for neighbor in neighbors:
                    if neighbor in node_to_idx:  # Ensure the neighbor is valid
                        j = node_to_idx[neighbor]
                        adjacency_matrix[(i, j)] = True
                        adjacency_matrix[(j, i)] = True
            
            for i in range(num_nodes):
                for j in range(num_nodes):
                    if i != j:
                        i_then_j = model.NewBoolVar(f'consecutive_{i}_then_{j}')
                        
                        # For all possible ranks r, if i has rank r and j has rank r+1,
                        # then i_then_j must be true
                        for r in range(num_nodes - 1):
                            i_has_r = model.NewBoolVar('')
                            j_has_r_plus_1 = model.NewBoolVar('')
                            
                            model.Add(rank[i] == r).OnlyEnforceIf(i_has_r)
                            model.Add(rank[i] != r).OnlyEnforceIf(i_has_r.Not())
                            
                            model.Add(rank[j] == r + 1).OnlyEnforceIf(j_has_r_plus_1)
                            model.Add(rank[j] != r + 1).OnlyEnforceIf(j_has_r_plus_1.Not())
                            
                            both_consecutive = model.NewBoolVar('')
                            model.AddBoolAnd([i_has_r, j_has_r_plus_1]).OnlyEnforceIf(both_consecutive)
                            model.AddBoolOr([i_has_r.Not(), j_has_r_plus_1.Not()]).OnlyEnforceIf(both_consecutive.Not())
                            
                            # If both_consecutive is true, then i_then_j must be true
                            model.AddImplication(both_consecutive, i_then_j)
                        
                        # If i_then_j is true, then there must be an edge between i and j
                        if (i, j) not in adjacency_matrix:
                            model.Add(i_then_j == 0)
            
            # 4. Objective: maximize the number of nodes in the path
            model.Maximize(sum(in_path.values()))
            
            # 5. Solve with randomization to avoid local minima
            solver = CpSolver()
            solver.parameters.max_time_in_seconds = 30.0  # 30 second timeout
            
            # Use randomization to explore different areas of the solution space
            solver.parameters.randomize_search = True
            solver.parameters.random_seed = int(time.time() * 1000) % 10000
            
            # Enable multiple workers for better exploration
            solver.parameters.num_search_workers = min(12, os.cpu_count() or 4)
            solver.parameters.log_search_progress = False
            
            status = solver.Solve(model)
            
            if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
                # Construct the path from rank values
                path_with_rank = []
                for i, node in enumerate(nodes):
                    node_rank = solver.Value(rank[i])
                    if node_rank >= 0:  # Node is in the path
                        path_with_rank.append((idx_to_node[i], node_rank))
                
                # Sort by rank to get the path in correct order
                path_with_rank.sort(key=lambda x: x[1])
                path = [node for node, _ in path_with_rank]
                
                # Validate path connectivity
                if self._validate_path(adjacency_dict, path):
                    elapsed = time.time() - start_time
                    print(f"Rank model for component {component_idx}: Found path of length {len(path)} in {elapsed:.2f}s")
                    return path
                else:
                    return []
            else:
                print(f"Component {component_idx}: Rank model could not find a solution")
                return []
                
        except Exception as e:
            print(f"Error in rank-based solver: {str(e)}")
            import traceback
            traceback.print_exc()
            return []
        
    def _beam_search_longest_path(self, adjacency_dict, cancel_event=None, beam_width=100, max_iterations=1000):
        """Find longest path using beam search with multiple starting nodes."""
        try:
            # Convert dictionary to a graph
            G = nx.Graph()
            for node, neighbors in adjacency_dict.items():
                for neighbor in neighbors:
                    G.add_edge(node, neighbor)
            
            nodes = list(adjacency_dict.keys())
            if not nodes:
                return []
            
            best_path = []
            
            # Choose starting nodes based on graph structure
            # Prefer nodes with degree 1 or 2 as they're likely endpoints
            degree_1_nodes = [n for n in nodes if len(adjacency_dict.get(n, [])) == 1]
            degree_2_nodes = [n for n in nodes if len(adjacency_dict.get(n, [])) == 2]
            
            # Include some random nodes for diversity
            random_nodes = random.sample(nodes, min(10, len(nodes)))
            
            # Combine potential starting nodes, prioritizing degree 1 nodes
            start_nodes = degree_1_nodes + degree_2_nodes + random_nodes
            
            # Remove duplicates while preserving order
            seen = set()
            start_nodes = [n for n in start_nodes if not (n in seen or seen.add(n))]
            
            # Limit number of starting nodes to avoid excessive computation
            start_nodes = start_nodes[:min(15, len(start_nodes))]
            
            # If no good candidates, just use a few random nodes
            if not start_nodes:
                start_nodes = random.sample(nodes, min(5, len(nodes)))
            
            print(f"Beam search using {len(start_nodes)} starting nodes")
            
            for start_node in start_nodes:
                # Initialize beam with paths containing only the start node
                beam = [[start_node]]
                
                for _ in range(min(max_iterations, len(G) * 2)):
                    candidates = []
                    
                    # Expand each path in the beam
                    for path in beam:
                        last_node = path[-1]
                        
                        # Try to extend the path with neighbors
                        for neighbor in G.neighbors(last_node):
                            if neighbor not in path:
                                new_path = path + [neighbor]
                                candidates.append(new_path)
                    
                    # If no candidates, we can't extend paths further
                    if not candidates:
                        break
                    
                    # Select top-k candidates based on length
                    beam = sorted(candidates, key=len, reverse=True)[:beam_width]
                    
                    # Update best path
                    if beam and len(beam[0]) > len(best_path):
                        best_path = beam[0]
                    
                    # If we've covered most of the graph, we're likely done
                    if best_path and len(best_path) > len(G) * 0.9:
                        break
            
            return best_path
            
        except Exception as e:
            print(f"Error in beam search: {str(e)}")
            return []

    
    def _visualize_path(self, adjacency_dict: Dict[str, List[str]], path: List[str], component_idx: int, dimensions: Dict[str, int]) -> None:
        """Visualize the graph and path using the GraphVisualizer."""
        try:
            if not path:
                return
            if self.visualizer is None:
                print("Visualizer not initialized, skipping visualization")
                return
            
            # Use our GraphVisualizer for visualization
            self._image_counter += 1
            
            # Generate both regular graph and hexagonal visualizations
            self.visualizer.visualize_graph(
                dimensions,
                adjacency_dict,
                path=path,
                title=f"Component {component_idx}",
                filename_prefix=f"component_{component_idx}_{self._image_counter}"
            )
            
            self.visualizer.visualize_hexagonal_tiling(
                dimensions,
                adjacency_dict,
                path,
                title=f"Component {component_idx} Hex Tiling",
                filename_prefix=f"hex_component_{component_idx}_{self._image_counter}"
            )
            
        except Exception as e:
            print(f"Visualization error: {str(e)}")
            
    async def generate_component_report(self, data: dict, all_solutions: List[List[str]], websocket=None):
        """
        Generate a comprehensive visualization of all components and their longest paths.
        Upload it to GCS and send the URL to the client.
        
        Args:
            data: The original maze data
            all_solutions: The solutions for each component
            websocket: The WebSocket connection to the client
        """
        try:
            # Skip if client disconnected
            if websocket and not websocket.client_state.CONNECTED:
                print("Client disconnected, skipping component report generation")
                return
                
            print("Generating component report visualization...")
            
            # Get session ID, generating one if not provided
            session_id = data.get('session_id')
            if not session_id:
                session_id = f"session_{int(time.time())}_{random.randint(1000, 9999)}"
                print(f"No session_id provided, generated new one: {session_id}")
            
            # Prepare components data for visualization
            components_data = []
            for i, solution in enumerate(all_solutions):
                if i < len(data['components']) and solution:
                    # Extract component adjacency dict
                    adjacency = data['components'][i]
                    
                    # Create component data
                    component = {
                        'id': i + 1,  # 1-indexed for display
                        'nodes': list(adjacency.keys()),
                        'adjacency': adjacency,
                        'longest_path': solution
                    }
                    components_data.append(component)
            
            # Skip if no components with solutions
            if not components_data:
                print("No components with solutions to visualize")
                if websocket and websocket.client_state.CONNECTED:
                    await websocket.send_json({
                        "type": "visualization_error",
                        "error": "No components with solutions to visualize"
                    })
                return
                
            # Get dimensions from data
            dimensions = data.get('dimensions', {'rows': 0, 'cols': 0})
            if dimensions['rows'] == 0 or dimensions['cols'] == 0:
                if websocket and websocket.client_state.CONNECTED:
                    await websocket.send_json({
                        "type": "visualization_error",
                        "error": "No dimensions available in the data for visualization"
                    })
                return
                
            
            # Generate the visualization synchronously in this function
            # to ensure it's completed before the connection closes
            print(f"Creating visualization for {len(components_data)} components...")
            # Use the instance visualizer created during __init__
            visualizer = self.visualizer 
            try: 
                # Use executor to avoid blocking the event loop with CPU-bound task
                loop = asyncio.get_running_loop()
                image_bytes = await loop.run_in_executor(
                    None,
                    lambda: visualizer.create_component_report(
                        dimensions,
                        components_data,
                        return_bytes=True
                    )
                )
                print(f"Visualization generated: {len(image_bytes)} bytes")
            except Exception as e:
                print(f"Error generating visualization: {str(e)}")
                if websocket and websocket.client_state.CONNECTED:
                    await websocket.send_json({
                        "type": "visualization_error",
                        "error": f"Failed to generate visualization: {str(e)}"
                    })
                    
            try:
                print(f"now uploading visualization to GCS bucket '{bucket_name}', blob '{blob_name}'...")
            
                # Upload to GCS
                bucket_name = os.environ.get("GCS_BUCKET_NAME", "maze-solver-visualizations")
                timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                blob_name = f"visualizations/{session_id}/{timestamp}.png"
                # Upload in a non-blocking way but wait for completion
                url = await loop.run_in_executor(
                    None,
                    lambda: upload_bytes_to_gcs(bucket_name, blob_name, image_bytes)
                )
                
                print(f"Component report uploaded to: {url}")
            except Exception as e:
                print(f"Error uploading component report: {str(e)}")
                if websocket and websocket.client_state.CONNECTED:
                    await websocket.send_json({
                        "type": "visualization_error",
                        "error": f"Failed to upload visualization: {str(e)}"
                    })
            
            # Notify client if WebSocket is still connected
            if websocket and websocket.client_state.CONNECTED:
                print(f"Sending visualization_ready message with URL: {url}")
                await websocket.send_json({
                    "type": "visualization_ready",
                    "url": url,
                    "session_id": session_id,
                    "timestamp": timestamp,
                    "access_url": f"/api/visualize/{session_id}"
                })
                print("Visualization message sent successfully")
            else:
                print("WebSocket not available, visualization ready but not sent to client")
                
        except Exception as e:
            print(f"Error generating component report: {str(e)}")
            import traceback
            traceback.print_exc()
            
            # Try to inform the client
            if websocket and websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "visualization_error",
                    "error": f"Failed to generate visualization: {str(e)}"
                })
                
            # Save the error for debugging
            error_file = os.path.join(self._output_dir, f"visualization_error_{int(time.time())}.txt")
            try:
                with open(error_file, "w") as f:
                    f.write(f"Error generating visualization: {str(e)}\n")
                    f.write(f"Data: {json.dumps(data, indent=2)}\n")
                    f.write(f"Solutions: {json.dumps(all_solutions, indent=2)}\n")
                    traceback.print_exc(file=f)
            except:
                print("Could not write error file")
    
    # NOTE: This method is now deprecated as visualize_clockwise_ordering was removed from GraphVisualizer
    # It's kept as a stub for backwards compatibility but will log a warning
    def analyze_clockwise_ordering(self, adjacency_list, node_id: str) -> None:
        """
        This method is deprecated and will be removed in future versions.
        The clockwise ordering visualization has been removed during refactoring.
        """
        print("WARNING: analyze_clockwise_ordering is deprecated and does nothing. This method will be removed in a future version.")
    
    def _verify_and_visualize(self, adjacency_dict: Dict[str, List[str]], 
                              path: List[str], component_idx: int, check_longest: bool, dimensions: Dict[str, int]) -> tuple[str, bool]:
        """Verify solution and visualize, performing longest path check only for the second largest component."""
        try:
            if not adjacency_dict:
                return "Empty adjacency list", False
            
            if not path:
                return "Empty path", False
            
            # Build graph once
            G = nx.Graph(adjacency_dict)
            
            # Verify solution
            result, valid = self._verify_solution(G, path, adjacency_dict, check_longest)
            
            # Always visualize even if the solution is suboptimal
            self._visualize_path(adjacency_dict, path, component_idx, dimensions)
            
            return result, valid
        except Exception as e:
            return f"Verification error: {str(e)}", False
    
    def _verify_solution(self, G: nx.Graph, path: List[str], adjacency_dict: Dict[str, List[str]], check_longest: bool) -> tuple[str, bool]:
        # map nodes to indices
        nodes = list(adjacency_dict.keys())
        idx_map = {n:i for i,n in enumerate(nodes)}
        n = len(nodes)
        mask = np.zeros(n, bool)
        for p in path:
            mask[idx_map[p]] = True

        # ensure path validity via networkx
        if not self._validate_path(G, path):
            return "Invalid path", False

        if check_longest:
            for i, node in enumerate(nodes):
                if not mask[i]:
                    nbrs = adjacency_dict[node]
                    nbr_idxs = [idx_map[n] for n in nbrs]
                    count = mask[nbr_idxs].sum()
                    if count > 1:
                        return "Suboptimal longest path", False
        return "Valid", True

    async def stop_queue_processor(self):
        """Stop the queue processor task during application shutdown"""
        if self._queue_processor_task and not self._queue_processor_task.done():
            print("Stopping queue processor...")
            self._queue_processor_task.cancel()
            try:
                await self._queue_processor_task
            except asyncio.CancelledError:
                pass
            print("Queue processor stopped")

         
    def _validate_path(self, graph: GraphLike, path: List[str]) -> bool:
        if isinstance(graph, nx.Graph):
            G = graph
        else: # permits the adjacency_dict to be input                                  
            G = nx.Graph()
            for u, nbrs in graph.items():
                for v in nbrs:
                    G.add_edge(u, v)
        
        if len(path) <= 1:                       # empty or single‑node path is valid
            return True

        if len(set(path)) != len(path):          # any duplicate nodes
            return False

        # every consecutive pair must be connected by an edge
        return all(G.has_edge(u, v) for u, v in zip(path, path[1:]))
    
    def _solve_with_cp_sat_fixed_start(self, adjacency_dict: Dict[str, List[str]], start_node: str) -> List[str]:
        """
        CP‑SAT longest‑path that *must* begin at start_node.
        Very similar to _solve_with_ranking, but we enforce rank[start_node] == 0
        """
        # build mapping
        nodes = list(adjacency_dict.keys())
        node_to_idx = {n: i for i, n in enumerate(nodes)}
        idx_to_node = {i: n for n, i in node_to_idx.items()}
        n = len(nodes)

        model = CpModel()
        in_path = [model.NewBoolVar(f"in_p_{i}") for i in range(n)]
        rank   = [model.NewIntVar(-1, n-1,      f"r_{i}") for i in range(n)]

        # link in_path and rank
        for i in range(n):
            model.Add(rank[i] >= 0).OnlyEnforceIf(in_path[i])
            model.Add(rank[i] == -1).OnlyEnforceIf(in_path[i].Not())

        # enforce start_node at rank 0
        si = node_to_idx[start_node]
        model.Add(in_path[si] == 1)
        model.Add(rank[si] == 0)

        # each rank used at most once
        for r in range(n):
            occ = []
            for i in range(n):
                b = model.NewBoolVar(f"has_r{r}_{i}")
                model.Add(rank[i] == r).OnlyEnforceIf(b)
                model.Add(rank[i] != r).OnlyEnforceIf(b.Not())
                occ.append(b)
            model.Add(sum(occ) <= 1)

        # no gaps: if rank r+1 used → rank r used
        for r in range(1, n):
            has_r   = model.NewBoolVar(f"rank{r}_used")
            has_rm1 = model.NewBoolVar(f"rank{r-1}_used")
            model.Add(sum(rank[i] == r   for i in range(n)) >= 1).OnlyEnforceIf(has_r)
            model.Add(sum(rank[i] == r   for i in range(n)) == 0).OnlyEnforceIf(has_r.Not())
            model.Add(sum(rank[i] == r-1 for i in range(n)) >= 1).OnlyEnforceIf(has_r)
            model.Add(sum(rank[i] == r-1 for i in range(n)) == 0).OnlyEnforceIf(has_r.Not())

        # adjacency constraint
        edges = set()
        for u, nbrs in adjacency_dict.items():
            ui = node_to_idx[u]
            for v in nbrs:
                if v in node_to_idx:
                    vi = node_to_idx[v]
                    edges.add((ui, vi))
                    edges.add((vi, ui))
        for i in range(n):
            for j in range(n):
                if i != j:
                    # if rank[j] == rank[i]+1 then (i,j) must be an edge
                    for r in range(n-1):
                        c = model.NewBoolVar(f"cons_{i}_{j}_{r}")
                        model.Add(rank[i] == r).OnlyEnforceIf(c)
                        model.Add(rank[j] == r+1).OnlyEnforceIf(c)
                        model.AddBoolOr([c.Not(), model.NewConstant(1) if (i,j) in edges else model.NewConstant(0)==1])
                        # above: if c then edge must exist

        model.Maximize(sum(in_path))
        solver = CpSolver()
        solver.parameters.max_time_in_seconds = 20.0
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return []

        sol = [(idx_to_node[i], solver.Value(rank[i])) for i in range(n) if solver.Value(rank[i]) >= 0]
        sol.sort(key=lambda x: x[1])
        return [node for node, _ in sol]

    async def _generate_component_report_for_rest(self, data: dict, all_solutions: List[List[str]]) -> dict:
        """
        Generate component report for REST API calls without WebSocket messaging.
        Returns visualization metadata instead of sending WebSocket messages.
        """
        try:
            print("Generating component report visualization for REST API...")
            
            # Get session ID, generating one if not provided
            session_id = data.get('session_id')
            if not session_id:
                session_id = f"session_{int(time.time())}_{random.randint(1000, 9999)}"
                print(f"No session_id provided, generated new one: {session_id}")
            
            # Prepare components data for visualization (same as in generate_component_report)
            components_data = []
            for i, solution in enumerate(all_solutions):
                if i < len(data['components']) and solution:
                    # Extract component adjacency dict
                    adjacency = data['components'][i]
                    
                    # Create component data
                    component = {
                        'id': i + 1,  # 1-indexed for display
                        'nodes': list(adjacency.keys()),
                        'adjacency': adjacency,
                        'longest_path': solution
                    }
                    components_data.append(component)
            
            # Skip if no components with solutions
            if not components_data:
                print("No components with solutions to visualize")
                return {"status": "no_components"}
            
            # Get dimensions from data
            dimensions = data.get('dimensions', {'rows': 0, 'cols': 0})
            if dimensions['rows'] == 0 or dimensions['cols'] == 0:
                print("No dimensions available for visualization")
                return {"status": "no_dimensions"}
            
            # Generate the visualization
            print(f"Creating visualization for {len(components_data)} components...")
            visualizer = self.visualizer 
            try:
                # Use executor to avoid blocking the event loop
                loop = asyncio.get_running_loop()
                image_bytes = await loop.run_in_executor(
                    None,
                    lambda: visualizer.create_component_report(
                        dimensions,
                        components_data,
                        return_bytes=True
                    )
                )
                print(f"Visualization generated: {len(image_bytes)} bytes")
            except Exception as e:
                print(f"Error generating visualization: {str(e)}")
                return {"status": "visualization_error", "error": str(e)}
            
            try:
                # Upload to GCS
                bucket_name = os.environ.get("GCS_BUCKET_NAME", "maze-solver-visualizations")
                timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                blob_name = f"visualizations/{session_id}/{timestamp}.png"
                
                # Upload in a non-blocking way but wait for completion
                url = await loop.run_in_executor(
                    None,
                    lambda: upload_bytes_to_gcs(bucket_name, blob_name, image_bytes)
                )
                
                print(f"Component report uploaded to: {url}")
                
                # Return visualization metadata
                return {
                    "status": "success",
                    "url": url,
                    "session_id": session_id,
                    "timestamp": timestamp,
                    "access_url": f"/api/visualize/{session_id}"
                }
                
            except Exception as e:
                print(f"Error uploading component report: {str(e)}")
                return {"status": "upload_error", "error": str(e)}
            
        except Exception as e:
            print(f"Error generating component report for REST: {str(e)}")
            import traceback
            traceback.print_exc()
            return {"status": "error", "error": str(e)}

