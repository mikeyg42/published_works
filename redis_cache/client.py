"""
High-Performance Redis Client
Centralized Redis client management with connection pooling, compression, and error handling.
"""

import json
import time
import zlib
import logging
import asyncio
from typing import Optional, Dict, Any, Tuple, List
from dataclasses import dataclass
from contextlib import asynccontextmanager
import redis.asyncio as redis
from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff

from .config import get_redis_config

logger = logging.getLogger(__name__)


@dataclass
class CacheStats:
    """Cache performance statistics"""
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


@dataclass
class CircuitBreakerConfig:
    """Circuit breaker configuration"""
    failure_threshold: int = 5
    recovery_timeout: float = 30.0  # seconds
    half_open_max_calls: int = 3


class OptimizedRedisCache:
    """
    Production Redis cache with:
    - Smart compression (adaptive threshold)
    - Connection pooling with circuit breaker
    - Atomic operations for consistency
    - Proper error handling and logging
    - Configuration-driven setup
    - Race condition prevention with Lua scripts
    """

    # Lua scripts for atomic operations
    RATE_LIMIT_SCRIPT = """
    local key = KEYS[1]
    local window = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local current_time = tonumber(ARGV[3])

    -- Remove expired entries
    redis.call('ZREMRANGEBYSCORE', key, 0, current_time - window)

    -- Count current entries
    local current = redis.call('ZCARD', key)

    if current < limit then
        -- Add current request
        redis.call('ZADD', key, current_time, current_time)
        redis.call('EXPIRE', key, window)
        return {1, limit - current - 1}
    else
        return {0, 0}
    end
    """

    CACHE_WITH_TTL_SCRIPT = """
    local key = KEYS[1]
    local value = ARGV[1]
    local ttl = tonumber(ARGV[2])
    local nx = ARGV[3] -- 'NX' for set-if-not-exists, empty for overwrite

    if nx == 'NX' then
        local result = redis.call('SET', key, value, 'EX', ttl, 'NX')
        return result and 1 or 0
    else
        redis.call('SET', key, value, 'EX', ttl)
        return 1
    end
    """

    GET_AND_REFRESH_SCRIPT = """
    local key = KEYS[1]
    local ttl = tonumber(ARGV[1])

    local value = redis.call('GET', key)
    if value then
        redis.call('EXPIRE', key, ttl)
        return value
    else
        return nil
    end
    """

    def __init__(self, config=None):
        self.config = config or get_redis_config()
        self.stats = CacheStats()
        self.circuit_breaker = CircuitBreakerConfig()
        self._circuit_open = False
        self._half_open_calls = 0

        # Connection pool configuration with retry
        retry_config = Retry(ExponentialBackoff(cap=10, base=0.5), 3)
        self.pool_config = {
            **self.config.get_pool_config(),
            "retry": retry_config,
        }

        self.pool: Optional[redis.ConnectionPool] = None
        self.client: Optional[redis.Redis] = None
        self._health_check_task: Optional[asyncio.Task] = None
        self._shutdown_event = asyncio.Event()

        # Lua script SHA hashes (populated on initialization)
        self._rate_limit_sha: Optional[str] = None
        self._cache_ttl_sha: Optional[str] = None
        self._get_refresh_sha: Optional[str] = None

    async def initialize(self) -> None:
        """Initialize connection pool with health check"""
        if self.client:
            return

        self.pool = redis.ConnectionPool.from_url(
            self.config.redis_url,
            **self.pool_config
        )

        self.client = redis.Redis(
            connection_pool=self.pool,
            decode_responses=False  # We handle encoding ourselves
        )

        # Verify connection and reset circuit breaker
        try:
            await self.client.ping()
            self._reset_circuit_breaker()

            # Register Lua scripts
            await self._register_lua_scripts()

            logger.info(f"Redis connection established to {self.config.redis_url}")

            # Start background health monitoring
            self._health_check_task = asyncio.create_task(self._health_monitor())

        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            self._handle_circuit_failure()
            raise

    async def close(self) -> None:
        """Graceful shutdown with health monitor cleanup"""
        # Signal shutdown and wait for health monitor
        self._shutdown_event.set()
        if self._health_check_task and not self._health_check_task.done():
            self._health_check_task.cancel()
            try:
                await self._health_check_task
            except asyncio.CancelledError:
                pass

        if self.client:
            await self.client.aclose()
            self.client = None
        if self.pool:
            await self.pool.aclose()
            self.pool = None
        logger.info("Redis connection closed")

    def _serialize(self, data: Any) -> bytes:
        """
        Serialize with optional compression.
        Uses compression for large payloads to reduce network I/O.
        """
        json_str = json.dumps(data, separators=(',', ':'))
        json_bytes = json_str.encode('utf-8')

        if len(json_bytes) > self.config.compression_threshold:
            # zlib level 1 for speed/size balance
            compressed = zlib.compress(json_bytes, level=1)

            # Only use compression if it actually saves space
            if len(compressed) < len(json_bytes) * 0.9:
                return b'Z' + compressed

        return b'J' + json_bytes

    def _deserialize(self, data: bytes) -> Any:
        """Deserialize with automatic decompression detection"""
        if not data:
            return None

        marker = data[0:1]
        payload = data[1:]

        if marker == b'Z':
            json_bytes = zlib.decompress(payload)
        elif marker == b'J':
            json_bytes = payload
        else:
            # Legacy format fallback
            json_bytes = data

        return json.loads(json_bytes.decode('utf-8'))

    async def save_maze_solution(
        self,
        session_id: str,
        maze_data: Dict[str, Any],
        solutions: List[List[str]],
        metadata: Optional[Dict[str, Any]] = None,
        ttl: Optional[int] = None
    ) -> bool:
        """
        Save maze solution with atomic operation.

        Uses transaction to ensure consistency and includes
        metadata for debugging and analytics.
        """
        if not self.client:
            raise RuntimeError("Cache not initialized")

        # Validate inputs
        self._validate_session_id(session_id)
        self._validate_maze_data(maze_data)
        self._validate_solutions(solutions)
        self._validate_ttl(ttl)

        if self._is_circuit_open():
            logger.warning(f"Circuit breaker open, skipping cache save for {session_id}")
            return False

        try:
            key = f"maze:{session_id}"

            # Prepare cache entry
            cache_entry = {
                "maze_data": maze_data,
                "solutions": solutions,
                "created_at": time.time(),
                "metadata": metadata or {}
            }

            # Serialize data
            serialized = self._serialize(cache_entry)

            # Use provided TTL or default
            ttl_seconds = ttl or self.config.default_ttl

            # Save with TTL using atomic Lua script
            success = await self._atomic_set_with_ttl(
                key,
                serialized,
                ttl_seconds,
                nx=False  # Allow overwrites
            )

            if success:
                logger.debug(f"Cached maze {session_id} ({len(serialized)} bytes, TTL: {ttl_seconds}s)")
                self.stats.hits += 1
                self._handle_circuit_success()

            return bool(success)

        except Exception as e:
            logger.error(f"Cache save error for {session_id}: {e}")
            self.stats.errors += 1
            self._handle_circuit_failure()
            return False

    async def get_maze_solution(
        self,
        session_id: str
    ) -> Optional[Tuple[Dict[str, Any], List[List[str]]]]:
        """
        Retrieve maze solution with automatic TTL refresh.

        Implements cache-aside pattern with TTL refresh on access
        for frequently used items.
        """
        # Validate inputs
        self._validate_session_id(session_id)

        if not self.client:
            raise RuntimeError("Cache not initialized")

        if self._is_circuit_open():
            logger.warning(f"Circuit breaker open, skipping cache get for {session_id}")
            return None

        try:
            key = f"maze:{session_id}"

            # Get and refresh TTL atomically using Lua script
            data = await self._atomic_get_with_refresh(
                key,
                self.config.default_ttl
            )

            if not data:
                self.stats.misses += 1
                return None

            # Deserialize
            cache_entry = self._deserialize(data)

            self.stats.hits += 1
            self._handle_circuit_success()
            logger.debug(f"Cache hit for maze {session_id}")

            return (
                cache_entry["maze_data"],
                cache_entry["solutions"]
            )

        except Exception as e:
            logger.error(f"Cache retrieval error for {session_id}: {e}")
            self.stats.errors += 1
            self._handle_circuit_failure()
            return None

    async def invalidate(self, session_id: str) -> bool:
        """Invalidate cache entry"""
        if not self.client:
            return False

        try:
            key = f"maze:{session_id}"
            deleted = await self.client.delete(key)
            if deleted > 0:
                logger.debug(f"Invalidated cache for {session_id}")
            return deleted > 0
        except Exception as e:
            logger.error(f"Cache invalidation error for {session_id}: {e}")
            return False

    async def get_stats(self) -> Dict[str, Any]:
        """Get comprehensive cache statistics and health info"""
        stats = {
            "hits": self.stats.hits,
            "misses": self.stats.misses,
            "errors": self.stats.errors,
            "hit_rate": f"{self.stats.hit_rate:.2f}%",
            "error_rate": f"{self.stats.error_rate:.2f}%",
            "circuit_breaker": {
                "is_open": self._circuit_open,
                "consecutive_failures": self.stats.consecutive_failures,
                "total_trips": self.stats.circuit_breaker_trips,
                "last_failure_time": self.stats.last_failure_time,
                "recovery_timeout": self.circuit_breaker.recovery_timeout
            },
            "connection": {
                "pool_size": self.pool.connection_pool_size if self.pool else 0,
                "health_check_running": self._health_check_task is not None and not self._health_check_task.done()
            }
        }

        if self.client:
            try:
                info = await self.client.info("stats")
                stats["redis"] = {
                    "connected_clients": info.get("connected_clients", 0),
                    "keyspace_hits": info.get("keyspace_hits", 0),
                    "keyspace_misses": info.get("keyspace_misses", 0),
                    "total_commands": info.get("total_commands_processed", 0),
                }
            except Exception as e:
                logger.error(f"Error getting Redis stats: {e}")
                stats["redis"] = {"error": str(e)}

        return stats

    async def health_check(self) -> bool:
        """Simple health check for monitoring with circuit breaker logic"""
        if self._is_circuit_open():
            return False

        try:
            if self.client:
                await self.client.ping()
                self._handle_circuit_success()
                return True
        except Exception as e:
            logger.error(f"Redis health check failed: {e}")
            self._handle_circuit_failure()
        return False

    def _is_circuit_open(self) -> bool:
        """Check if circuit breaker is open"""
        if not self._circuit_open:
            return False

        # Check if we should attempt recovery
        if (self.stats.last_failure_time and
            time.time() - self.stats.last_failure_time > self.circuit_breaker.recovery_timeout):
            self._circuit_open = False
            self._half_open_calls = 0
            logger.info("Circuit breaker transitioning to half-open")
            return False

        return True

    def _handle_circuit_failure(self) -> None:
        """Handle circuit breaker failure"""
        self.stats.consecutive_failures += 1
        self.stats.last_failure_time = time.time()

        if self.stats.consecutive_failures >= self.circuit_breaker.failure_threshold:
            if not self._circuit_open:
                self._circuit_open = True
                self.stats.circuit_breaker_trips += 1
                logger.error(f"Circuit breaker opened after {self.stats.consecutive_failures} consecutive failures")

    def _handle_circuit_success(self) -> None:
        """Handle circuit breaker success"""
        if self._circuit_open:
            self._half_open_calls += 1
            if self._half_open_calls >= self.circuit_breaker.half_open_max_calls:
                self._reset_circuit_breaker()
                logger.info("Circuit breaker closed after successful recovery")
        else:
            self._reset_circuit_breaker()

    def _reset_circuit_breaker(self) -> None:
        """Reset circuit breaker to closed state"""
        self._circuit_open = False
        self._half_open_calls = 0
        self.stats.consecutive_failures = 0
        self.stats.last_failure_time = None

    async def _health_monitor(self) -> None:
        """Background health monitoring task"""
        while not self._shutdown_event.is_set():
            try:
                await asyncio.sleep(30)  # Check every 30 seconds
                if not self._shutdown_event.is_set():
                    await self.health_check()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Health monitor error: {e}")

    async def _register_lua_scripts(self) -> None:
        """Register Lua scripts with Redis for atomic operations"""
        try:
            self._rate_limit_sha = await self.client.script_load(self.RATE_LIMIT_SCRIPT)
            self._cache_ttl_sha = await self.client.script_load(self.CACHE_WITH_TTL_SCRIPT)
            self._get_refresh_sha = await self.client.script_load(self.GET_AND_REFRESH_SCRIPT)
            logger.debug("Lua scripts registered successfully")
        except Exception as e:
            logger.error(f"Failed to register Lua scripts: {e}")
            raise

    async def _atomic_set_with_ttl(
        self,
        key: str,
        value: bytes,
        ttl: int,
        nx: bool = False
    ) -> bool:
        """Atomic set operation using Lua script"""
        try:
            nx_flag = 'NX' if nx else ''
            result = await self.client.evalsha(
                self._cache_ttl_sha,
                1,  # number of keys
                key,
                value,
                ttl,
                nx_flag
            )
            return bool(result)
        except redis.NoScriptError:
            # Script not loaded, reload and retry
            await self._register_lua_scripts()
            result = await self.client.evalsha(
                self._cache_ttl_sha,
                1,
                key,
                value,
                ttl,
                nx_flag
            )
            return bool(result)

    async def _atomic_get_with_refresh(self, key: str, ttl: int) -> Optional[bytes]:
        """Atomic get with TTL refresh using Lua script"""
        try:
            result = await self.client.evalsha(
                self._get_refresh_sha,
                1,  # number of keys
                key,
                ttl
            )
            return result
        except redis.NoScriptError:
            # Script not loaded, reload and retry
            await self._register_lua_scripts()
            result = await self.client.evalsha(
                self._get_refresh_sha,
                1,
                key,
                ttl
            )
            return result

    def _validate_session_id(self, session_id: str) -> None:
        """Validate session ID format and security"""
        if not session_id:
            raise ValueError("Session ID cannot be empty")
        if not isinstance(session_id, str):
            raise ValueError("Session ID must be a string")
        if len(session_id) > 256:
            raise ValueError("Session ID too long (max 256 characters)")
        if not session_id.replace('-', '').replace('_', '').isalnum():
            raise ValueError("Session ID contains invalid characters")

    def _validate_maze_data(self, maze_data: Dict[str, Any]) -> None:
        """Validate maze data structure"""
        if not isinstance(maze_data, dict):
            raise ValueError("Maze data must be a dictionary")

        required_fields = {'rows', 'cols', 'maze'}
        missing_fields = required_fields - set(maze_data.keys())
        if missing_fields:
            raise ValueError(f"Missing required maze data fields: {missing_fields}")

        # Validate dimensions
        rows = maze_data.get('rows', 0)
        cols = maze_data.get('cols', 0)
        if not isinstance(rows, int) or not isinstance(cols, int):
            raise ValueError("Maze rows and cols must be integers")
        if rows <= 0 or cols <= 0:
            raise ValueError("Maze dimensions must be positive")
        if rows > 1000 or cols > 1000:
            raise ValueError("Maze dimensions too large (max 1000x1000)")

    def _validate_solutions(self, solutions: List[List[str]]) -> None:
        """Validate solutions format"""
        if not isinstance(solutions, list):
            raise ValueError("Solutions must be a list")

        for i, solution in enumerate(solutions):
            if not isinstance(solution, list):
                raise ValueError(f"Solution {i} must be a list")
            if len(solution) > 10000:
                raise ValueError(f"Solution {i} too long (max 10000 steps)")
            for j, step in enumerate(solution):
                if not isinstance(step, str):
                    raise ValueError(f"Solution {i} step {j} must be a string")

    def _validate_ttl(self, ttl: Optional[int]) -> None:
        """Validate TTL value"""
        if ttl is not None:
            if not isinstance(ttl, int):
                raise ValueError("TTL must be an integer")
            if ttl <= 0:
                raise ValueError("TTL must be positive")
            if ttl > 86400 * 7:  # 1 week max
                raise ValueError("TTL too large (max 1 week)")

    async def set(self, key: str, value: Any, ttl: Optional[int] = None) -> bool:
        """Generic set operation with serialization"""
        if not self.client:
            raise RuntimeError("Cache not initialized")

        try:
            serialized = self._serialize(value)
            ttl_seconds = ttl or self.config.default_ttl
            success = await self.client.set(key, serialized, ex=ttl_seconds)
            return bool(success)
        except Exception as e:
            logger.error(f"Set error for key {key}: {e}")
            return False

    async def get(self, key: str) -> Optional[Any]:
        """Generic get operation with deserialization"""
        if not self.client:
            raise RuntimeError("Cache not initialized")

        try:
            data = await self.client.get(key)
            if data:
                return self._deserialize(data)
            return None
        except Exception as e:
            logger.error(f"Get error for key {key}: {e}")
            return None


