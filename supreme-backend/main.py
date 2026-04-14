"""
main.py — SUPREME Courtroom Simulator entry point.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.models.session_store import session_store
from app.routes.api import router
from config import APP_HOST, APP_PORT, DEMO_MODE

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
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
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(router)

# ── Static frontend (optional) ────────────────────────────────────────────────
import os
_static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")


# ── Lifecycle ─────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def on_startup():
    mode = "DEMO" if DEMO_MODE else "PRODUCTION"
    logger.info("SUPREME Courtroom Simulator starting — mode: %s", mode)


@app.on_event("shutdown")
async def on_shutdown():
    await session_store.close()
    logger.info("Redis connection closed.")


# ── Global error handler ─────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s", request.url)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error. The court is in recess."},
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
