"""
app/agents/runners.py - Per-agent prompt builders and traced LLM runners.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.models.trial import (
    AgentDebugTrace,
    AgentRole,
    CaseDetails,
    TranscriptEntry,
    TrialStage,
)
from app.tools.llm import generate_response_with_trace
from app.tools.rag import retrieve_precedents_with_trace

logger = logging.getLogger(__name__)

_PROSECUTION_SYSTEM = """\
You are the Prosecution attorney in a serious criminal trial.
Your sole purpose is to secure a CONVICTION.

Rules:
- Be direct, aggressive, and legally precise.
- Cite evidence and precedents to build an airtight case.
- Every statement advances the argument for guilt.
- Speak in 3-5 sentences only.
- Use formal courtroom language - no narration, no meta-commentary.
- End every statement with a strong legal assertion.
"""

_DEFENSE_SYSTEM = """\
You are the Defense attorney in a criminal trial.
Your sole purpose is to secure an ACQUITTAL.

Rules:
- Create reasonable doubt at every opportunity.
- Challenge the integrity of evidence and prosecution witnesses.
- Cite precedents that favour the accused.
- Speak in 3-5 sentences only.
- Use formal courtroom language - no narration, no meta-commentary.
- End every statement with a powerful legal challenge.
"""

_JUDGE_SYSTEM = """\
You are the Presiding Judge in a criminal trial.
You must deliver a fair, structured verdict based solely on the trial transcript.

Rules:
- Evaluate the transcript objectively and impartially.
- Identify the strongest arguments on each side.
- Deliver a clear decision: GUILTY, NOT GUILTY, or MISTRIAL.
- Structure your verdict: decision -> reasoning -> key factors.
- Use formal judicial language - authoritative and final.
"""


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
        "your reasoning, and the 2-3 key factors that determined the outcome."
    )


def _format_transcript(entries: list[TranscriptEntry], redacted_view: bool) -> str:
    lines: list[str] = []
    for entry in entries[-10:]:
        if redacted_view and entry.redacted:
            lines.append(f"[{entry.agent.upper()}] [REDACTED]")
        else:
            lines.append(f"[{entry.agent.upper()}] {entry.content}")
    return "\n".join(lines) if lines else "No proceedings yet."


def _format_citations(citations) -> str:
    if not citations:
        return "No supporting precedents found."
    return "\n".join(
        f"- {citation.case_id}: {citation.summary} (relevance: {citation.relevance_score:.2f})"
        for citation in citations
    )


async def run_prosecution(
    case: CaseDetails,
    stage: TrialStage,
    transcript: list[TranscriptEntry],
) -> TranscriptEntry:
    query = f"{case.title} {' '.join(case.charges)} {stage}"
    citations, rag_trace = await retrieve_precedents_with_trace(query, AgentRole.PROSECUTION)
    recent = _format_transcript(transcript, redacted_view=True)
    citation_text = _format_citations(citations)
    user_prompt = _build_prosecution_prompt(case, stage, recent, citation_text)
    content, llm_traces = await generate_response_with_trace(
        system_prompt=_PROSECUTION_SYSTEM,
        user_prompt=user_prompt,
    )
    return TranscriptEntry(
        agent=AgentRole.PROSECUTION,
        stage=stage,
        content=content,
        timestamp=datetime.utcnow(),
        citations=citations,
        debug=AgentDebugTrace(
            runner="prosecution",
            system_prompt=_PROSECUTION_SYSTEM,
            user_prompt=user_prompt,
            tool_calls=[rag_trace, *llm_traces],
            final_output=content,
        ),
    )


async def run_defense(
    case: CaseDetails,
    stage: TrialStage,
    transcript: list[TranscriptEntry],
) -> TranscriptEntry:
    query = f"{case.title} {' '.join(case.charges)} {stage} acquittal"
    citations, rag_trace = await retrieve_precedents_with_trace(query, AgentRole.DEFENSE)
    recent = _format_transcript(transcript, redacted_view=True)
    citation_text = _format_citations(citations)
    user_prompt = _build_defense_prompt(case, stage, recent, citation_text)
    content, llm_traces = await generate_response_with_trace(
        system_prompt=_DEFENSE_SYSTEM,
        user_prompt=user_prompt,
    )
    return TranscriptEntry(
        agent=AgentRole.DEFENSE,
        stage=stage,
        content=content,
        timestamp=datetime.utcnow(),
        citations=citations,
        debug=AgentDebugTrace(
            runner="defense",
            system_prompt=_DEFENSE_SYSTEM,
            user_prompt=user_prompt,
            tool_calls=[rag_trace, *llm_traces],
            final_output=content,
        ),
    )


async def run_judge(
    case: CaseDetails,
    transcript: list[TranscriptEntry],
) -> tuple[str, AgentDebugTrace]:
    full = _format_transcript(transcript, redacted_view=False)
    user_prompt = _build_judge_prompt(case, full)
    content, llm_traces = await generate_response_with_trace(
        system_prompt=_JUDGE_SYSTEM,
        user_prompt=user_prompt,
    )
    return content, AgentDebugTrace(
        runner="judge",
        system_prompt=_JUDGE_SYSTEM,
        user_prompt=user_prompt,
        tool_calls=llm_traces,
        final_output=content,
    )
