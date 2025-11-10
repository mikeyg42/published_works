"""
Redis Cache Setup
Centralized setup and teardown for all Redis functionality
"""
import asyncio
import logging
from typing import Optional, Any
from dataclasses import dataclass

from .client import OptimizedRedisCache
from .config import get_redis_config
from .rate_limiting import AdaptiveRateLimiter
from .maze_cache import MazeCache

logger = logging.getLogger(__name__)


@dataclass
class RedisServices:
    """Container for all Redis services"""
    cache: Optional[OptimizedRedisCache] = None
    rate_limiter: Optional[AdaptiveRateLimiter] = None
    maze_cache: Optional[MazeCache] = None
    cleanup_task: Optional[asyncio.Task] = None
    is_healthy: bool = False
    
    def __bool__(self) -> bool:
        """Check if Redis services are available"""
        return self.is_healthy and self.cache is not None


class RedisSetup:
    """Manages Redis service lifecycle"""
    
    _instance: Optional['RedisSetup'] = None
    _lock = asyncio.Lock()
    
    def __init__(self):
        self.services = RedisServices()
        self._initialized = False
    
    @classmethod
    async def get_instance(cls) -> 'RedisSetup':
        """Get singleton instance of RedisSetup"""
        if cls._instance is None:
            async with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance
    
    async def initialize(self) -> RedisServices:
        """
        Initialize all Redis services with graceful degradation
        Returns RedisServices object even if Redis is unavailable
        """
        if self._initialized:
            return self.services
        
        try:
            # Load configuration
            config = get_redis_config()
            
            # Initialize Redis client
            logger.info("Initializing Redis connection...")
            self.services.cache = OptimizedRedisCache(config)
            await self.services.cache.initialize()
            
            # Initialize rate limiter
            logger.info("Initializing rate limiter...")
            self.services.rate_limiter = AdaptiveRateLimiter(
                redis_client=self.services.cache.client,
                config=config
            )
            
            # Initialize maze cache
            logger.info("Initializing maze cache...")
            self.services.maze_cache = MazeCache(
                redis_client=self.services.cache.client,
                config=config
            )
            
            # Start background cleanup task
            self.services.cleanup_task = asyncio.create_task(self._cleanup_worker())
            
            self.services.is_healthy = True
            self._initialized = True
            
            logger.info("✅ All Redis services initialized successfully")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize Redis services: {e}")
            logger.warning("⚠️ Application will run in degraded mode without caching")
            
            # Ensure services object exists even if Redis fails
            self.services.is_healthy = False
            self.services.cache = None
            self.services.rate_limiter = None
            self.services.maze_cache = None
            self.services.cleanup_task = None
        
        return self.services
    
    async def _cleanup_worker(self):
        """Background task to cleanup expired Redis keys"""
        while True:
            try:
                await asyncio.sleep(3600)  # Run every hour
                
                if self.services.rate_limiter:
                    count = await self.services.rate_limiter.cleanup_expired_keys()
                    if count > 0:
                        logger.info(f"Cleaned up {count} expired rate limit keys")
                
                if self.services.maze_cache:
                    count = await self.services.maze_cache.cleanup_old_entries()
                    if count > 0:
                        logger.info(f"Cleaned up {count} expired maze cache entries")
                        
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Cleanup worker error: {e}")
    
    async def shutdown(self):
        """Gracefully shutdown all Redis services"""
        logger.info("Shutting down Redis services...")
        
        try:
            # Cancel cleanup task
            if self.services.cleanup_task:
                self.services.cleanup_task.cancel()
                try:
                    await self.services.cleanup_task
                except asyncio.CancelledError:
                    pass
            
            # Close Redis connection
            if self.services.cache:
                await self.services.cache.close()
            
            # Clear services
            self.services = RedisServices()
            self._initialized = False
            
            logger.info("✅ Redis services shut down successfully")
            
        except Exception as e:
            logger.error(f"Error during Redis shutdown: {e}")
    
    async def health_check(self) -> dict:
        """Check health of all Redis services"""
        health = {
            "redis_connected": False,
            "rate_limiter_active": False,
            "maze_cache_active": False,
            "cleanup_task_running": False,
            "overall_health": "unhealthy"
        }
        
        try:
            # Check Redis connection
            if self.services.cache and self.services.cache.client:
                await self.services.cache.client.ping()
                health["redis_connected"] = True
            
            # Check rate limiter
            if self.services.rate_limiter:
                stats = await self.services.rate_limiter.get_stats()
                health["rate_limiter_active"] = True
                health["rate_limiter_stats"] = stats
            
            # Check maze cache
            if self.services.maze_cache:
                stats = await self.services.maze_cache.get_cache_stats()
                health["maze_cache_active"] = True
                health["maze_cache_stats"] = stats
            
            # Check cleanup task
            if self.services.cleanup_task and not self.services.cleanup_task.done():
                health["cleanup_task_running"] = True
            
            # Overall health
            if all([
                health["redis_connected"],
                health["rate_limiter_active"],
                health["maze_cache_active"],
                health["cleanup_task_running"]
            ]):
                health["overall_health"] = "healthy"
            elif health["redis_connected"]:
                health["overall_health"] = "degraded"
                
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            health["error"] = str(e)
        
        return health


# ============== Public API Functions ==============

async def setup_redis() -> RedisServices:
    """
    Initialize all Redis services for the application
    
    Usage in FastAPI:
        async def lifespan(app: FastAPI):
            # Startup
            redis_services = await setup_redis()
            app.state.cache = redis_services.cache
            app.state.rate_limiter = redis_services.rate_limiter
            app.state.maze_cache = redis_services.maze_cache
            yield
            # Shutdown
            await teardown_redis()
    """
    setup = await RedisSetup.get_instance()
    return await setup.initialize()


async def teardown_redis():
    """Shutdown all Redis services"""
    setup = await RedisSetup.get_instance()
    await setup.shutdown()


async def get_redis_health() -> dict:
    """Get health status of Redis services"""
    setup = await RedisSetup.get_instance()
    return await setup.health_check()


# ============== Convenience Functions ==============

async def get_cache() -> Optional[OptimizedRedisCache]:
    """Get the cache instance if available"""
    setup = await RedisSetup.get_instance()
    return setup.services.cache if setup.services.is_healthy else None


async def get_rate_limiter() -> Optional[AdaptiveRateLimiter]:
    """Get the rate limiter instance if available"""
    setup = await RedisSetup.get_instance()
    return setup.services.rate_limiter if setup.services.is_healthy else None


async def get_maze_cache() -> Optional[MazeCache]:
    """Get the maze cache instance if available"""
    setup = await RedisSetup.get_instance()
    return setup.services.maze_cache if setup.services.is_healthy else None
