"""
app/routes/api.py — All FastAPI route definitions for SUPREME.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.models.trial import (
    ControlRequest,
    CreateCaseRequest,
)
from app.services import trial_service
from app.tools.rag import rag_diagnostics

router = APIRouter()


# ── Health ─────────────────────────────────────────────────────────────────────

@router.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}


@router.get("/api/debug/rag", tags=["debug"])
async def debug_rag():
    """Inspect current RAG + Qdrant runtime health."""
    return rag_diagnostics()


# ── Case / Session ─────────────────────────────────────────────────────────────

@router.post("/api/case", tags=["trial"])
async def create_case(req: CreateCaseRequest):
    """Create a new trial session. Returns the session_id."""
    return await trial_service.create_case(req)


@router.get("/api/session/{session_id}", tags=["trial"])
async def get_session(session_id: str):
    """Return the full transcript and current state for a session."""
    state = await trial_service.get_session(session_id)
    return state.model_dump()


# ── Turn-by-turn control ────────────────────────────────────────────────────────

@router.post("/api/session/{session_id}/next", tags=["trial"])
async def next_turn(session_id: str):
    """Run the next agent turn. Core demo endpoint."""
    return await trial_service.next_turn(session_id)


@router.post("/api/session/{session_id}/control", tags=["trial"])
async def control(session_id: str, req: ControlRequest):
    """
    Apply a user control action to the trial.

    Actions:
      - objection        → inserts an objection entry
      - redact           → marks matching entries as redacted (payload = search string)
      - inject_testimony → injects user text as witness testimony (payload = text)
    """
    return await trial_service.control(session_id, req)


@router.post("/api/session/{session_id}/verdict", tags=["trial"])
async def force_verdict(session_id: str):
    """Force the judge to deliver the verdict immediately."""
    return await trial_service.force_verdict(session_id)


@router.post("/api/session/{session_id}/reset", tags=["trial"])
async def reset_trial(session_id: str):
    """Reset the trial back to the opening stage, preserving the case."""
    return await trial_service.reset_trial(session_id)


@router.post("/api/session/{session_id}/fast-forward", tags=["trial"])
async def fast_forward(session_id: str):
    """Skip all remaining stages and jump straight to the verdict."""
    return await trial_service.fast_forward_trial(session_id)
