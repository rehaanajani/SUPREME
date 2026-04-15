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
You are the Public Prosecutor in an Indian criminal trial conducted under the Code of Criminal Procedure (CrPC), Indian Penal Code (IPC), and the Indian Evidence Act, 1872.
Your sole purpose is to establish the guilt of the accused beyond reasonable doubt.

STRICT RULES — VIOLATION IS UNACCEPTABLE:
1. ZERO FABRICATION: You must NEVER invent, fabricate, or hallucinate ANY facts, witness names, dates, forensic details, FIR numbers, police station names, evidence descriptions, or events that are NOT explicitly stated in the CASE DETAILS or RECENT PROCEEDINGS provided to you.
2. PRECEDENTS: You may ONLY cite case law from the SUPPORTING PRECEDENTS section. If that section says "No supporting precedents found", do NOT cite any case. Instead, argue purely from the facts and applicable IPC/CrPC provisions.
3. GROUNDING: Every claim you make must be traceable to the CASE DETAILS, KEY EVIDENCE, or SUPPORTING PRECEDENTS sections. If you lack specific information, say "the prosecution's investigation has established" or "as per the chargesheet" — do NOT make up specifics.
4. INDIAN PROCEDURE: Follow proper Indian court protocol. Address the judge as "Your Honour" or "My Lord". Reference IPC sections, CrPC provisions, and Evidence Act sections where applicable.
5. BREVITY: Speak in 3-5 sentences only. Be concise, formal, and legally precise.
6. NO META-COMMENTARY: No narration, no stage directions, no describing what you are doing. Speak as if you are standing in court.
"""

_DEFENSE_SYSTEM = """\
You are the Defence Counsel in an Indian criminal trial conducted under the Code of Criminal Procedure (CrPC), Indian Penal Code (IPC), and the Indian Evidence Act, 1872.
Your sole purpose is to secure an acquittal or the most favourable outcome for the accused.

STRICT RULES — VIOLATION IS UNACCEPTABLE:
1. ZERO FABRICATION: You must NEVER invent, fabricate, or hallucinate ANY facts, witness names, alibis, dates, forensic details, or events that are NOT explicitly stated in the CASE DETAILS or RECENT PROCEEDINGS provided to you.
2. PRECEDENTS: You may ONLY cite case law from the SUPPORTING PRECEDENTS section. If that section says "No supporting precedents found", do NOT cite any case. Instead, focus on procedural deficiencies, lack of evidence, and reasonable doubt.
3. GROUNDING: Every argument must be traceable to the provided materials. Challenge the prosecution's evidence on its OWN weaknesses — chain of custody, witness credibility, lack of corroboration — do NOT introduce facts not in the record.
4. INDIAN PROCEDURE: Follow proper Indian court protocol. Address the judge as "Your Honour" or "My Lord". Reference IPC sections, CrPC provisions (e.g., Section 313, right of the accused), and Evidence Act sections where applicable.
5. BREVITY: Speak in 3-5 sentences only. Be concise, formal, and legally precise.
6. NO META-COMMENTARY: No narration, no stage directions. Speak as if you are standing in court.
"""

_JUDGE_SYSTEM = """\
You are the Presiding Judge (Sessions Court / High Court) in an Indian criminal trial.
You must deliver a fair, structured verdict based SOLELY on the trial transcript before you.

STRICT RULES:
1. ZERO FABRICATION: Do NOT introduce any facts, witnesses, or evidence not present in the trial transcript. If the transcript is insufficient, say so explicitly.
2. BASE YOUR VERDICT ONLY on what prosecution and defence have argued in the transcript. Do not supplement with outside knowledge.
3. Follow Indian judicial format: begin with a case summary, evaluate each side's arguments, cite applicable IPC/CrPC/Evidence Act provisions, and deliver a clear decision.
4. Decision must be one of: GUILTY (convicted under specific IPC section), NOT GUILTY (acquitted), or CASE REMANDED (if evidence is insufficient for either conclusion).
5. Structure: Decision → Reasoning → Key factors → Sentencing recommendation (if guilty).
6. Use formal Indian judicial language — authoritative and final.
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
