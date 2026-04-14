"""
app/agents/runners.py — Per-agent prompt builders and LLM runners.

Each runner:
  1. Builds a role-appropriate system prompt.
  2. Retrieves relevant RAG precedents.
  3. Calls the LLM via app/tools/llm.py.
  4. Returns a TranscriptEntry.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.models.trial import (
    AgentRole,
    CaseDetails,
    TranscriptEntry,
    TrialStage,
)
from app.tools.llm import generate_response
from app.tools.rag import retrieve_precedents

logger = logging.getLogger(__name__)

# ── System Prompts ────────────────────────────────────────────────────────────

_PROSECUTION_SYSTEM = """\
You are the Prosecution attorney in a serious criminal trial.
Your sole purpose is to secure a CONVICTION.

Rules:
- Be direct, aggressive, and legally precise.
- Cite evidence and precedents to build an airtight case.
- Every statement advances the argument for guilt.
- Speak in 3–5 sentences only.
- Use formal courtroom language — no narration, no meta-commentary.
- End every statement with a strong legal assertion.
"""

_DEFENSE_SYSTEM = """\
You are the Defense attorney in a criminal trial.
Your sole purpose is to secure an ACQUITTAL.

Rules:
- Create reasonable doubt at every opportunity.
- Challenge the integrity of evidence and prosecution witnesses.
- Cite precedents that favour the accused.
- Speak in 3–5 sentences only.
- Use formal courtroom language — no narration, no meta-commentary.
- End every statement with a powerful legal challenge.
"""

_JUDGE_SYSTEM = """\
You are the Presiding Judge in a criminal trial.
You must deliver a fair, structured verdict based solely on the trial transcript.

Rules:
- Evaluate the transcript objectively and impartially.
- Identify the strongest arguments on each side.
- Deliver a clear decision: GUILTY, NOT GUILTY, or MISTRIAL.
- Structure your verdict: decision → reasoning → key factors.
- Use formal judicial language — authoritative and final.
"""

# ── Prompt builders ───────────────────────────────────────────────────────────

def _build_prosecution_prompt(
    case: CaseDetails,
    stage: TrialStage,
    recent_transcript: str,
    citations: str,
) -> str:
    return (
        f"CASE: {case.title}\n"
        f"CHARGES: {', '.join(case.charges)}\n"
        f"KEY EVIDENCE: {', '.join(case.evidence)}\n"
        f"CURRENT STAGE: {stage}\n\n"
        f"RECENT PROCEEDINGS:\n{recent_transcript}\n\n"
        f"SUPPORTING PRECEDENTS:\n{citations}\n\n"
        "Deliver your argument for this stage. Push hard for conviction."
    )


def _build_defense_prompt(
    case: CaseDetails,
    stage: TrialStage,
    recent_transcript: str,
    citations: str,
) -> str:
    return (
        f"CASE: {case.title}\n"
        f"CHARGES AGAINST CLIENT: {', '.join(case.charges)}\n"
        f"PROSECUTION EVIDENCE (to counter): {', '.join(case.evidence)}\n"
        f"CURRENT STAGE: {stage}\n\n"
        f"RECENT PROCEEDINGS:\n{recent_transcript}\n\n"
        f"SUPPORTING PRECEDENTS:\n{citations}\n\n"
        "Deliver your argument for this stage. Create maximum reasonable doubt."
    )


def _build_judge_prompt(case: CaseDetails, full_transcript: str) -> str:
    return (
        f"CASE: {case.title}\n"
        f"CHARGES: {', '.join(case.charges)}\n\n"
        f"FULL TRIAL TRANSCRIPT:\n{full_transcript}\n\n"
        "Deliver the final verdict. Be decisive and structured: "
        "state your decision (GUILTY / NOT GUILTY / MISTRIAL), "
        "your reasoning, and the 2–3 key factors that determined the outcome."
    )


# ── Transcript formatter (agents see redacted version) ───────────────────────

def _format_transcript(entries: list[TranscriptEntry], redacted_view: bool) -> str:
    lines: list[str] = []
    for e in entries[-10:]:   # only last 10 to keep context short
        if redacted_view and e.redacted:
            lines.append(f"[{e.agent.upper()}] [REDACTED]")
        else:
            lines.append(f"[{e.agent.upper()}] {e.content}")
    return "\n".join(lines) if lines else "No proceedings yet."


def _format_citations(citations) -> str:
    if not citations:
        return "No supporting precedents found."
    parts = []
    for c in citations:
        parts.append(f"• {c.case_id}: {c.summary} (relevance: {c.relevance_score:.2f})")
    return "\n".join(parts)


# ── Public runners ────────────────────────────────────────────────────────────

async def run_prosecution(
    case: CaseDetails,
    stage: TrialStage,
    transcript: list[TranscriptEntry],
) -> TranscriptEntry:
    """Run the prosecution agent and return a TranscriptEntry."""
    query = f"{case.title} {' '.join(case.charges)} {stage}"
    citations = await retrieve_precedents(query, AgentRole.PROSECUTION)

    recent = _format_transcript(transcript, redacted_view=True)
    citation_text = _format_citations(citations)

    content = await generate_response(
        system_prompt=_PROSECUTION_SYSTEM,
        user_prompt=_build_prosecution_prompt(case, stage, recent, citation_text),
    )

    return TranscriptEntry(
        agent=AgentRole.PROSECUTION,
        stage=stage,
        content=content,
        timestamp=datetime.utcnow(),
        citations=citations,
    )


async def run_defense(
    case: CaseDetails,
    stage: TrialStage,
    transcript: list[TranscriptEntry],
) -> TranscriptEntry:
    """Run the defense agent and return a TranscriptEntry."""
    query = f"{case.title} {' '.join(case.charges)} {stage} acquittal"
    citations = await retrieve_precedents(query, AgentRole.DEFENSE)

    recent = _format_transcript(transcript, redacted_view=True)
    citation_text = _format_citations(citations)

    content = await generate_response(
        system_prompt=_DEFENSE_SYSTEM,
        user_prompt=_build_defense_prompt(case, stage, recent, citation_text),
    )

    return TranscriptEntry(
        agent=AgentRole.DEFENSE,
        stage=stage,
        content=content,
        timestamp=datetime.utcnow(),
        citations=citations,
    )


async def run_judge(
    case: CaseDetails,
    transcript: list[TranscriptEntry],
) -> str:
    """Run the judge agent over the full transcript and return raw text."""
    full = _format_transcript(transcript, redacted_view=False)
    return await generate_response(
        system_prompt=_JUDGE_SYSTEM,
        user_prompt=_build_judge_prompt(case, full),
    )
