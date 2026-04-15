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
    ObjectionDecision,
    ObjectionRuling,
    TranscriptEntry,
    TrialStage,
    TrialState,
    Verdict,
)
from config import DEMO_MODE, TURNS_PER_STAGE

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

def _turns_for_state(state: TrialState) -> int:
    """Return number of turns per stage, capped to 1 in DEMO_MODE."""
    if DEMO_MODE:
        return 1
    return state.turns_per_stage


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
    Insert an OBJECTION entry into the transcript.
    The objection is attributed to whichever agent is NOT currently speaking.
    """
    objecting_agent = (
        AgentRole.DEFENSE
        if state.active_agent == AgentRole.PROSECUTION
        else AgentRole.PROSECUTION
    )
    objection_text = payload or "Objection, your honour, counsel's statement is improper."

    keyword_codes = {
        "hearsay": "HEARSAY",
        "leading": "LEADING",
        "speculation": "SPECULATION",
        "relevance": "RELEVANCE",
        "irrelevant": "RELEVANCE",
        "argumentative": "ARGUMENTATIVE",
        "compound": "COMPOUND",
    }
    lowered = objection_text.lower()
    hit_code = next((code for token, code in keyword_codes.items() if token in lowered), None)
    struck_count = 0
    if hit_code:
        ruling = ObjectionRuling(
            decision=ObjectionDecision.SUSTAINED,
            reason=(
                "Specific evidentiary grounds were provided and the objection is sustained "
                "pending counsel reframing. Matching statements have been struck from the record."
            ),
            code=hit_code,
        )

        if state.transcript:
            for transcript_entry in reversed(state.transcript):
                if transcript_entry.agent in (AgentRole.PROSECUTION, AgentRole.DEFENSE) and not transcript_entry.redacted:
                    transcript_entry.redacted = True
                    struck_count = 1
                    break
    else:
        ruling = ObjectionRuling(
            decision=ObjectionDecision.OVERRULED,
            reason=(
                "Grounds were not tied to a concrete evidentiary defect; the objection is overruled "
                "and proceedings continue."
            ),
            code="INSUFFICIENT_GROUNDS",
        )

    entry = TranscriptEntry(
        agent=objecting_agent,
        stage=state.stage,
        content=f"OBJECTION: {objection_text}",
        timestamp=datetime.utcnow(),
    )
    state.transcript.append(entry)
    ruling_entry = TranscriptEntry(
        agent=AgentRole.JUDGE,
        stage=state.stage,
        content=(
            f"RULING ON OBJECTION: {ruling.decision}. "
            f"{ruling.reason}"
            f"{' (1 statement struck.)' if struck_count else ''}"
        ),
        timestamp=datetime.utcnow(),
    )
    state.transcript.append(ruling_entry)
    state.updated_at = datetime.utcnow()
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
    Attributed to a neutral witness role.
    """
    if not payload:
        logger.warning("Inject testimony called with empty payload — no-op.")
        return state

    entry = TranscriptEntry(
        agent=AgentRole.WITNESS,
        stage=state.stage,
        content=f"[WITNESS TESTIMONY — INJECTED]: {payload}",
        timestamp=datetime.utcnow(),
    )
    state.transcript.append(entry)
    state.updated_at = datetime.utcnow()
    return state
