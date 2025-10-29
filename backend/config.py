"""
Application configuration
"""
import os


class Settings:
    """Application settings and configuration"""

    # Environment
    ENVIRONMENT: str = os.environ.get("ENVIRONMENT", "production").lower()

    # API Configuration
    API_TITLE: str = "Maze Solver API"
    API_DESCRIPTION: str = "Professional maze solving and visualization API"
    API_VERSION: str = "2.0.0"

    # External Services
    GPU_RENDERER_URL: str = os.environ.get(
        "GPU_RENDERER_URL",
        "https://gpu-maze-renderer-acn3zn6u4a-uc.a.run.app"
    )

    # CORS Configuration
    @property
    def CORS_ORIGINS(self) -> list:
        if self.ENVIRONMENT == "development":
            return [
                "https://localhost:4200",    # Angular default
                "https://localhost:3000",    # React/Next.js default
                "https://localhost:8000",    # FastAPI/Django default
                "https://localhost:8080",    # General development
                "https://127.0.0.1:4200",
                "https://127.0.0.1:3000",
                "https://127.0.0.1:8000",
                "https://127.0.0.1:8080",
            ]
        return ["https://michaelglendinning.com"]

    @property
    def TRUSTED_HOSTS(self) -> list:
        hosts = ["michaelglendinning.com", "*"]
        if self.ENVIRONMENT == "development":
            hosts.extend(["localhost", "127.0.0.1"])
        return list(set(hosts))

    # Headers
    CORS_ALLOW_HEADERS = [
        "Accept",
        "Accept-Language",
        "Content-Language",
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Device-Fingerprint",
        "X-Request-ID",
    ]

    CORS_EXPOSE_HEADERS = [
        "X-Process-Time",
        "X-Request-ID",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "Retry-After"
    ]

# Global settings instance
settings = Settings()