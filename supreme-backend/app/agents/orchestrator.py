"""
app/agents/orchestrator.py — Custom orchestrator (no LangGraph).

Responsible for:
  - run_next_turn()       advance one agent turn
  - _advance_stage()      move to next TrialStage
  - handle_objection()    insert objection into transcript
  - handle_redact()       mark an entry as redacted
  - handle_inject()       insert user testimony
  - run_verdict()         force judge to deliver verdict
  - fast_forward()        skip straight to verdict
"""

from __future__ import annotations

import logging
import re
from datetime import datetime

from app.agents.runners import run_defense, run_judge, run_prosecution
from app.models.trial import (
    AgentRole,
    ObjectionRuling,
    TranscriptEntry,
    TrialStage,
    TrialState,
    Verdict,
)
from app.tools.llm import generate_response_with_trace

logger = logging.getLogger(__name__)

# Ordered stages for the full trial flow
STAGE_ORDER: list[TrialStage] = [
    TrialStage.OPENING_PROS,
    TrialStage.OPENING_DEF,
    TrialStage.EXAMINATION,
    TrialStage.CROSS_EXAM,
    TrialStage.CLOSING_PROS,
    TrialStage.CLOSING_DEF,
    TrialStage.VERDICT,
    TrialStage.COMPLETE,
]

