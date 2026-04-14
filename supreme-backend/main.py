"""
main.py — SUPREME Courtroom Simulator entry point.
"""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.exceptions import AuthenticationError as RedisAuthenticationError
from redis.exceptions import ConnectionError as RedisConnectionError

from app.models.session_store import session_store
from app.routes.api import router
from config import APP_HOST, APP_PORT, APP_LOG_LEVEL, CORS_ORIGINS, DEMO_MODE

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, APP_LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("supreme")

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="SUPREME — AI Courtroom Simulator",
    description=(
        "Multi-agent courtroom simulation: Prosecution vs Defense vs Judge. "
        "Powered by OpenRouter (free models) + Qdrant RAG + Redis session state."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── CORS (open for demo) ──────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    started_at = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = (time.perf_counter() - started_at) * 1000
        logger.exception(
            "Request failed | id=%s method=%s path=%s duration_ms=%.2f",
            request_id,
            request.method,
            request.url.path,
            duration_ms,
        )
        raise

    duration_ms = (time.perf_counter() - started_at) * 1000
    response.headers["X-Request-ID"] = request_id
    logger.info(
        "Request complete | id=%s method=%s path=%s status=%s duration_ms=%.2f",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(router)

# ── Static frontend (optional) ────────────────────────────────────────────────
@app.get("/", tags=["meta"])
async def root():
    return {
        "status": "ok",
        "message": "Backend is running. Use the frontend on port 3000.",
        "docs_url": "/docs",
    }


# ── Lifecycle ─────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def on_startup():
    mode = "DEMO" if DEMO_MODE else "PRODUCTION"
    logger.info("SUPREME Courtroom Simulator starting — mode: %s log_level=%s", mode, APP_LOG_LEVEL)


@app.on_event("shutdown")
async def on_shutdown():
    await session_store.close()
    logger.info("Redis connection closed.")


# ── Global error handler ─────────────────────────────────────────────────────
def _request_id_from(request: Request) -> str:
    return getattr(request.state, "request_id", "unknown")


@app.exception_handler(RedisAuthenticationError)
async def redis_auth_exception_handler(request: Request, exc: RedisAuthenticationError):
    request_id = _request_id_from(request)
    logger.error("Redis auth failed | id=%s path=%s error=%s", request_id, request.url.path, exc)
    return JSONResponse(
        status_code=503,
        headers={"X-Request-ID": request_id},
        content={
            "detail": "Redis authentication failed.",
            "code": "REDIS_AUTH_FAILED",
            "hint": "Check REDIS_URL credentials in supreme-backend/.env.",
            "request_id": request_id,
        },
    )


@app.exception_handler(RedisConnectionError)
async def redis_connection_exception_handler(request: Request, exc: RedisConnectionError):
    request_id = _request_id_from(request)
    logger.error("Redis connection failed | id=%s path=%s error=%s", request_id, request.url.path, exc)
    return JSONResponse(
        status_code=503,
        headers={"X-Request-ID": request_id},
        content={
            "detail": "Redis connection failed.",
            "code": "REDIS_CONNECTION_FAILED",
            "hint": "Check REDIS_URL and network access for the session store.",
            "request_id": request_id,
        },
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    request_id = _request_id_from(request)
    logger.exception("Unhandled exception | id=%s url=%s", request_id, request.url)
    return JSONResponse(
        status_code=500,
        headers={"X-Request-ID": request_id},
        content={
            "detail": "Internal server error. The court is in recess.",
            "code": "INTERNAL_SERVER_ERROR",
            "request_id": request_id,
            "debug": {
                "exception_type": exc.__class__.__name__,
                "path": request.url.path,
            } if DEMO_MODE else None,
        },
    )


# ── Dev runner ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=APP_HOST,
        port=APP_PORT,
        reload=True,
        log_level="info",
    )
