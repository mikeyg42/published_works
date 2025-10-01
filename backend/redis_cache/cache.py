# redis_cache.py ──────────────────────────────────────────────────────────────
import os, pickle, zlib, time
import redis.asyncio as redis
from typing import Any

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
TTL_SEC   = int(os.getenv("MAZE_CACHE_TTL", "600"))   # 10 min default

_pool = redis.ConnectionPool.from_url(REDIS_URL, decode_responses=False)
r     = redis.Redis(connection_pool=_pool)

# key helpers ---------------------------------------------------------------
def _k(sess: str) -> str:            # namespace keys
    return f"maze:{sess}"

# public API ---------------------------------------------------------------
async def save(session_id: str, data: dict, solutions: list[list[str]]) -> None:
    blob = zlib.compress(pickle.dumps((data, solutions, time.time())))
    await r.set(_k(session_id), blob, ex=TTL_SEC)

async def fetch(session_id: str) -> tuple[dict, list[list[str]]] | None:
    blob = await r.get(_k(session_id))
    if not blob:
        return None
    data, sol, _ts = pickle.loads(zlib.decompress(blob))
    return data, sol
