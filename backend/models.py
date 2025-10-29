"""
Backend Models
Models specific to the maze solving backend service.
These models are for maze generation, solving, and GPU rendering.
NO Redis or cache-related models should be here.
"""
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
import datetime


# ==================== MAZE SOLVING MODELS ====================

class MazeSolveRequest(BaseModel):
    """Request model for maze solving endpoints"""
    components: List[Dict[str, List[str]]] = Field(
        ..., 
        description="List of connected components in the maze graph"
    )
    dimensions: Dict[str, int] = Field(
        ..., 
        description="Maze dimensions (rows and cols of hexagons)"
    )
    session_id: Optional[str] = Field(
        None, 
        description="Optional session ID for tracking"
    )
    skip_rust: bool = Field(
        default=False, 
        description="Skip Rust solver and use Python fallback"
    )
    
    # Optional fields for tracking (used internally, not required from client)
    device_fingerprint: Optional[str] = Field(
        default="default",
        description="Device fingerprint for analytics"
    )
    canvas_width: Optional[int] = Field(
        None,
        description="Canvas width in pixels (for caching)"
    )
    canvas_height: Optional[int] = Field(
        None,
        description="Canvas height in pixels (for caching)"
    )


class MazeSolveResponse(BaseModel):
    """Response model for maze solving endpoints"""
    session_id: str = Field(..., description="Session ID for this solve")
    data: List[List[str]] = Field(
        ..., 
        description="List of solution paths through the maze"
    )
    solve_time_ms: Optional[float] = Field(
        None,
        description="Time taken to solve in milliseconds"
    )


# ==================== STREAMLINED GENERATION MODELS ====================

class StreamlinedRequest(BaseModel):
    """Request model for streamlined maze generation endpoint"""
    canvas_width: int = Field(
        ..., 
        ge=100, 
        le=4000,
        description="Canvas width in pixels"
    )
    canvas_height: int = Field(
        ..., 
        ge=100, 
        le=4000,
        description="Canvas height in pixels"
    )
    device_fingerprint: str = Field(
        default="default",
        description="Device fingerprint for cache exclusion"
    )
    preferences: Optional[Dict[str, Any]] = Field(
        None,
        description="User preferences for maze generation"
    )
    complexity: Optional[str] = Field(
        default="medium",
        description="Maze complexity: easy, medium, hard"
    )


class StreamlinedResponse(BaseModel):
    """Response model for streamlined maze generation endpoint"""
    session_id: str = Field(..., description="Unique session ID")
    status: str = Field(
        ..., 
        description="Status: queued, rendering, complete, error"
    )
    message: str = Field(..., description="Human-readable status message")
    render_task_id: str = Field(
        ..., 
        description="GPU renderer task ID for tracking"
    )
    stream_url: Optional[str] = Field(
        None,
        description="URL for streaming rendered frames"
    )
    status_url: Optional[str] = Field(
        None,
        description="URL for polling render status"
    )


# ==================== HEALTH CHECK MODELS ====================

class HealthCheckResponse(BaseModel):
    """Response model for health check endpoint"""
    status: str = Field(
        ..., 
        description="Overall health: healthy, degraded, unhealthy"
    )
    timestamp: str = Field(..., description="ISO timestamp")
    version: str = Field(..., description="API version")
    details: Optional[Dict[str, str]] = Field(
        default_factory=dict,
        description="Component health details"
    )


# ==================== ERROR MODELS ====================

class ErrorResponse(BaseModel):
    """Standardized error response model"""
    error: str = Field(..., description="Error type or code")
    message: str = Field(..., description="Human-readable error message")
    status_code: int = Field(..., description="HTTP status code")
    timestamp: str = Field(
        default_factory=lambda: datetime.datetime.utcnow().isoformat(),
        description="ISO timestamp of error"
    )
    path: Optional[str] = Field(None, description="Request path that caused error")
    request_id: Optional[str] = Field(None, description="Request ID for tracking")


# ==================== WEBSOCKET MODELS ====================

class WebSocketMessage(BaseModel):
    """WebSocket message format"""
    type: str = Field(
        ..., 
        description="Message type: solve_request, progress, result, error"
    )
    data: Dict[str, Any] = Field(..., description="Message payload")
    timestamp: float = Field(
        default_factory=lambda: datetime.datetime.utcnow().timestamp(),
        description="Unix timestamp"
    )


class SolveProgress(BaseModel):
    """Progress update for maze solving"""
    session_id: str
    stage: str = Field(
        ..., 
        description="Current stage: parsing, solving, formatting"
    )
    progress: float = Field(
        ..., 
        ge=0, 
        le=100,
        description="Progress percentage"
    )
    message: str = Field(..., description="Progress message")


# ==================== GPU RENDERER MODELS ====================

class GPURendererRequest(BaseModel):
    """Request to GPU renderer service"""
    session_id: str
    maze_data: Dict[str, Any] = Field(
        ..., 
        description="Maze structure data"
    )
    solutions: List[List[str]] = Field(
        ..., 
        description="Solution paths"
    )
    width: int = Field(..., ge=100, le=4000)
    height: int = Field(..., ge=100, le=4000)
    samples: int = Field(default=256, description="Rendering samples")
    format: str = Field(default="png", description="Output format")


class GPURendererResponse(BaseModel):
    """Response from GPU renderer service"""
    task_id: str = Field(..., description="Rendering task ID")
    status: str = Field(..., description="Task status")
    stream_url: Optional[str] = Field(None, description="Streaming URL")
    result_url: Optional[str] = Field(None, description="Final result URL")
    estimated_time: Optional[float] = Field(
        None,
        description="Estimated completion time in seconds"
    )


# Export all models that should be available to main.py
__all__ = [
    # Maze solving
    "MazeSolveRequest",
    "MazeSolveResponse",
    
    # Streamlined generation
    "StreamlinedRequest",
    "StreamlinedResponse",
    
    # Health and errors
    "HealthCheckResponse",
    "ErrorResponse",
    
    # WebSocket
    "WebSocketMessage",
    "SolveProgress",
    
    # GPU Renderer
    "GPURendererRequest",
    "GPURendererResponse",
]
