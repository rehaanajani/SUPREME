"""
app/models/trial.py — Pydantic models for SUPREME Courtroom Simulator.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel, Field
import uuid


# ── Enumerations ──────────────────────────────────────────────────────────────

class TrialStage(str, Enum):
    OPENING_PROS = "OPENING_PROS"
    OPENING_DEF  = "OPENING_DEF"
    EXAMINATION  = "EXAMINATION"
    CROSS_EXAM   = "CROSS_EXAM"
    CLOSING_PROS = "CLOSING_PROS"
    CLOSING_DEF  = "CLOSING_DEF"
    VERDICT      = "VERDICT"
    COMPLETE     = "COMPLETE"


class AgentRole(str, Enum):
    PROSECUTION = "prosecution"
    DEFENSE     = "defense"
    JUDGE       = "judge"


class ControlAction(str, Enum):
    OBJECTION        = "objection"
    REDACT           = "redact"
    INJECT_TESTIMONY = "inject_testimony"


# ── Sub-models ────────────────────────────────────────────────────────────────

class Citation(BaseModel):
    case_id: str
    summary: str
    relevance_score: float


class ToolCallTrace(BaseModel):
    name: str
    status: str
    input: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None


class AgentDebugTrace(BaseModel):
    runner: str
    system_prompt: str
    user_prompt: str
    tool_calls: list[ToolCallTrace] = Field(default_factory=list)
    final_output: str = ""


class TranscriptEntry(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent: AgentRole
    stage: TrialStage
    content: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    citations: list[Citation] = Field(default_factory=list)
    redacted: bool = False
    debug: Optional[AgentDebugTrace] = None


class CaseDetails(BaseModel):
    case_id: str
    title: str
    description: str
    charges: list[str]
    evidence: list[str]


class ObjectionRuling(BaseModel):
    ruling: str                      # "SUSTAINED" | "OVERRULED"
    reason: str                      # LLM-generated reasoning
    analysis: Optional[str] = None   # fuller legal analysis by LLM
    challenged_entry_id: Optional[str] = None
    challenged_agent: Optional[AgentRole] = None
    effect: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class Verdict(BaseModel):
    decision: str                    # "GUILTY" | "NOT GUILTY" | "MISTRIAL"
    reasoning: str
    key_factors: list[str]
    confidence: float                # 0.0 – 1.0


# ── Core TrialState (persisted in Redis) ─────────────────────────────────────

class TrialState(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    case: CaseDetails

    stage: TrialStage = TrialStage.OPENING_PROS
    active_agent: AgentRole = AgentRole.PROSECUTION

    transcript: list[TranscriptEntry] = Field(default_factory=list)
    verdict: Optional[Verdict] = None

    # Turn tracking within the current stage
    stage_turn: int = 0            # how many turns taken in this stage

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        use_enum_values = True


# ── API Request / Response models ────────────────────────────────────────────

class CreateCaseRequest(BaseModel):
    title: str
    description: str
    charges: list[str]
    evidence: list[str]


class CreateCaseResponse(BaseModel):
    session_id: str
    case: CaseDetails
    message: str


class ControlRequest(BaseModel):
    action: ControlAction
    payload: Optional[str] = None    # text for injection / redact target


class ControlResponse(BaseModel):
    session_id: str
    action: ControlAction
    result: str
    state: Any                       # serialised TrialState snapshot
    objection_ruling: Optional[ObjectionRuling] = None


class NextTurnResponse(BaseModel):
    session_id: str
    entry: TranscriptEntry
    stage: str
    active_agent: str
    is_complete: bool


class VerdictResponse(BaseModel):
    session_id: str
    verdict: Verdict
    transcript_length: int
