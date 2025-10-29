"""
Redis Manager
High-level manager for Redis services initialization and lifecycle management.
This is the main interface for the FastAPI application.
"""

import asyncio
import logging
from typing import Optional, Dict, Any
from dataclasses import dataclass
import redis.asyncio as redis

from .config import get_redis_config, RedisConfig
from .client import OptimizedRedisCache
from .rate_limiting import AdaptiveRateLimiter
from .maze_cache import MazeCache, create_maze_cache

logger = logging.getLogger(__name__)


@dataclass
class RedisServices:
    """Container for all Redis-based services"""
    cache: Optional[OptimizedRedisCache] = None
    rate_limiter: Optional[AdaptiveRateLimiter] = None
    maze_cache: Optional[MazeCache] = None
    health_monitor_task: Optional[asyncio.Task] = None
    cleanup_task: Optional[asyncio.Task] = None
    is_available: bool = False
    
    def __bool__(self) -> bool:
        """Check if Redis services are available"""
        return self.is_available


class RedisManager:
    """
    Manages all Redis services for the application.
    Provides a clean interface for initialization, health monitoring, and shutdown.
    """
    
    def __init__(self, config: Optional[RedisConfig] = None):
        """Initialize the Redis manager with configuration"""
        self.config = config or get_redis_config()
        self.services = RedisServices()
        self._shutdown_event = asyncio.Event()
        
    async def initialize(self) -> RedisServices:
        """
        Initialize all Redis services.
        Returns RedisServices object, even if Redis is unavailable (graceful degradation).
        """
        # Check if Redis is disabled by configuration
        if not self.config.is_enabled():
            logger.info("Redis is disabled by configuration")
            return self.services
            
        try:
            # Initialize the Redis client
            logger.info("Initializing Redis services...")
            
            self.services.cache = OptimizedRedisCache(self.config)
            await self.services.cache.initialize()
            
            # Initialize rate limiter if enabled
            if self.config.is_rate_limiting_enabled():
                self.services.rate_limiter = AdaptiveRateLimiter(
                    self.services.cache.client, 
                    self.config
                )
                logger.info("✅ Rate limiter initialized")
            
            # Initialize maze cache if enabled
            if self.config.is_maze_cache_enabled():
                self.services.maze_cache = await create_maze_cache(
                    self.services.cache.client
                )
                logger.info("✅ Maze cache initialized")
            
            # Start background tasks
            await self._start_background_tasks()
            
            self.services.is_available = True
            logger.info("✅ All Redis services initialized successfully")
            
        except Exception as e:
            logger.warning(f"⚠️ Redis initialization failed: {e}")
            logger.warning("⚠️ Application will continue without Redis (graceful degradation)")
            self.services.is_available = False
            
            # Clean up any partially initialized services
            await self._cleanup_partial_initialization()
        
        return self.services
    
    async def _start_background_tasks(self):
        """Start background maintenance tasks"""
        # Health monitoring task
        async def health_monitor():
            """Monitor Redis health and handle failures"""
            while not self._shutdown_event.is_set():
                try:
                    if self.services.cache and self.services.cache.client:
                        await self.services.cache.client.ping()
                    await asyncio.sleep(self.config.health_check_interval)
                except Exception as e:
                    logger.error(f"Redis health check failed: {e}")
                    self.services.is_available = False
                    # Could implement reconnection logic here
                    
        # Cleanup task for rate limiting
        async def cleanup_task():
            """Periodic cleanup of expired Redis keys"""
            while not self._shutdown_event.is_set():
                try:
                    if self.services.rate_limiter:
                        count = await self.services.rate_limiter.cleanup_expired_keys()
                        if count > 0:
                            logger.debug(f"Cleaned up {count} expired rate limit keys")
                    
                    if self.services.maze_cache:
                        await self.services.maze_cache.cleanup_old_entries()
                        
                    await asyncio.sleep(self.config.cleanup_interval)
                except Exception as e:
                    logger.error(f"Cleanup task error: {e}")
        
        # Start tasks
        self.services.health_monitor_task = asyncio.create_task(health_monitor())
        self.services.cleanup_task = asyncio.create_task(cleanup_task())
        logger.debug("Background tasks started")
    
    async def _cleanup_partial_initialization(self):
        """Clean up any partially initialized services"""
        if self.services.cache:
            try:
                await self.services.cache.close()
            except Exception:
                pass
        
        self.services.cache = None
        self.services.rate_limiter = None
        self.services.maze_cache = None
    
    async def shutdown(self):
        """Gracefully shutdown all Redis services"""
        logger.info("Shutting down Redis services...")
        
        # Signal shutdown to background tasks
        self._shutdown_event.set()
        
        # Cancel background tasks
        tasks_to_cancel = []
        if self.services.health_monitor_task:
            tasks_to_cancel.append(self.services.health_monitor_task)
        if self.services.cleanup_task:
            tasks_to_cancel.append(self.services.cleanup_task)
        
        for task in tasks_to_cancel:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        
        # Close Redis connection
        if self.services.cache:
            try:
                await self.services.cache.close()
            except Exception as e:
                logger.error(f"Error closing Redis cache: {e}")
        
        self.services.is_available = False
        logger.info("Redis services shut down successfully")
    
    async def get_stats(self) -> Dict[str, Any]:
        """Get comprehensive statistics from all Redis services"""
        stats = {
            "available": self.services.is_available,
            "config": {
                "environment": self.config.environment,
                "redis_url": self.config.redis_url.split("@")[-1] if "@" in self.config.redis_url else self.config.redis_url,
                "rate_limiting_enabled": self.config.is_rate_limiting_enabled(),
                "maze_cache_enabled": self.config.is_maze_cache_enabled(),
            }
        }
        
        if not self.services.is_available:
            return stats
        
        try:
            # Get cache stats
            if self.services.cache:
                cache_stats = await self.services.cache.get_stats()
                stats["cache"] = cache_stats
            
            # Get rate limiter stats
            if self.services.rate_limiter:
                rate_stats = await self.services.rate_limiter.get_stats()
                stats["rate_limiting"] = rate_stats
            
            # Get maze cache stats
            if self.services.maze_cache:
                maze_stats = await self.services.maze_cache.get_cache_stats()
                stats["maze_cache"] = maze_stats
                
        except Exception as e:
            logger.error(f"Error getting Redis stats: {e}")
            stats["error"] = str(e)
        
        return stats
    
    def is_available(self) -> bool:
        """Check if Redis services are available"""
        return self.services.is_available
    
    def get_client(self) -> Optional[redis.Redis]:
        """Get the raw Redis client (for advanced usage)"""
        if self.services.cache:
            return self.services.cache.client
        return None


# Singleton instance for the application
_manager_instance: Optional[RedisManager] = None


async def get_redis_manager(config: Optional[RedisConfig] = None) -> RedisManager:
    """Get or create the global Redis manager instance"""
    global _manager_instance
    
    if _manager_instance is None:
        _manager_instance = RedisManager(config)
        await _manager_instance.initialize()
    
    return _manager_instance


async def shutdown_redis_manager():
    """Shutdown the global Redis manager"""
    global _manager_instance
    
    if _manager_instance:
        await _manager_instance.shutdown()
        _manager_instance = None
