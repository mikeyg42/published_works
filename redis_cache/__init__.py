"""
Redis Cache Package
Centralized Redis caching system for maze solver application.

This package provides a complete Redis solution including:
- Connection management with pooling and circuit breakers
- Advanced maze caching with range queries
- Rate limiting with abuse protection
- FastAPI middleware integration
- Health monitoring and graceful degradation

Usage:
    from redis_cache import RedisManager, RedisConfig
    
    # In your FastAPI lifespan
    config = RedisConfig.from_env()
    manager = RedisManager(config)
    services = await manager.initialize()
    
    # Access services
    if services.is_available:
        cache = services.cache
        rate_limiter = services.rate_limiter
        maze_cache = services.maze_cache
"""

# Version
__version__ = "3.0.0"

# Core components
from .config import RedisConfig, get_redis_config
from .manager import RedisManager, RedisServices, get_redis_manager, shutdown_redis_manager
from .client import OptimizedRedisCache
from .setup import setup_redis, teardown_redis, get_redis_health

# Specialized components
from .maze_cache import MazeCache, create_maze_cache
from .rate_limiting import AdaptiveRateLimiter, RateLimitStatus, RateLimitResult
from .models import CacheQueryRequest, CacheQueryResponse, CacheStatsResponse

# Middleware
from .middleware import (
    RateLimitMiddleware,
    CacheHeadersMiddleware,
    RedisHealthCheckMiddleware,
    create_rate_limit_middleware,
    create_cache_headers_middleware,
    create_redis_health_middleware,
)

# Public API exports
__all__ = [
    # Version
    "__version__",
    
    # Configuration
    "RedisConfig",
    "get_redis_config",
    
    # Manager (main interface)
    "RedisManager",
    "RedisServices",
    "get_redis_manager",
    "shutdown_redis_manager",
    
    # Core client
    "OptimizedRedisCache",
    
    # Specialized components
    "MazeCache",
    "create_maze_cache",
    "AdaptiveRateLimiter",
    "RateLimitStatus",
    "RateLimitResult",
    
    # Middleware
    "RateLimitMiddleware",
    "CacheHeadersMiddleware",
    "RedisHealthCheckMiddleware",
    "create_rate_limit_middleware",
    "create_cache_headers_middleware",
    "create_redis_health_middleware",
]
