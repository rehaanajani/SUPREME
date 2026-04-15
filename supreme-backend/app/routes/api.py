"""
app/routes/api.py — All FastAPI route definitions for SUPREME.
"""

from __future__ import annotations

import io
import logging

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse

from app.models.trial import (
    ControlRequest,
    CreateCaseRequest,
)
from app.models.session_store import session_store, session_store_diagnostics
from app.services import trial_service
from app.tools.rag import rag_diagnostics

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Evidence File Upload ──────────────────────────────────────────────────────

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


def _extract_text_from_pdf(data: bytes) -> list[str]:
    """Extract text from a PDF using PyMuPDF."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=data, filetype="pdf")
        lines: list[str] = []
        for page in doc:
            text = page.get_text().strip()
            if text:
                lines.append(text)
        doc.close()
        return lines if lines else ["[PDF uploaded — no extractable text found]"]
    except Exception as exc:
        logger.warning("PDF extraction failed: %s", exc)
        return [f"[PDF uploaded — extraction error: {exc}]"]


def _describe_image(filename: str) -> list[str]:
    """Return a placeholder evidence entry for an uploaded image."""
    return [f"[Image evidence uploaded: {filename}]"]


@router.post("/api/upload-evidence", tags=["evidence"])
async def upload_evidence(file: UploadFile = File(...)):
    """
    Accept a PDF or image file and return extracted text as evidence lines.
    Supported: .pdf, .png, .jpg, .jpeg, .webp, .bmp, .tiff
    """
    if not file.filename:
        return JSONResponse(status_code=400, content={"error": "No file provided"})

    raw = await file.read()
    if len(raw) > MAX_FILE_SIZE:
        return JSONResponse(status_code=413, content={"error": f"File exceeds {MAX_FILE_SIZE // (1024*1024)} MB limit"})

    ext = (file.filename.rsplit(".", 1)[-1] if "." in file.filename else "").lower()

    if ext == "pdf":
        evidence_lines = _extract_text_from_pdf(raw)
    elif ext in ("png", "jpg", "jpeg", "webp", "bmp", "tiff"):
        evidence_lines = _describe_image(file.filename)
    else:
        return JSONResponse(
            status_code=400,
            content={"error": f"Unsupported file type: .{ext}. Use PDF or image files."},
        )

    return {
        "filename": file.filename,
        "type": "pdf" if ext == "pdf" else "image",
        "evidence_lines": evidence_lines,
        "total_lines": len(evidence_lines),
    }


# ── Health ─────────────────────────────────────────────────────────────────────

@router.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}


@router.get("/api/debug/rag", tags=["debug"])
async def debug_rag():
    """Inspect current RAG + Qdrant runtime health."""
    return rag_diagnostics()


@router.get("/api/debug/session-store", tags=["debug"])
async def debug_session_store():
    """Inspect current session-store backend and health."""
    return await session_store_diagnostics()


# ── Case / Session ─────────────────────────────────────────────────────────────

@router.get("/api/sessions", tags=["trial"])
async def list_sessions():
    """List all saved sessions (id, title, stage, timestamps)."""
    return await session_store.list_all()


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