# Thread-safe singleton pattern for cache instance
_cache_instance: Optional[OptimizedRedisCache] = None
_cache_lock = asyncio.Lock()
_initialization_lock = asyncio.Lock()


async def shutdown_cache():
    """Thread-safe shutdown of the global cache instance - call this in FastAPI lifespan"""
    global _cache_instance
    async with _initialization_lock:
        if _cache_instance:
            await _cache_instance.close()
            _cache_instance = None
            logger.info("Global cache instance shutdown")


@asynccontextmanager
async def get_redis_cache():
    """
    Thread-safe context manager for Redis cache access.
    Ensures proper initialization and error handling with double-checked locking.
    """
    global _cache_instance

    # First check (fast path)
    if _cache_instance is not None and _cache_instance.client is not None:
        yield _cache_instance
        return

    # Acquire lock for initialization (slow path)
    async with _initialization_lock:
        # Second check while holding lock
        if _cache_instance is None:
            config = get_redis_config()
            _cache_instance = OptimizedRedisCache(config)
            await _cache_instance.initialize()
        elif _cache_instance.client is None:
            # Handle case where instance exists but connection is closed
            await _cache_instance.initialize()

    yield _cache_instance


# Convenience functions for backward compatibility
async def cache_maze(
    session_id: str,
    maze_data: dict,
    solutions: list,
    metadata: Optional[dict] = None
) -> bool:
    """Simple interface for caching maze solutions"""
    async with get_redis_cache() as cache:
        return await cache.save_maze_solution(session_id, maze_data, solutions, metadata)


async def get_cached_maze(session_id: str) -> Optional[Tuple[dict, list]]:
    """Simple interface for retrieving cached maze solutions"""
    async with get_redis_cache() as cache:
        return await cache.get_maze_solution(session_id)


async def redis_save(session_id: str, maze_data: dict, solutions: list) -> bool:
    """Backward compatibility function - DEPRECATED, use cache_maze instead"""
    logger.warning("redis_save is deprecated, use cache_maze instead")
    return await cache_maze(session_id, maze_data, solutions)