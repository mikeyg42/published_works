"""
FastAPI middleware integration for rate limiting
"""
import time
from typing import Callable
from fastapi import Request, Response, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from redis_cache.rate_limiting import AdaptiveRateLimiter, RateLimitStatus


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    FastAPI middleware for adaptive rate limiting
    Uses rate limiter from app state to avoid duplicate Redis clients
    """

    def __init__(self, app):
        super().__init__(app)
        self.app = app  # Store reference to get rate limiter from state

        # Define operation mapping for different endpoints
        self.operation_mapping = {
            "/api/maze-solver": "solve",
            "/api/rest/maze-solver": "solve",
            "/api/visualize": "visualize",
            "/api/rest/visualize": "visualize",
        }

    def _get_client_identifier(self, request: Request) -> str:
        """Extract client identifier from request"""
        # Check for forwarded IP first (for proxy setups)
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            client_ip = forwarded_for.split(",")[0].strip()
        elif request.client:
            client_ip = request.client.host
        else:
            client_ip = "unknown"

        # Optional: Include user agent for more specific identification
        user_agent = request.headers.get("User-Agent", "")[:50]  # First 50 chars
        return f"{client_ip}:{hash(user_agent) % 10000}"

    def _get_operation(self, path: str) -> str:
        """Determine operation type from request path"""
        for endpoint, operation in self.operation_mapping.items():
            if path.startswith(endpoint):
                return operation
        return "default"

    def _should_skip_rate_limiting(self, path: str) -> bool:
        """Check if path should be excluded from rate limiting"""
        skip_paths = [
            "/health",
            "/metrics",
            "/docs",
            "/redoc",
            "/openapi.json",
            "/static/",
            "/favicon.ico"
        ]

        return any(path.startswith(skip_path) for skip_path in skip_paths)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Main middleware logic"""
        # Skip rate limiting for certain paths
        if self._should_skip_rate_limiting(request.url.path):
            return await call_next(request)

        # Get client and operation info
        client_id = self._get_client_identifier(request)
        operation = self._get_operation(request.url.path)

        # Determine cost (expensive operations cost more)
        cost = 2 if operation == "solve" else 1

        try:
            # Get rate limiter from app state
            rate_limiter = getattr(self.app.state, 'rate_limiter', None)
            if not rate_limiter:
                # If rate limiter not available, skip rate limiting
                return await call_next(request)

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
            print(f"Rate limiting error: {e}")
            return await call_next(request)


def create_rate_limit_middleware():
    """Factory function to create rate limiting middleware"""
    def middleware_factory(app):
        return RateLimitMiddleware(app)
    return middleware_factory