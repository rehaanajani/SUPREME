"""
app/services/trial_service.py — Business logic layer.

Acts as the glue between API routes and the orchestrator/session store.
All route handlers call into this service; they never touch Redis or the
orchestrator directly.
"""

from __future__ import annotations

import logging
from datetime import datetime
from time import perf_counter

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
    ObjectionRuling,
    CreateCaseRequest,
    CreateCaseResponse,
    Difficulty,
    NextTurnResponse,
    TrialState,
    TrialStage,
    VerdictResponse,
)
from app.observability.diagnostics import build_request_diagnostics
from app.serializers.trial_state import serialize_public_entry, serialize_public_state
from config import TURNS_PER_STAGE
from fastapi import HTTPException

logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _load_or_404(session_id: str) -> TrialState:
    state = await session_store.load(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")
    return state


async def _save_with_conflict(state: TrialState, expected_version: int) -> None:
    state.updated_at = datetime.utcnow()
    saved = await session_store.save_if_version(state, expected_version)
    if not saved:
        raise HTTPException(
            status_code=409,
            detail=(
                "Session state changed concurrently. Reload session and retry the action."
            ),
        )


# ── Service functions ─────────────────────────────────────────────────────────

async def create_case(req: CreateCaseRequest) -> CreateCaseResponse:
    """Initialise a new trial session and persist it."""
    difficulty = req.difficulty or Difficulty.MEDIUM
    turns = TURNS_PER_STAGE.get(difficulty.value if hasattr(difficulty, "value") else difficulty, 2)

    case = CaseDetails(
        case_id=f"CASE-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
        title=req.title,
        description=req.description,
        charges=req.charges,
        evidence=req.evidence,
        plea=req.plea,
        difficulty=difficulty,
    )

    state = TrialState(case=case, turns_per_stage=turns)
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
    started_at = perf_counter() * 1000
    state = await _load_or_404(session_id)
    base_version = state.version

    if state.stage == TrialStage.COMPLETE:
        raise HTTPException(status_code=400, detail="Trial is already complete.")

    state, entry = await run_next_turn(state)
    await _save_with_conflict(state, base_version)

    if entry is None:
        raise HTTPException(status_code=400, detail="No turn was produced.")

    model_id = None
    rag_source = None
    if entry.debug:
        llm_call = next((trace for trace in entry.debug.tool_calls if trace.name == "openrouter.chat.completions"), None)
        rag_call = next((trace for trace in entry.debug.tool_calls if trace.name == "retrieve_precedents"), None)
        if llm_call and isinstance(llm_call.input, dict):
            model_id = llm_call.input.get("model")
        if rag_call and isinstance(rag_call.output, dict):
            rag_source = rag_call.output.get("source")

    return NextTurnResponse(
        session_id=session_id,
        entry=serialize_public_entry(entry),
        stage=state.stage,
        active_agent=state.active_agent,
        is_complete=state.stage == TrialStage.COMPLETE,
        diagnostics=build_request_diagnostics(started_at, model_id=model_id, rag_source=rag_source),
    )


async def control(session_id: str, req: ControlRequest) -> ControlResponse:
    """Apply a user control action (objection / redact / inject)."""
    started_at = perf_counter() * 1000
    state = await _load_or_404(session_id)
    base_version = state.version
    objection: ObjectionRuling | None = None

    if req.action == ControlAction.OBJECTION:
        state, objection = await handle_objection(state, req.payload)
        result = "Objection evaluated by the bench."

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

    await _save_with_conflict(state, base_version)
    return ControlResponse(
        session_id=session_id,
        action=req.action,
        result=result,
        state=serialize_public_state(state),
        objection=objection,
        diagnostics=build_request_diagnostics(started_at),
    )


async def force_verdict(session_id: str) -> VerdictResponse:
    """Force the judge to deliver the verdict immediately."""
    started_at = perf_counter() * 1000
    state = await _load_or_404(session_id)
    base_version = state.version

    if state.stage == TrialStage.COMPLETE and state.verdict:
        logger.info("Verdict already exists for session %s.", session_id)
        return VerdictResponse(
            session_id=session_id,
            verdict=state.verdict,
            transcript_length=len(state.transcript),
            diagnostics=build_request_diagnostics(started_at),
        )

    state, verdict_entry = await run_verdict(state)
    await _save_with_conflict(state, base_version)

    model_id = None
    if verdict_entry.debug:
        llm_call = next((trace for trace in verdict_entry.debug.tool_calls if trace.name == "openrouter.chat.completions"), None)
        if llm_call and isinstance(llm_call.input, dict):
            model_id = llm_call.input.get("model")

    return VerdictResponse(
        session_id=session_id,
        verdict=state.verdict,
        transcript_length=len(state.transcript),
        diagnostics=build_request_diagnostics(started_at, model_id=model_id),
    )


async def reset_trial(session_id: str) -> CreateCaseResponse:
    """Reset the trial to initial state, preserving the case details."""
    state = await _load_or_404(session_id)
    base_version = state.version
    case = state.case

    new_state = TrialState(
        session_id=session_id,   # reuse the same session ID
        case=case,
        turns_per_stage=state.turns_per_stage,
    )
    await _save_with_conflict(new_state, base_version)

    return CreateCaseResponse(
        session_id=session_id,
        case=case,
        message=f"Trial '{case.title}' has been reset.",
    )


async def fast_forward_trial(session_id: str) -> VerdictResponse:
    """Skip remaining stages and jump straight to the verdict."""
    started_at = perf_counter() * 1000
    state = await _load_or_404(session_id)
    base_version = state.version
    state, verdict_entry = await fast_forward(state)
    await _save_with_conflict(state, base_version)

    model_id = None
    if verdict_entry.debug:
        llm_call = next((trace for trace in verdict_entry.debug.tool_calls if trace.name == "openrouter.chat.completions"), None)
        if llm_call and isinstance(llm_call.input, dict):
            model_id = llm_call.input.get("model")

    return VerdictResponse(
        session_id=session_id,
        verdict=state.verdict,
        transcript_length=len(state.transcript),
        diagnostics=build_request_diagnostics(started_at, model_id=model_id),
    )
