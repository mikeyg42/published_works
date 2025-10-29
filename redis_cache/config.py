"""
Redis Cache Configuration
Centralized configuration for all Redis operations.
"""

import os
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List


@dataclass
class RedisConfig:
    """Complete Redis configuration including all subsystems"""
    
    # === Connection Settings ===
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL", "redis://localhost:6379/0"))
    max_connections: int = 20
    socket_timeout: float = 5.0
    socket_connect_timeout: float = 5.0
    socket_keepalive: bool = True
    socket_keepalive_options: Optional[Dict[int, int]] = None
    
    # === Environment ===
    environment: str = field(default_factory=lambda: os.getenv("ENVIRONMENT", "production").lower())
    enable_redis: bool = field(default_factory=lambda: os.getenv("ENABLE_REDIS", "true").lower() == "true")
    
    # === Cache Settings ===
    default_ttl: int = 600  # 10 minutes
    compression_threshold: int = 1024  # Compress data larger than 1KB
    
    # === Maze Cache Settings ===
    maze_cache_ttl: int = 3600  # 1 hour for maze data
    max_cache_entries: int = 1000
    cleanup_interval: int = 3600  # Run cleanup every hour
    maze_cache_enabled: bool = True
    
    # === Rate Limiting Settings ===
    rate_limit_enabled: bool = True
    rate_limits: Dict[str, Dict[str, int]] = field(default_factory=lambda: {
        "default": {"per_minute": 30, "per_hour": 500},
        "solve": {"per_minute": 15, "per_hour": 200},
        "visualize": {"per_minute": 20, "per_hour": 300},
        "query": {"per_minute": 50, "per_hour": 1000},
    })
    rate_limit_abuse_threshold: int = 3
    rate_limit_block_duration: int = 900  # 15 minutes
    
    # === Circuit Breaker Settings ===
    circuit_breaker_failure_threshold: int = 5
    circuit_breaker_recovery_timeout: float = 30.0
    circuit_breaker_half_open_calls: int = 3
    
    # === Performance Settings ===
    pipeline_size: int = 100
    scan_count: int = 100
    health_check_interval: int = 30  # seconds
    
    # === CORS and Security (moved from backend/config.py) ===
    @property
    def cors_origins(self) -> List[str]:
        """Get CORS origins based on environment"""
        if self.environment == "development":
            return [
                "https://localhost:4200",
                "https://localhost:3000", 
                "https://127.0.0.1:4200",
                "https://127.0.0.1:3000",
                "https://127.0.0.1:8080",
            ]
        return ["https://michaelglendinning.com"]
    
    @property
    def trusted_hosts(self) -> List[str]:
        """Get trusted hosts based on environment"""
        hosts = ["michaelglendinning.com", "*"]
        if self.environment == "development":
            hosts.extend(["localhost", "127.0.0.1"])
        return list(set(hosts))
    
    cors_allow_headers: List[str] = field(default_factory=lambda: [
        "Accept",
        "Accept-Language",
        "Content-Language",
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Device-Fingerprint",
        "X-Request-ID",
    ])
    
    cors_expose_headers: List[str] = field(default_factory=lambda: [
        "X-Process-Time",
        "X-Request-ID",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "Retry-After"
    ])
    
    def __post_init__(self):
        """Post-initialization setup"""
        if self.socket_keepalive_options is None:
            self.socket_keepalive_options = {
                1: 1,  # TCP_KEEPIDLE
                2: 1,  # TCP_KEEPINTVL
                3: 3,  # TCP_KEEPCNT
            }
    
    @classmethod
    def from_env(cls) -> 'RedisConfig':
        """Create configuration from environment variables"""
        # Parse rate limits from environment if provided
        rate_limits = {}
        for operation in ["default", "solve", "visualize", "query"]:
            per_min_key = f"RATE_LIMIT_{operation.upper()}_PER_MINUTE"
            per_hour_key = f"RATE_LIMIT_{operation.upper()}_PER_HOUR"
            
            per_min = os.getenv(per_min_key)
            per_hour = os.getenv(per_hour_key)
            
            if per_min and per_hour:
                rate_limits[operation] = {
                    "per_minute": int(per_min),
                    "per_hour": int(per_hour)
                }
        
        config = cls(
            redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
            max_connections=int(os.getenv("REDIS_MAX_CONNECTIONS", "20")),
            socket_timeout=float(os.getenv("REDIS_SOCKET_TIMEOUT", "5.0")),
            socket_connect_timeout=float(os.getenv("REDIS_CONNECT_TIMEOUT", "5.0")),
            socket_keepalive=os.getenv("REDIS_KEEPALIVE", "true").lower() == "true",
            
            environment=os.getenv("ENVIRONMENT", "production").lower(),
            enable_redis=os.getenv("ENABLE_REDIS", "true").lower() == "true",
            
            default_ttl=int(os.getenv("CACHE_TTL", "600")),
            compression_threshold=int(os.getenv("COMPRESSION_THRESHOLD", "1024")),
            
            maze_cache_ttl=int(os.getenv("MAZE_CACHE_TTL", "3600")),
            max_cache_entries=int(os.getenv("MAX_CACHE_ENTRIES", "1000")),
            cleanup_interval=int(os.getenv("CACHE_CLEANUP_INTERVAL", "3600")),
            maze_cache_enabled=os.getenv("MAZE_CACHE_ENABLED", "true").lower() == "true",
            
            rate_limit_enabled=os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true",
            rate_limit_abuse_threshold=int(os.getenv("RATE_LIMIT_ABUSE_THRESHOLD", "3")),
            rate_limit_block_duration=int(os.getenv("RATE_LIMIT_BLOCK_DURATION", "900")),
            
            circuit_breaker_failure_threshold=int(os.getenv("CIRCUIT_BREAKER_THRESHOLD", "5")),
            circuit_breaker_recovery_timeout=float(os.getenv("CIRCUIT_BREAKER_TIMEOUT", "30.0")),
            
            pipeline_size=int(os.getenv("REDIS_PIPELINE_SIZE", "100")),
            scan_count=int(os.getenv("REDIS_SCAN_COUNT", "100")),
            health_check_interval=int(os.getenv("HEALTH_CHECK_INTERVAL", "30")),
        )
        
        # Override rate limits if any were parsed from environment
        if rate_limits:
            config.rate_limits.update(rate_limits)
        
        return config
    
    def get_pool_config(self) -> Dict[str, Any]:
        """Get connection pool configuration"""
        return {
            "max_connections": self.max_connections,
            "socket_timeout": self.socket_timeout,
            "socket_connect_timeout": self.socket_connect_timeout,
            "socket_keepalive": self.socket_keepalive,
            "socket_keepalive_options": self.socket_keepalive_options,
        }
    
    def is_enabled(self) -> bool:
        """Check if Redis should be enabled"""
        return self.enable_redis
    
    def is_rate_limiting_enabled(self) -> bool:
        """Check if rate limiting should be enabled"""
        return self.enable_redis and self.rate_limit_enabled
    
    def is_maze_cache_enabled(self) -> bool:
        """Check if maze caching should be enabled"""
        return self.enable_redis and self.maze_cache_enabled


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
