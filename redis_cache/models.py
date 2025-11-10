"""
Redis Cache Models
ALL models related to Redis caching, rate limiting, and cache queries go here.
These models are used by the redis_cache module and imported by main.py.
"""
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
from enum import Enum
import time


# ==================== CACHE QUERY MODELS ====================
# These are used for querying and managing the cache

class CacheQueryRequest(BaseModel):
    """Request model for querying compatible cached mazes"""
    target_width: int = Field(..., ge=100, le=4000, description="Target canvas width in pixels")
    target_height: int = Field(..., ge=100, le=4000, description="Target canvas height in pixels")
    device_fingerprint: str = Field(default="default", description="Device fingerprint for cache exclusion")
    max_results: int = Field(default=5, ge=1, le=20, description="Maximum number of results to return")


class CacheQueryResponse(BaseModel):
    """Response model for cache query results"""
    cache_hits: List[Dict[str, Any]]  # List of compatible cached mazes
    count: int  # Number of results found
    message: str  # Human-readable message


class CacheStatsResponse(BaseModel):
    """Response model for cache statistics"""
    total_entries: int = Field(default=0, description="Total number of cached entries")
    unique_dimensions: int = Field(default=0, description="Number of unique maze dimensions")
    hit_rate: float = Field(default=0.0, description="Cache hit rate percentage")
    miss_rate: float = Field(default=0.0, description="Cache miss rate percentage")
    memory_usage_mb: float = Field(default=0.0, description="Approximate memory usage in MB")
    oldest_entry_age_seconds: Optional[int] = Field(None, description="Age of oldest entry in seconds")
    newest_entry_age_seconds: Optional[int] = Field(None, description="Age of newest entry in seconds")
    device_distribution: Dict[str, int] = Field(default_factory=dict, description="Distribution by device")
    dimension_distribution: Dict[str, int] = Field(default_factory=dict, description="Distribution by dimensions")
    rate_limiter: Optional[Dict[str, Any]] = Field(None, description="Rate limiter statistics")


# ==================== RATE LIMITING MODELS ====================
# These are used by the rate limiting system

class RateLimitStatus(str, Enum):
    """Rate limit response types"""
    ALLOWED = "allowed"
    THROTTLED = "throttled"
    BLOCKED = "blocked"


class RateLimitResult(BaseModel):
    """Rate limit check result"""
    status: RateLimitStatus
    requests_remaining: int
    reset_after_seconds: int
    retry_after: Optional[int] = None
    message: Optional[str] = None

    def to_headers(self) -> Dict[str, str]:
        """Convert to standard HTTP rate limit headers"""
        headers = {
            "X-RateLimit-Remaining": str(self.requests_remaining),
            "X-RateLimit-Reset": str(int(time.time()) + self.reset_after_seconds),
        }
        if self.retry_after:
            headers["Retry-After"] = str(self.retry_after)
        return headers


# ==================== INTERNAL CACHE MODELS ====================
# These are used internally by the cache system

class CachedMazeInfo(BaseModel):
    """Information about a cached maze"""
    session_id: str
    rows: int
    cols: int
    hex_width: float
    hex_height: float
    canvas_width: int
    canvas_height: int
    created_at: float
    device_fingerprint: str = "default"
    complexity_score: float = 0.0
    solution_count: int = 0


class MazeCacheEntry(BaseModel):
    """Complete maze cache entry"""
    info: CachedMazeInfo
    maze_data: Dict[str, Any]
    solutions: List[List[str]]
    gpu_data: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None


class CanvasRange(BaseModel):
    """Canvas size range for querying"""
    min_width: int
    max_width: int
    min_height: int
    max_height: int
    
    def contains(self, width: int, height: int) -> bool:
        """Check if dimensions fall within range"""
        return (self.min_width <= width <= self.max_width and 
                self.min_height <= height <= self.max_height)


# ==================== PERFORMANCE MONITORING ====================

class CachePerformanceMetrics(BaseModel):
    """Cache performance metrics"""
    hits: int = 0
    misses: int = 0
    errors: int = 0
    circuit_breaker_trips: int = 0
    consecutive_failures: int = 0
    last_failure_time: Optional[float] = None
    
    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return (self.hits / total * 100) if total > 0 else 0.0
    
    @property
    def error_rate(self) -> float:
        total = self.hits + self.misses + self.errors
        return (self.errors / total * 100) if total > 0 else 0.0


class CircuitBreakerConfig(BaseModel):
    """Circuit breaker configuration"""
    failure_threshold: int = 5
    recovery_timeout: float = 30.0
    half_open_max_calls: int = 3


# ==================== REQUEST TRACKING ====================

class RequestInfo(BaseModel):
    """Information about the requesting client"""
    device_fingerprint: str = "default"
    ip: str = ""
    user_agent: str = ""
    accept_language: str = ""
    
    def get_cache_key(self) -> str:
        """Generate a cache key from request info"""
        import hashlib
        fingerprint = f"{self.device_fingerprint}:{self.ip}:{self.user_agent}"
        return hashlib.sha256(fingerprint.encode()).hexdigest()[:16]


# ==================== REDIS SERVICE STATUS ====================

class RedisServiceStatus(BaseModel):
    """Status of Redis services"""
    cache_available: bool = False
    rate_limiter_available: bool = False
    maze_cache_available: bool = False
    connection_healthy: bool = False
    overall_status: str = "unavailable"  # healthy, degraded, unavailable


# Export all models that should be available to main.py
__all__ = [
    # Cache query models (used by API endpoints)
    "CacheQueryRequest",
    "CacheQueryResponse",
    "CacheStatsResponse",
    
    # Rate limiting models (used by middleware)
    "RateLimitStatus",
    "RateLimitResult",
    
    # Internal models (may be needed for type hints)
    "CachedMazeInfo",
    "MazeCacheEntry",
    "CanvasRange",
    "CachePerformanceMetrics",
    "CircuitBreakerConfig",
    "RequestInfo",
    "RedisServiceStatus",
]
