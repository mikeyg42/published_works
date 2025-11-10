"""
Redis Cache Middleware
FastAPI middleware for Redis-based features (rate limiting, caching headers, etc.)
"""
import time
import logging
import hashlib
from typing import Callable, Optional
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .models import RateLimitStatus

logger = logging.getLogger(__name__)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    FastAPI middleware for adaptive rate limiting using Redis
    """

    # Define operation mapping for different endpoints
    OPERATION_MAPPING = {
        "/api/maze-solver": "solve",
        "/api/rest/maze-solver": "solve",
        "/api/generate-and-solve": "solve",
        "/api/visualize": "visualize",
        "/api/rest/visualize": "visualize",
        "/api/cache/query": "query",
        "/api/streamlined": "solve",
    }
    
    # Paths to skip rate limiting
    SKIP_PATHS = [
        "/health",
        "/metrics", 
        "/docs",
        "/redoc",
        "/openapi.json",
        "/static/",
        "/favicon.ico"
    ]

    def __init__(self, app):
        super().__init__(app)
        self.app = app

    def _get_client_identifier(self, request: Request) -> str:
        """Extract client identifier from request with device fingerprint support"""
        # Check for explicit device fingerprint in headers
        device_fingerprint = request.headers.get("X-Device-Fingerprint")
        if device_fingerprint and device_fingerprint != "default":
            # Hash the device fingerprint for privacy
            return hashlib.sha256(device_fingerprint.encode()).hexdigest()[:16]

        # Fallback to IP + User Agent based identification
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            client_ip = forwarded_for.split(",")[0].strip()
        elif request.client:
            client_ip = request.client.host
        else:
            client_ip = "unknown"

        user_agent = request.headers.get("User-Agent", "")[:50]
        identifier = f"{client_ip}:{hash(user_agent) % 10000}"
        return hashlib.sha256(identifier.encode()).hexdigest()[:16]

    def _get_operation(self, path: str) -> str:
        """Determine operation type from request path"""
        for endpoint, operation in self.OPERATION_MAPPING.items():
            if path.startswith(endpoint):
                return operation
        return "default"

    def _should_skip_rate_limiting(self, path: str) -> bool:
        """Check if path should be excluded from rate limiting"""
        return any(path.startswith(skip_path) for skip_path in self.SKIP_PATHS)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Main middleware logic"""
        # Skip rate limiting for certain paths
        if self._should_skip_rate_limiting(request.url.path):
            return await call_next(request)

        # Get rate limiter from app state (injected by setup)
        rate_limiter = getattr(request.app.state, 'rate_limiter', None)
        if not rate_limiter:
            # If rate limiter not available (Redis down), allow request
            logger.warning("Rate limiter not available, allowing request")
            return await call_next(request)

        # Get client and operation info
        client_id = self._get_client_identifier(request)
        operation = self._get_operation(request.url.path)

        # Determine cost (expensive operations cost more)
        cost = 2 if operation == "solve" else 1

        try:
            # Check rate limit
            result = await rate_limiter.check_rate_limit(
                identifier=client_id,
                operation=operation,
                cost=cost
            )

            # Handle rate limit exceeded
            if result.status == RateLimitStatus.BLOCKED:
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": "Client blocked",
                        "message": result.message,
                        "retry_after": result.retry_after
                    },
                    headers=result.to_headers()
                )

            elif result.status == RateLimitStatus.THROTTLED:
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": "Rate limit exceeded",
                        "message": result.message,
                        "retry_after": result.retry_after
                    },
                    headers=result.to_headers()
                )

            # Process request normally
            start_time = time.time()
            response = await call_next(request)
            process_time = time.time() - start_time

            # Add rate limit headers to response
            for header, value in result.to_headers().items():
                response.headers[header] = value

            response.headers["X-Process-Time"] = str(round(process_time, 4))

            return response

        except Exception as e:
            # Log error but don't block request if rate limiting fails
            logger.error(f"Rate limiting error: {e}")
            return await call_next(request)


class CacheHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware to add cache-related headers to responses
    """
    
    def __init__(self, app):
        super().__init__(app)
        self.app = app
    
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Add cache status headers to responses"""
        response = await call_next(request)
        
        # Add cache status header if cache is available
        cache = getattr(request.app.state, 'cache', None)
        if cache:
            response.headers["X-Cache-Status"] = "enabled"
        else:
            response.headers["X-Cache-Status"] = "disabled"
        
        # Add cache hit/miss headers for cached endpoints
        if request.url.path.startswith("/api/cache"):
            cache_hit = response.status_code == 200 and "cache_hits" in response.body.decode()
            response.headers["X-Cache-Hit"] = "true" if cache_hit else "false"
        
        return response


class RedisHealthCheckMiddleware(BaseHTTPMiddleware):
    """
    Middleware to monitor Redis connection health
    """
    
    def __init__(self, app):
        super().__init__(app)
        self.app = app
        self.last_check = 0
        self.check_interval = 60  # Check every 60 seconds
        self.is_healthy = True
    
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Monitor Redis health and add warning headers if unhealthy"""
        current_time = time.time()
        
        # Periodic health check
        if current_time - self.last_check > self.check_interval:
            self.last_check = current_time
            cache = getattr(request.app.state, 'cache', None)
            
            if cache:
                try:
                    # Quick ping to check Redis health
                    await cache.client.ping()
                    self.is_healthy = True
                except Exception as e:
                    logger.error(f"Redis health check failed: {e}")
                    self.is_healthy = False
            else:
                self.is_healthy = False
        
        response = await call_next(request)
        
        # Add health status header
        response.headers["X-Redis-Health"] = "healthy" if self.is_healthy else "degraded"
        
        return response


def create_rate_limit_middleware():
    """Factory function to create rate limiting middleware"""
    def middleware_factory(app):
        return RateLimitMiddleware(app)
    return middleware_factory


def create_cache_headers_middleware():
    """Factory function to create cache headers middleware"""
    def middleware_factory(app):
        return CacheHeadersMiddleware(app)
    return middleware_factory


def create_redis_health_middleware():
    """Factory function to create Redis health check middleware"""
    def middleware_factory(app):
        return RedisHealthCheckMiddleware(app)
    return middleware_factory
