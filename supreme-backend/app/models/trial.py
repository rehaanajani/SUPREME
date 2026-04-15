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
    WITNESS     = "witness"


class Difficulty(str, Enum):
    EASY   = "easy"
    MEDIUM = "medium"
    HARD   = "hard"


class ControlAction(str, Enum):
    OBJECTION        = "objection"
    REDACT           = "redact"
    INJECT_TESTIMONY = "inject_testimony"


class ObjectionDecision(str, Enum):
    SUSTAINED = "SUSTAINED"
    OVERRULED = "OVERRULED"


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


class DiagnosticsTiming(BaseModel):
    total: int


class DiagnosticsModel(BaseModel):
    id: Optional[str] = None
    provider: str = "openrouter"


class DiagnosticsRag(BaseModel):
    source: Optional[str] = None


class RequestDiagnostics(BaseModel):
    request_id: str
    timings_ms: DiagnosticsTiming
    model: Optional[DiagnosticsModel] = None
    rag: Optional[DiagnosticsRag] = None


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
    plea: Optional[str] = None
    difficulty: Difficulty = Difficulty.MEDIUM


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
    turns_per_stage: int = 1       # set from difficulty

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    version: int = 0

    class Config:
        use_enum_values = True


# ── API Request / Response models ────────────────────────────────────────────

class CreateCaseRequest(BaseModel):
    title: str
    description: str
    charges: list[str]
    evidence: list[str]
    plea: Optional[str] = None
    difficulty: Difficulty = Difficulty.MEDIUM


class CreateCaseResponse(BaseModel):
    session_id: str
    case: CaseDetails
    message: str


class ControlRequest(BaseModel):
    action: ControlAction
    payload: Optional[str] = None    # text for injection / redact target


class ObjectionRuling(BaseModel):
    decision: ObjectionDecision
    reason: str
    code: Optional[str] = None


class ControlResponse(BaseModel):
    session_id: str
    action: ControlAction
    result: str
    state: TrialState
    objection: Optional[ObjectionRuling] = None
    diagnostics: Optional[RequestDiagnostics] = None


class NextTurnResponse(BaseModel):
    session_id: str
    entry: TranscriptEntry
    stage: TrialStage
    active_agent: AgentRole
    is_complete: bool
    diagnostics: Optional[RequestDiagnostics] = None


class SessionResponse(TrialState):
    diagnostics: Optional[RequestDiagnostics] = None


class VerdictResponse(BaseModel):
    session_id: str
    verdict: Verdict
    transcript_length: int
    diagnostics: Optional[RequestDiagnostics] = None
