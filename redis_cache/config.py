"""
Redis Configuration Management
Centralized configuration for all Redis operations.
"""

import os
from dataclasses import dataclass
from typing import Dict, Any, Optional


@dataclass
class RedisConfig:
    """Centralized Redis configuration"""

    # Connection settings
    redis_url: str = "redis://localhost:6379/0"
    max_connections: int = 20
    socket_timeout: float = 5.0
    socket_connect_timeout: float = 5.0
    socket_keepalive: bool = True
    socket_keepalive_options: Dict[int, int] = None

    # Cache settings
    default_ttl: int = 600  # 10 minutes
    compression_threshold: int = 1024

    # Maze cache settings
    maze_cache_ttl: int = 3600  # 1 hour for maze ranges
    max_cache_entries: int = 1000
    cleanup_interval: int = 3600  # 1 hour

    # Rate limiting settings
    rate_limit_default_per_minute: int = 30
    rate_limit_default_per_hour: int = 500
    rate_limit_solve_per_minute: int = 15
    rate_limit_solve_per_hour: int = 200
    rate_limit_visualize_per_minute: int = 20
    rate_limit_visualize_per_hour: int = 300
    rate_limit_abuse_threshold: int = 3
    rate_limit_block_duration: int = 900  # 15 minutes

    # Performance settings
    pipeline_size: int = 100
    scan_count: int = 100

    def __post_init__(self):
        """Set default socket keepalive options if not provided"""
        if self.socket_keepalive_options is None:
            self.socket_keepalive_options = {
                1: 1,  # TCP_KEEPIDLE
                2: 1,  # TCP_KEEPINTVL
                3: 3,  # TCP_KEEPCNT
            }

    @classmethod
    def from_env(cls) -> 'RedisConfig':
        """Create configuration from environment variables"""
        return cls(
            redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
            max_connections=int(os.getenv("REDIS_MAX_CONNECTIONS", "20")),
            socket_timeout=float(os.getenv("REDIS_SOCKET_TIMEOUT", "5.0")),
            socket_connect_timeout=float(os.getenv("REDIS_CONNECT_TIMEOUT", "5.0")),
            socket_keepalive=os.getenv("REDIS_KEEPALIVE", "true").lower() == "true",

            default_ttl=int(os.getenv("CACHE_TTL", "600")),
            compression_threshold=int(os.getenv("COMPRESSION_THRESHOLD", "1024")),

            maze_cache_ttl=int(os.getenv("MAZE_CACHE_TTL", "3600")),
            max_cache_entries=int(os.getenv("MAX_CACHE_ENTRIES", "1000")),
            cleanup_interval=int(os.getenv("CACHE_CLEANUP_INTERVAL", "3600")),

            rate_limit_default_per_minute=int(os.getenv("RATE_LIMIT_DEFAULT_PER_MINUTE", "30")),
            rate_limit_default_per_hour=int(os.getenv("RATE_LIMIT_DEFAULT_PER_HOUR", "500")),
            rate_limit_solve_per_minute=int(os.getenv("RATE_LIMIT_SOLVE_PER_MINUTE", "15")),
            rate_limit_solve_per_hour=int(os.getenv("RATE_LIMIT_SOLVE_PER_HOUR", "200")),
            rate_limit_visualize_per_minute=int(os.getenv("RATE_LIMIT_VISUALIZE_PER_MINUTE", "20")),
            rate_limit_visualize_per_hour=int(os.getenv("RATE_LIMIT_VISUALIZE_PER_HOUR", "300")),
            rate_limit_abuse_threshold=int(os.getenv("RATE_LIMIT_ABUSE_THRESHOLD", "3")),
            rate_limit_block_duration=int(os.getenv("RATE_LIMIT_BLOCK_DURATION", "900")),

            pipeline_size=int(os.getenv("REDIS_PIPELINE_SIZE", "100")),
            scan_count=int(os.getenv("REDIS_SCAN_COUNT", "100")),
        )

    def get_pool_config(self) -> Dict[str, Any]:
        """Get connection pool configuration dict"""
        return {
            "max_connections": self.max_connections,
            "socket_timeout": self.socket_timeout,
            "socket_connect_timeout": self.socket_connect_timeout,
            "socket_keepalive": self.socket_keepalive,
            "socket_keepalive_options": self.socket_keepalive_options,
        }

    def get_rate_limits(self) -> Dict[str, Dict[str, int]]:
        """Get rate limiting configuration"""
        return {
            "default": {
                "per_minute": self.rate_limit_default_per_minute,
                "per_hour": self.rate_limit_default_per_hour,
            },
            "solve": {
                "per_minute": self.rate_limit_solve_per_minute,
                "per_hour": self.rate_limit_solve_per_hour,
            },
            "visualize": {
                "per_minute": self.rate_limit_visualize_per_minute,
                "per_hour": self.rate_limit_visualize_per_hour,
            },
        }


# Global configuration instance
_config_instance: Optional[RedisConfig] = None


def get_redis_config() -> RedisConfig:
    """Get the global Redis configuration"""
    global _config_instance
    if _config_instance is None:
        _config_instance = RedisConfig.from_env()
    return _config_instance


def reset_config():
    """Reset configuration (mainly for testing)"""
    global _config_instance
    _config_instance = None