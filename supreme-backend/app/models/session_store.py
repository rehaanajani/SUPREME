"""
app/models/session_store.py — Redis-backed async session store.
"""

from __future__ import annotations

import json
import redis.asyncio as aioredis
from redis.exceptions import WatchError

from config import REDIS_URL as _REDIS_URL_RAW, SESSION_TTL

# Upstash requires TLS — auto-upgrade redis:// → rediss:// for upstash hosts
REDIS_URL = (
    _REDIS_URL_RAW.replace("redis://", "rediss://", 1)
    if "upstash.io" in _REDIS_URL_RAW and _REDIS_URL_RAW.startswith("redis://")
    else _REDIS_URL_RAW
)
from app.models.trial import TrialState


class SessionStore:
    """Async wrapper around Redis for serialising/deserialising TrialState."""

    def __init__(self) -> None:
        self._redis: aioredis.Redis | None = None

    async def _get_client(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = await aioredis.from_url(
                REDIS_URL, encoding="utf-8", decode_responses=True
            )
        return self._redis

    # ── Public API ────────────────────────────────────────────────────────────

    async def save(self, state: TrialState) -> None:
        client = await self._get_client()
        key = f"session:{state.session_id}"
        await client.set(key, state.model_dump_json(), ex=SESSION_TTL)

    async def save_if_version(self, state: TrialState, expected_version: int) -> bool:
        client = await self._get_client()
        key = f"session:{state.session_id}"

        while True:
            async with client.pipeline(transaction=True) as pipe:
                try:
                    await pipe.watch(key)
                    raw = await pipe.get(key)
                    if raw is None:
                        await pipe.reset()
                        return False

                    current = json.loads(raw)
                    current_version = int(current.get("version", 0))
                    if current_version != expected_version:
                        await pipe.reset()
                        return False

                    state.version = expected_version + 1
                    state_payload = state.model_dump_json()
                    pipe.multi()
                    pipe.set(key, state_payload, ex=SESSION_TTL)
                    await pipe.execute()
                    return True
                except WatchError:
                    continue

    async def load(self, session_id: str) -> TrialState | None:
        client = await self._get_client()
        key = f"session:{session_id}"
        raw = await client.get(key)
        if raw is None:
            return None
        return TrialState.model_validate(json.loads(raw))

    async def delete(self, session_id: str) -> None:
        client = await self._get_client()
        await client.delete(f"session:{session_id}")

    async def exists(self, session_id: str) -> bool:
        client = await self._get_client()
        return bool(await client.exists(f"session:{session_id}"))

    async def close(self) -> None:
        if self._redis:
            await self._redis.aclose()
            self._redis = None


# Singleton instance shared across the app
session_store = SessionStore()
