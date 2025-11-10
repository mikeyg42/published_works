"""
Redis Cache Package
Centralized Redis caching system for maze solver application.

This package provides:
- Centralized Redis client management
- Advanced maze caching with Redis Sorted Sets
- Rate limiting with circuit breaker pattern
- Configuration management

Main interfaces:
- get_redis_cache(): Context manager for Redis client access
- MazeCache: Advanced maze caching with range queries
- RateLimiter: Production-grade rate limiting
"""

from .client import get_redis_cache, OptimizedRedisCache, shutdown_cache
from .maze_cache import MazeCache, HexagonMath, CanvasRange, CachedMazeInfo, create_maze_cache
from .rate_limiting import AdaptiveRateLimiter, RateLimitStatus, RateLimitResult
from .config import RedisConfig, get_redis_config

# Convenience exports for backward compatibility
from .client import cache_maze, get_cached_maze

__version__ = "2.0.0"
__all__ = [
    # Core client
    "get_redis_cache",
    "OptimizedRedisCache",
    "shutdown_cache",

    # Maze caching
    "MazeCache",
    "HexagonMath",
    "CanvasRange",
    "CachedMazeInfo",
    "create_maze_cache",

    # Rate limiting
    "AdaptiveRateLimiter",
    "RateLimitStatus",
    "RateLimitResult",

    # Configuration
    "RedisConfig",
    "get_redis_config",

    # Backward compatibility
    "cache_maze",
    "get_cached_maze"
]