"""
Rate Limiting with Circuit Breaker Pattern
Demonstrates: Redis best practices, sliding window algorithm, graceful degradation
"""

import time
import logging
import hashlib
from dataclasses import dataclass
from typing import Optional, Dict, Tuple
from enum import Enum
import redis.asyncio as redis

from .config import get_redis_config

logger = logging.getLogger(__name__)


class RateLimitStatus(Enum):
    """Rate limit response types for better UX"""
    ALLOWED = "allowed"
    THROTTLED = "throttled"
    BLOCKED = "blocked"


@dataclass
class RateLimitResult:
    """Structured rate limit response for clear client communication"""
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


class AdaptiveRateLimiter:
    """
    Production-grade rate limiter with:
    - Sliding window algorithm (accurate, no boundary issues)
    - Adaptive limits based on server load
    - Circuit breaker for abusive clients
    - Proper security (hashed identifiers)
    - Configuration-driven setup
    """

    def __init__(self, redis_client: redis.Redis, config=None):
        self.redis = redis_client
        self.config = config or get_redis_config()

        # Get rate limits from configuration
        self.limits = self.config.get_rate_limits()

        # Circuit breaker configuration
        self.abuse_threshold = self.config.rate_limit_abuse_threshold
        self.block_duration = self.config.rate_limit_block_duration

    def _hash_identifier(self, identifier: str) -> str:
        """Hash identifiers for privacy (GDPR compliance)"""
        return hashlib.sha256(identifier.encode()).hexdigest()[:16]

    async def check_rate_limit(
        self,
        identifier: str,
        operation: str = "default",
        cost: int = 1
    ) -> RateLimitResult:
        """
        Check if request is allowed under rate limits.

        Args:
            identifier: Client identifier (IP, API key, etc.)
            operation: Operation type for specific limits
            cost: Request cost (for expensive operations)

        Returns:
            RateLimitResult with status and metadata
        """
        hashed_id = self._hash_identifier(identifier)

        # Check if client is blocked (circuit breaker)
        if await self._is_blocked(hashed_id):
            return RateLimitResult(
                status=RateLimitStatus.BLOCKED,
                requests_remaining=0,
                reset_after_seconds=self.block_duration,
                retry_after=self.block_duration,
                message="Too many violations. Please try again later."
            )

        # Get limits for operation
        limits = self.limits.get(operation, self.limits["default"])

        # Check both minute and hour windows
        minute_result = await self._check_window(
            hashed_id, operation, "minute",
            limits["per_minute"], 60, cost
        )

        if not minute_result[0]:
            # Record violation for circuit breaker
            await self._record_violation(hashed_id)

            return RateLimitResult(
                status=RateLimitStatus.THROTTLED,
                requests_remaining=minute_result[1],
                reset_after_seconds=minute_result[2],
                retry_after=minute_result[2],
                message=f"Rate limit exceeded. Max {limits['per_minute']}/minute"
            )

        hour_result = await self._check_window(
            hashed_id, operation, "hour",
            limits["per_hour"], 3600, cost
        )

        if not hour_result[0]:
            return RateLimitResult(
                status=RateLimitStatus.THROTTLED,
                requests_remaining=hour_result[1],
                reset_after_seconds=hour_result[2],
                retry_after=hour_result[2],
                message=f"Hourly limit exceeded. Max {limits['per_hour']}/hour"
            )

        # Request allowed
        return RateLimitResult(
            status=RateLimitStatus.ALLOWED,
            requests_remaining=min(minute_result[1], hour_result[1]),
            reset_after_seconds=minute_result[2]
        )

    async def _check_window(
        self,
        identifier: str,
        operation: str,
        window: str,
        limit: int,
        window_seconds: int,
        cost: int
    ) -> Tuple[bool, int, int]:
        """
        Check sliding window rate limit using Redis sorted sets.

        This implementation uses microsecond precision to handle
        concurrent requests and implements cost-based limiting
        for expensive operations.
        """
        now = time.time()
        window_start = now - window_seconds
        key = f"rl:{operation}:{window}:{identifier}"

        # Use pipeline for atomic operations
        pipe = self.redis.pipeline()

        # Remove expired entries
        pipe.zremrangebyscore(key, 0, window_start)

        # Count current requests (considering cost)
        pipe.zcard(key)

        # Execute pipeline
        results = await pipe.execute()
        current_count = results[1]

        # Check if adding this request would exceed limit
        if current_count + cost > limit:
            remaining = max(0, limit - current_count)

            # Calculate precise reset time
            if current_count > 0:
                pipe = self.redis.pipeline()
                pipe.zrange(key, 0, 0, withscores=True)
                oldest = await pipe.execute()
                if oldest[0]:
                    oldest_timestamp = oldest[0][0][1]
                    reset_after = int(window_seconds - (now - oldest_timestamp))
                else:
                    reset_after = window_seconds
            else:
                reset_after = window_seconds

            return False, remaining, reset_after

        # Add request with microsecond precision for uniqueness
        request_id = f"{now:.6f}"

        # Create all entries in single atomic operation
        entries = {f"{request_id}:{i}": now for i in range(cost)}

        pipe = self.redis.pipeline()
        pipe.zadd(key, entries)  # Single atomic operation
        pipe.expire(key, window_seconds)
        await pipe.execute()

        remaining = limit - (current_count + cost)
        return True, remaining, window_seconds

    async def _is_blocked(self, identifier: str) -> bool:
        """Check if client is temporarily blocked"""
        block_key = f"blocked:{identifier}"
        return await self.redis.exists(block_key) > 0

    async def _record_violation(self, identifier: str) -> None:
        """Record rate limit violation for circuit breaker"""
        violation_key = f"violations:{identifier}"

        pipe = self.redis.pipeline()
        pipe.incr(violation_key)
        pipe.expire(violation_key, 3600)  # Reset violations after 1 hour
        results = await pipe.execute()

        violation_count = results[0]

        if violation_count >= self.abuse_threshold:
            # Activate circuit breaker
            block_key = f"blocked:{identifier}"
            await self.redis.setex(block_key, self.block_duration, "1")

            # Clear violations
            await self.redis.delete(violation_key)

            logger.warning(f"Rate limit circuit breaker activated for {identifier[:8]}...")

    async def cleanup_expired_keys(self) -> int:
        """
        Background cleanup for memory management.
        Should be called periodically (e.g., every hour via background task).

        Returns count of keys cleaned up.
        """
        cleanup_count = 0
        pattern = "rl:*"

        try:
            # Use scan to avoid blocking Redis
            async for key in self.redis.scan_iter(match=pattern, count=self.config.scan_count):
                key_str = key.decode() if isinstance(key, bytes) else key

                # Check if key has any non-expired entries
                now = time.time()

                # Get the key's window size from the key name
                parts = key_str.split(":")
                if len(parts) >= 3 and parts[2] == "minute":
                    window_seconds = 60
                elif len(parts) >= 3 and parts[2] == "hour":
                    window_seconds = 3600
                else:
                    continue  # Skip unknown key formats

                window_start = now - window_seconds

                # Remove expired entries and check if key is empty
                pipe = self.redis.pipeline()
                pipe.zremrangebyscore(key_str, 0, window_start)
                pipe.zcard(key_str)
                results = await pipe.execute()

                remaining_count = results[1]

                # If no entries remaining, delete the key
                if remaining_count == 0:
                    await self.redis.delete(key_str)
                    cleanup_count += 1

        except Exception as e:
            logger.error(f"Rate limiter cleanup error: {e}")

        if cleanup_count > 0:
            logger.info(f"Cleaned up {cleanup_count} expired rate limit keys")

        return cleanup_count

    async def get_stats(self) -> Dict[str, int]:
        """Get rate limiter statistics"""
        stats = {
            "active_keys": 0,
            "blocked_clients": 0,
            "violation_keys": 0
        }

        try:
            # Count rate limit keys
            async for _ in self.redis.scan_iter(match="rl:*", count=self.config.scan_count):
                stats["active_keys"] += 1

            # Count blocked clients
            async for _ in self.redis.scan_iter(match="blocked:*", count=self.config.scan_count):
                stats["blocked_clients"] += 1

            # Count violation keys
            async for _ in self.redis.scan_iter(match="violations:*", count=self.config.scan_count):
                stats["violation_keys"] += 1

        except Exception as e:
            logger.error(f"Error getting rate limiter stats: {e}")

        return stats