# Which agent speaks at each stage
STAGE_AGENT: dict[TrialStage, AgentRole] = {
    TrialStage.OPENING_PROS: AgentRole.PROSECUTION,
    TrialStage.OPENING_DEF:  AgentRole.DEFENSE,
    TrialStage.EXAMINATION:  AgentRole.PROSECUTION,
    TrialStage.CROSS_EXAM:   AgentRole.DEFENSE,
    TrialStage.CLOSING_PROS: AgentRole.PROSECUTION,
    TrialStage.CLOSING_DEF:  AgentRole.DEFENSE,
    TrialStage.VERDICT:      AgentRole.JUDGE,
    TrialStage.COMPLETE:     AgentRole.JUDGE,
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _turns_for_state(_state: TrialState) -> int:
    """Return number of turns per stage."""
    return 1


def _next_stage(current: TrialStage) -> TrialStage:
    idx = STAGE_ORDER.index(current)
    if idx + 1 < len(STAGE_ORDER):
        return STAGE_ORDER[idx + 1]
    return TrialStage.COMPLETE


def _parse_verdict(raw: str) -> Verdict:
    """
    Best-effort parse of the judge's raw text into a structured Verdict.
    Falls back gracefully if the model output is non-standard.
    """
    decision = "NOT GUILTY"
    if re.search(r"\bGUILTY\b", raw, re.IGNORECASE) and \
       not re.search(r"\bNOT GUILTY\b", raw, re.IGNORECASE):
        decision = "GUILTY"
    elif re.search(r"\bMISTRIAL\b", raw, re.IGNORECASE):
        decision = "MISTRIAL"
    elif re.search(r"\bNOT GUILTY\b", raw, re.IGNORECASE):
        decision = "NOT GUILTY"

    # Heuristic confidence: longer, more decisive text → higher confidence
    confidence = min(0.95, 0.5 + len(raw) / 2000)

    # Extract bullet-point-like key factors if any
    factors = re.findall(r"[-•*]\s+(.+)", raw)
    if not factors:
        factors = [s.strip() for s in raw.split(". ")[:3] if s.strip()]

    return Verdict(
        decision=decision,
        reasoning=raw.strip(),
        key_factors=factors[:5],
        confidence=round(confidence, 2),
    )


# ── Core Orchestrator ─────────────────────────────────────────────────────────

async def run_next_turn(state: TrialState) -> tuple[TrialState, TranscriptEntry | None]:
    """
    Advance the trial by one agent turn.
    Returns updated state and the new TranscriptEntry (or None if complete).
    """
    if state.stage in (TrialStage.VERDICT, TrialStage.COMPLETE):
        return state, None

    agent = STAGE_AGENT.get(state.stage, AgentRole.PROSECUTION)
    turns_needed = _turns_for_state(state)

    # Run the appropriate agent
    if agent == AgentRole.PROSECUTION:
        entry = await run_prosecution(state.case, state.stage, state.transcript)
    elif agent == AgentRole.DEFENSE:
        entry = await run_defense(state.case, state.stage, state.transcript)
    else:
        # Unexpected judge call here — defer to run_verdict
        return await run_verdict(state)

    state.transcript.append(entry)
    state.stage_turn += 1
    state.updated_at = datetime.utcnow()

    # Advance stage when all turns for this stage are exhausted
    if state.stage_turn >= turns_needed:
        state.stage = _next_stage(state.stage)
        state.stage_turn = 0
        state.active_agent = STAGE_AGENT.get(state.stage, AgentRole.PROSECUTION)

        # Auto-trigger verdict when we reach VERDICT stage
        if state.stage == TrialStage.VERDICT:
            state, verdict_entry = await run_verdict(state)
            return state, verdict_entry or entry

    return state, entry


async def run_verdict(state: TrialState) -> tuple[TrialState, TranscriptEntry]:
    """Force the judge to deliver a verdict over the current transcript."""
    raw, debug = await run_judge(state.case, state.transcript)
    verdict = _parse_verdict(raw)
    state.verdict = verdict
    state.stage = TrialStage.COMPLETE
    state.active_agent = AgentRole.JUDGE
    state.updated_at = datetime.utcnow()

    entry = TranscriptEntry(
        agent=AgentRole.JUDGE,
        stage=TrialStage.VERDICT,
        content=raw,
        timestamp=datetime.utcnow(),
        debug=debug,
    )
    state.transcript.append(entry)
    return state, entry


async def fast_forward(state: TrialState) -> tuple[TrialState, TranscriptEntry]:
    """Skip all remaining stages and deliver the verdict immediately."""
    logger.info("Fast-forwarding trial %s to verdict.", state.session_id)
    return await run_verdict(state)


# ── User control actions ──────────────────────────────────────────────────────

async def handle_objection(state: TrialState, payload: str | None) -> tuple[TrialState, ObjectionRuling]:
    """
    Insert an OBJECTION entry into the transcript, then ask an LLM judge
    to adjudicate the objection.  Returns the updated state **and** the ruling.

    If SUSTAINED, the last non-objection entry is marked as redacted.
    """
    objecting_agent = (
        AgentRole.DEFENSE
        if state.active_agent == AgentRole.PROSECUTION
        else AgentRole.PROSECUTION
    )
    objection_text = payload or "Objection, Your Honour — counsel's statement is improper."
    entry = TranscriptEntry(
        agent=objecting_agent,
        stage=state.stage,
        content=f"OBJECTION: {objection_text}",
        timestamp=datetime.utcnow(),
    )
    state.transcript.append(entry)
    state.updated_at = datetime.utcnow()

    # ── Find the last non-objection statement to evaluate against ─────
    last_statement = None
    for te in reversed(state.transcript):
        if not te.content.startswith("OBJECTION:") and not te.redacted:
            last_statement = te
            break

    context_text = last_statement.content if last_statement else "No prior statement."

    # ── Ask LLM judge to rule on the objection ───────────────────────
    judge_system = (
        "You are the Presiding Judge in a courtroom trial. "
        "An attorney has raised an objection.  You must decide whether it is "
        "SUSTAINED (the objection is valid — the challenged statement is struck) or "
        "OVERRULED (the objection is invalid — the statement stands).\n\n"
        "Rules:\n"
        "- Evaluate the objection grounds against standard rules of evidence.\n"
        "- Respond with exactly one line starting with SUSTAINED or OVERRULED, "
        "followed by a brief reason (1-2 sentences).\n"
        "- Be authoritative and decisive.\n"
    )
    judge_prompt = (
        f"CHALLENGED STATEMENT ({last_statement.agent.upper() if last_statement else 'unknown'}):\n"
        f"{context_text}\n\n"
        f"OBJECTION RAISED BY {objecting_agent.upper()}:\n"
        f"{objection_text}\n\n"
        "Deliver your ruling. Start with SUSTAINED or OVERRULED."
    )

    try:
        raw_ruling, _ = await generate_response_with_trace(
            system_prompt=judge_system,
            user_prompt=judge_prompt,
        )
    except Exception as exc:
        logger.warning("LLM objection ruling failed: %s — defaulting to OVERRULED.", exc)
        raw_ruling = "OVERRULED. The court cannot evaluate this objection at this time."

    # ── Parse ruling ─────────────────────────────────────────────────
    raw_upper = raw_ruling.strip().upper()
    if raw_upper.startswith("SUSTAINED"):
        ruling_decision = "SUSTAINED"
    else:
        ruling_decision = "OVERRULED"

    # Extract reason: everything after the first word
    reason_text = raw_ruling.strip()
    first_dot = reason_text.find(".")
    if first_dot != -1 and first_dot < len(reason_text) - 1:
        reason_text = reason_text[first_dot + 1:].strip()
    elif " " in reason_text:
        reason_text = reason_text.split(" ", 1)[1].strip()

    # If sustained, redact the challenged statement
    if ruling_decision == "SUSTAINED" and last_statement:
        last_statement.redacted = True
        logger.info("Objection SUSTAINED — redacted entry %s.", last_statement.id)

    ruling = ObjectionRuling(
        ruling=ruling_decision,
        reason=reason_text or "The court has ruled.",
        timestamp=datetime.utcnow(),
    )

    # Add the ruling to transcript as well
    ruling_entry = TranscriptEntry(
        agent=AgentRole.JUDGE,
        stage=state.stage,
        content=f"RULING: {ruling_decision}. {ruling.reason}",
        timestamp=datetime.utcnow(),
    )
    state.transcript.append(ruling_entry)
    state.updated_at = datetime.utcnow()

    logger.info("Objection ruling: %s — %s", ruling_decision, ruling.reason)
    return state, ruling


async def handle_redact(state: TrialState, payload: str | None) -> TrialState:
    """
    Mark matching transcript entries as redacted.
    payload: substring to match against entry content (case-insensitive).
    """
    if not payload:
        logger.warning("Redact called with empty payload — no-op.")
        return state

    count = 0
    for entry in state.transcript:
        if payload.lower() in entry.content.lower():
            entry.redacted = True
            count += 1

    logger.info("Redacted %d entries matching '%s'.", count, payload)
    state.updated_at = datetime.utcnow()
    return state


async def handle_inject(state: TrialState, payload: str | None) -> TrialState:
    """
    Inject user-supplied testimony directly into the transcript.
    Attributed to a neutral WITNESS role (stored as prosecution for schema compat).
    """
    if not payload:
        logger.warning("Inject testimony called with empty payload — no-op.")
        return state

    entry = TranscriptEntry(
        agent=AgentRole.PROSECUTION,   # closest neutral role in schema
        stage=state.stage,
        content=f"[WITNESS TESTIMONY — INJECTED]: {payload}",
        timestamp=datetime.utcnow(),
    )
    state.transcript.append(entry)
    state.updated_at = datetime.utcnow()
    return state
