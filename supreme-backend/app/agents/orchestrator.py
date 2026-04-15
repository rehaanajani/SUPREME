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

_OBJECTION_PREFIX_RE = re.compile(r"^\s*object(?:ion)?\b[\s:,-]*", re.IGNORECASE)
_POLITE_PREFIX_RE = re.compile(
    r"^\s*(your\s+honou?r|your\s+lordship|my\s+lord|my\s+lady)\b[\s,:-]*",
    re.IGNORECASE,
)

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


def _is_procedural_entry(entry: TranscriptEntry) -> bool:
    upper = entry.content.strip().upper()
    return upper.startswith("OBJECTION:") or upper.startswith("RULING:")


def _extract_objection_reason(payload: str | None) -> str:
    if not payload:
        return ""

    text = payload.strip()
    text = _OBJECTION_PREFIX_RE.sub("", text, count=1).strip()
    text = _POLITE_PREFIX_RE.sub("", text, count=1).strip()
    text = re.sub(r"[.?!]+$", "", text).strip()
    if not text:
        return ""

    generic = {
        "objection",
        "object",
        "your honour",
        "your honor",
        "your lordship",
        "my lord",
        "my lady",
    }
    if text.lower() in generic:
        return ""
    return text


def _find_latest_counsel_statement(state: TrialState) -> TranscriptEntry | None:
    for entry in reversed(state.transcript):
        if entry.agent not in (AgentRole.PROSECUTION, AgentRole.DEFENSE):
            continue
        if entry.redacted or _is_procedural_entry(entry):
            continue
        return entry
    return None


def _find_challenged_statement(state: TrialState, challenged_agent: AgentRole) -> TranscriptEntry | None:
    for entry in reversed(state.transcript):
        if entry.agent != challenged_agent:
            continue
        if entry.redacted or _is_procedural_entry(entry):
            continue
        return entry

    for entry in reversed(state.transcript):
        if entry.agent not in (AgentRole.PROSECUTION, AgentRole.DEFENSE):
            continue
        if entry.redacted or _is_procedural_entry(entry):
            continue
        return entry
    return None


def _parse_objection_ruling(raw_ruling: str) -> tuple[str, str, str]:
    text = raw_ruling.strip()

    decision = "OVERRULED"
    decision_match = re.search(
        r"(?:^|\n)\s*DECISION\s*:\s*(SUSTAINED|OVERRULED)\b",
        text,
        flags=re.IGNORECASE,
    )
    if decision_match:
        decision = decision_match.group(1).upper()
    else:
        upper = text.upper()
        if upper.startswith("SUSTAINED"):
            decision = "SUSTAINED"
        elif upper.startswith("OVERRULED"):
            decision = "OVERRULED"

    reason_match = re.search(
        r"(?:^|\n)\s*REASON\s*:\s*(.+?)(?=\n\s*ANALYSIS\s*:|\Z)",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    analysis_match = re.search(
        r"(?:^|\n)\s*ANALYSIS\s*:\s*(.+)$",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )

    reason = ""
    if reason_match:
        reason = " ".join(reason_match.group(1).strip().split())
    else:
        first_line = text.splitlines()[0].strip() if text else ""
        if "." in first_line:
            reason = first_line.split(".", 1)[1].strip()
        elif " " in first_line:
            reason = first_line.split(" ", 1)[1].strip()

    analysis = ""
    if analysis_match:
        analysis = " ".join(analysis_match.group(1).strip().split())
    elif text:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if len(lines) > 1:
            analysis = " ".join(lines[1:])

    if not reason:
        reason = "The objection does not justify striking the challenged statement."
    if not analysis:
        analysis = reason

    return decision, reason, analysis


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
    objection_reason = _extract_objection_reason(payload)
    objection_text = objection_reason or "No legal ground stated."
    challenged_statement = _find_latest_counsel_statement(state)
    challenged_agent = challenged_statement.agent if challenged_statement else (
        state.active_agent if state.active_agent in (AgentRole.PROSECUTION, AgentRole.DEFENSE) else AgentRole.PROSECUTION
    )
    if challenged_statement is None:
        challenged_statement = _find_challenged_statement(state, challenged_agent)
    objecting_agent = (
        AgentRole.DEFENSE if challenged_agent == AgentRole.PROSECUTION else AgentRole.PROSECUTION
    )

    entry = TranscriptEntry(
        agent=objecting_agent,
        stage=state.stage,
        content=f"OBJECTION: {objection_text}",
        timestamp=datetime.utcnow(),
    )
    state.transcript.append(entry)
    state.updated_at = datetime.utcnow()

    if not objection_reason:
        ruling_decision = "OVERRULED"
        reason_text = "No legal ground was stated for the objection."
        analysis_text = (
            "The court requires a specific evidentiary basis before it can strike opposing "
            "counsel's submission. State grounds such as hearsay, relevance, speculation, "
            "or leading question."
        )
    else:
        context_text = challenged_statement.content if challenged_statement else "No prior opposing statement."

        judge_system = (
            "You are the Presiding Judge in a courtroom trial. "
            "Rule on objections using standard rules of evidence.\n\n"
            "Output format (exact keys):\n"
            "DECISION: SUSTAINED or OVERRULED\n"
            "REASON: One concise sentence\n"
            "ANALYSIS: Two to four concise sentences grounded in evidentiary rules.\n"
            "Be decisive and avoid hedging."
        )
        judge_prompt = (
            f"CHALLENGED STATEMENT ({challenged_statement.agent.upper() if challenged_statement else challenged_agent.upper()}):\n"
            f"{context_text}\n\n"
            f"OBJECTION RAISED BY {objecting_agent.upper()}:\n"
            f"{objection_reason}\n\n"
            "Decide whether the challenged statement should remain in the record."
        )

        try:
            raw_ruling, _ = await generate_response_with_trace(
                system_prompt=judge_system,
                user_prompt=judge_prompt,
            )
        except Exception as exc:
            logger.warning("LLM objection ruling failed: %s — defaulting to OVERRULED.", exc)
            raw_ruling = (
                "DECISION: OVERRULED\n"
                "REASON: The court cannot evaluate this objection at this time.\n"
                "ANALYSIS: The objection is not sustained because the analysis service was unavailable."
            )

        ruling_decision, reason_text, analysis_text = _parse_objection_ruling(raw_ruling)

    effect_text = "The challenged statement remains in the record."
    if ruling_decision == "SUSTAINED" and challenged_statement:
        challenged_statement.redacted = True
        effect_text = (
            f"The challenged {challenged_statement.agent.upper()} statement was struck "
            "from the active record."
        )
        logger.info("Objection SUSTAINED — redacted entry %s.", challenged_statement.id)
    elif ruling_decision == "SUSTAINED" and not challenged_statement:
        ruling_decision = "OVERRULED"
        reason_text = "No opposing statement was available to strike."
        analysis_text = (
            "Although a ground was presented, there is no challengeable opposing statement "
            "currently in the transcript."
        )
        effect_text = "No transcript entry was modified."

    ruling = ObjectionRuling(
        ruling=ruling_decision,
        reason=reason_text,
        analysis=analysis_text,
        challenged_entry_id=challenged_statement.id if challenged_statement else None,
        challenged_agent=challenged_statement.agent if challenged_statement else challenged_agent,
        effect=effect_text,
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
