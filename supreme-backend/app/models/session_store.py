"""
app/models/session_store.py — pluggable async session store.

Supports:
- sqlite (default)
- redis (optional)
- memory (ephemeral)
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

from app.models.trial import TrialState
from config import REDIS_URL as _REDIS_URL_RAW, SESSION_BACKEND, SESSION_SQLITE_PATH, SESSION_TTL


class SessionStoreProtocol(Protocol):
    async def save(self, state: TrialState) -> None: ...

    async def load(self, session_id: str) -> TrialState | None: ...

    async def delete(self, session_id: str) -> None: ...

    async def exists(self, session_id: str) -> bool: ...

    async def list_all(self) -> list[dict[str, Any]]: ...

    async def close(self) -> None: ...


class MemorySessionStore:
    """In-process session storage (clears on restart)."""

    def __init__(self) -> None:
        self._data: dict[str, tuple[str, float]] = {}

    @staticmethod
    def _expires_at() -> float:
        return time.time() + SESSION_TTL

    def _is_expired(self, session_id: str) -> bool:
        row = self._data.get(session_id)
        if row is None:
            return True
        _, expires_at = row
        if expires_at > time.time():
            return False
        self._data.pop(session_id, None)
        return True

    async def save(self, state: TrialState) -> None:
        self._data[state.session_id] = (state.model_dump_json(), self._expires_at())

    async def load(self, session_id: str) -> TrialState | None:
        if self._is_expired(session_id):
            return None
        raw, _ = self._data[session_id]
        return TrialState.model_validate(json.loads(raw))

    async def delete(self, session_id: str) -> None:
        self._data.pop(session_id, None)

    async def exists(self, session_id: str) -> bool:
        return not self._is_expired(session_id)

    async def list_all(self) -> list[dict[str, Any]]:
        results = []
        for sid, (raw, expires_at) in list(self._data.items()):
            if expires_at <= time.time():
                continue
            try:
                data = json.loads(raw)
                results.append({
                    "session_id": sid,
                    "title": data.get("case", {}).get("title", "Untitled"),
                    "stage": data.get("stage", "unknown"),
                    "created_at": data.get("created_at"),
                    "updated_at": data.get("updated_at"),
                })
            except Exception:
                pass
        return results

    async def close(self) -> None:
        self._data.clear()


class SQLiteSessionStore:
    """SQLite-backed session storage with TTL cleanup."""

    def __init__(self, db_path: str) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._init_db()

    @staticmethod
    def _expires_at() -> int:
        return int(time.time()) + SESSION_TTL

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        conn = self._connect()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)"
            )
            conn.commit()
        finally:
            conn.close()

    async def _cleanup_expired(self) -> None:
        now = int(time.time())

        def _run() -> None:
            conn = self._connect()
            try:
                conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
                conn.commit()
            finally:
                conn.close()

        await asyncio.to_thread(_run)

    async def save(self, state: TrialState) -> None:
        async with self._lock:
            payload = state.model_dump_json()
            expires_at = self._expires_at()
            updated_at = int(time.time())

            def _run() -> None:
                conn = self._connect()
                try:
                    conn.execute(
                        """
                        INSERT INTO sessions(session_id, payload, expires_at, updated_at)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(session_id) DO UPDATE SET
                            payload=excluded.payload,
                            expires_at=excluded.expires_at,
                            updated_at=excluded.updated_at
                        """,
                        (state.session_id, payload, expires_at, updated_at),
                    )
                    conn.commit()
                finally:
                    conn.close()

            await asyncio.to_thread(_run)

    async def load(self, session_id: str) -> TrialState | None:
        await self._cleanup_expired()

        def _run() -> str | None:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT payload FROM sessions WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
                return row["payload"] if row else None
            finally:
                conn.close()

        raw = await asyncio.to_thread(_run)
        if raw is None:
            return None
        return TrialState.model_validate(json.loads(raw))

    async def delete(self, session_id: str) -> None:
        def _run() -> None:
            conn = self._connect()
            try:
                conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
                conn.commit()
            finally:
                conn.close()

        await asyncio.to_thread(_run)

    async def exists(self, session_id: str) -> bool:
        await self._cleanup_expired()

        def _run() -> bool:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT 1 FROM sessions WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
                return row is not None
            finally:
                conn.close()

        return await asyncio.to_thread(_run)

    async def list_all(self) -> list[dict[str, Any]]:
        await self._cleanup_expired()

        def _run() -> list[dict[str, Any]]:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT session_id, payload FROM sessions ORDER BY updated_at DESC"
                ).fetchall()
                results = []
                for row in rows:
                    try:
                        data = json.loads(row["payload"])
                        results.append({
                            "session_id": row["session_id"],
                            "title": data.get("case", {}).get("title", "Untitled"),
                            "stage": data.get("stage", "unknown"),
                            "created_at": data.get("created_at"),
                            "updated_at": data.get("updated_at"),
                        })
                    except Exception:
                        pass
                return results
            finally:
                conn.close()

        return await asyncio.to_thread(_run)

    async def close(self) -> None:
        return None


class RedisSessionStore:
    """Redis-backed async session storage."""

    def __init__(self, redis_url_raw: str) -> None:
        self._redis = None
        self._redis_url = (
            redis_url_raw.replace("redis://", "rediss://", 1)
            if "upstash.io" in redis_url_raw and redis_url_raw.startswith("redis://")
            else redis_url_raw
        )

    async def _get_client(self):
        if self._redis is None:
            aioredis = importlib.import_module("redis.asyncio")

            self._redis = await aioredis.from_url(
                self._redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
        return self._redis

    async def save(self, state: TrialState) -> None:
        client = await self._get_client()
        key = f"session:{state.session_id}"
        await client.set(key, state.model_dump_json(), ex=SESSION_TTL)

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


def _redact_redis_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    host = parsed.hostname or ""
    port = parsed.port or 6379
    scheme = parsed.scheme or "redis"
    return f"{scheme}://{host}:{port}"


async def session_store_diagnostics() -> dict[str, Any]:
    payload: dict[str, Any] = {
        "backend": SESSION_BACKEND,
        "ttl_seconds": SESSION_TTL,
    }

    if isinstance(session_store, SQLiteSessionStore):
        db_path = session_store._db_path

        def _row_count() -> int:
            conn = session_store._connect()
            try:
                row = conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()
                return int(row["n"]) if row else 0
            finally:
                conn.close()

        payload.update(
            {
                "db_path": str(db_path),
                "db_exists": db_path.exists(),
                "db_size_bytes": db_path.stat().st_size if db_path.exists() else 0,
                "session_rows": await asyncio.to_thread(_row_count),
            }
        )
        return payload

    if isinstance(session_store, MemorySessionStore):
        active_ids = [sid for sid in list(session_store._data.keys()) if not session_store._is_expired(sid)]
        payload.update({"active_sessions": len(active_ids)})
        return payload

    if isinstance(session_store, RedisSessionStore):
        payload.update(
            {
                "redis_target": _redact_redis_url(session_store._redis_url),
            }
        )
        try:
            client = await session_store._get_client()
            pong = await client.ping()
            payload.update({"connected": bool(pong)})
        except Exception as exc:
            payload.update({"connected": False, "error": f"{exc.__class__.__name__}: {exc}"})
        return payload

    payload.update({"error": "Unknown session store backend instance."})
    return payload


def _build_store() -> SessionStoreProtocol:
    backend = SESSION_BACKEND
    if backend == "memory":
        return MemorySessionStore()
    if backend == "redis":
        return RedisSessionStore(_REDIS_URL_RAW)
    return SQLiteSessionStore(SESSION_SQLITE_PATH)


session_store: SessionStoreProtocol = _build_store()
