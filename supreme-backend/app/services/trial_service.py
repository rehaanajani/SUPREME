"""
app/services/trial_service.py — Business logic layer.

Acts as the glue between API routes and the orchestrator/session store.
All route handlers call into this service; they never touch Redis or the
orchestrator directly.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.agents.orchestrator import (
    fast_forward,
    handle_inject,
    handle_objection,
    handle_redact,
    run_next_turn,
    run_verdict,
)
from app.models.session_store import session_store
from app.models.trial import (
    CaseDetails,
    ControlAction,
    ControlRequest,
    ControlResponse,
    CreateCaseRequest,
    CreateCaseResponse,
    NextTurnResponse,
    TranscriptEntry,
    TrialState,
    TrialStage,
    VerdictResponse,
)
from fastapi import HTTPException

logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _load_or_404(session_id: str) -> TrialState:
    state = await session_store.load(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")
    return state


async def _save(state: TrialState) -> None:
    state.updated_at = datetime.utcnow()
    await session_store.save(state)


# ── Service functions ─────────────────────────────────────────────────────────

async def create_case(req: CreateCaseRequest) -> CreateCaseResponse:
    """Initialise a new trial session and persist it."""
    case = CaseDetails(
        case_id=f"CASE-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
        title=req.title,
        description=req.description,
        charges=req.charges,
        evidence=req.evidence,
    )

    state = TrialState(case=case)
    await session_store.save(state)

    logger.info("Created trial session %s — %s", state.session_id, case.title)
    return CreateCaseResponse(
        session_id=state.session_id,
        case=case,
        message=f"Trial '{case.title}' ready. Session: {state.session_id}",
    )


async def get_session(session_id: str) -> TrialState:
    return await _load_or_404(session_id)


async def next_turn(session_id: str) -> NextTurnResponse:
    """Run one agent turn and persist the result."""
    state = await _load_or_404(session_id)

    if state.stage == TrialStage.COMPLETE:
        raise HTTPException(status_code=400, detail="Trial is already complete.")

    state, entry = await run_next_turn(state)
    await _save(state)

    if entry is None:
        raise HTTPException(status_code=400, detail="No turn was produced.")

    return NextTurnResponse(
        session_id=session_id,
        entry=entry,
        stage=state.stage,
        active_agent=state.active_agent,
        is_complete=state.stage == TrialStage.COMPLETE,
    )


async def control(session_id: str, req: ControlRequest) -> ControlResponse:
    """Apply a user control action (objection / redact / inject)."""
    state = await _load_or_404(session_id)
    objection_ruling = None

    if req.action == ControlAction.OBJECTION:
        state, objection_ruling = await handle_objection(state, req.payload)
        ruling_label = objection_ruling.ruling if objection_ruling else "NOTED"
        result = f"Objection {ruling_label}. {objection_ruling.reason if objection_ruling else ''}"

    elif req.action == ControlAction.REDACT:
        if not req.payload:
            raise HTTPException(status_code=400, detail="Redact requires a 'payload' string to match.")
        state = await handle_redact(state, req.payload)
        result = f"Entries matching '{req.payload}' have been redacted."

    elif req.action == ControlAction.INJECT_TESTIMONY:
        if not req.payload:
            raise HTTPException(status_code=400, detail="Inject testimony requires a 'payload' string.")
        state = await handle_inject(state, req.payload)
        result = "Witness testimony injected into the transcript."

    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {req.action}")

    await _save(state)
    return ControlResponse(
        session_id=session_id,
        action=req.action,
        result=result,
        state=state.model_dump(),
        objection_ruling=objection_ruling,
    )


async def force_verdict(session_id: str) -> VerdictResponse:
    """Force the judge to deliver the verdict immediately."""
    state = await _load_or_404(session_id)

    if state.stage == TrialStage.COMPLETE and state.verdict:
        logger.info("Verdict already exists for session %s.", session_id)
        return VerdictResponse(
            session_id=session_id,
            verdict=state.verdict,
            transcript_length=len(state.transcript),
        )

    state, _ = await run_verdict(state)
    await _save(state)

    return VerdictResponse(
        session_id=session_id,
        verdict=state.verdict,
        transcript_length=len(state.transcript),
    )


async def reset_trial(session_id: str) -> CreateCaseResponse:
    """Reset the trial to initial state, preserving the case details."""
    state = await _load_or_404(session_id)
    case = state.case

    new_state = TrialState(
        session_id=session_id,   # reuse the same session ID
        case=case,
    )
    await session_store.save(new_state)

    return CreateCaseResponse(
        session_id=session_id,
        case=case,
        message=f"Trial '{case.title}' has been reset.",
    )


async def fast_forward_trial(session_id: str) -> VerdictResponse:
    """Skip remaining stages and jump straight to the verdict."""
    state = await _load_or_404(session_id)
    state, _ = await fast_forward(state)
    await _save(state)

    return VerdictResponse(
        session_id=session_id,
        verdict=state.verdict,
        transcript_length=len(state.transcript),
    )
