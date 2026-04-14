// src/types.ts — mirrors backend Pydantic models

export type AgentRole = 'prosecution' | 'defense' | 'judge';

export type TrialStage =
  | 'OPENING_PROS'
  | 'OPENING_DEF'
  | 'EXAMINATION'
  | 'CROSS_EXAM'
  | 'CLOSING_PROS'
  | 'CLOSING_DEF'
  | 'VERDICT'
  | 'COMPLETE';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Citation {
  case_id: string;
  summary: string;
  relevance_score: number;
}

export interface TranscriptEntry {
  id: string;
  agent: AgentRole;
  stage: TrialStage;
  content: string;
  timestamp: string;
  citations: Citation[];
  redacted: boolean;
}

export interface Verdict {
  decision: 'GUILTY' | 'NOT GUILTY' | 'MISTRIAL';
  reasoning: string;
  key_factors: string[];
  confidence: number;
}

export interface CaseDetails {
  case_id: string;
  title: string;
  description: string;
  charges: string[];
  evidence: string[];
  difficulty: Difficulty;
}

export interface TrialState {
  session_id: string;
  case: CaseDetails;
  stage: TrialStage;
  active_agent: AgentRole;
  transcript: TranscriptEntry[];
  verdict: Verdict | null;
  stage_turn: number;
  turns_per_stage: number;
}

// ── API Request / Response ──────────────────────────────────────────────────

export interface CreateCaseRequest {
  title: string;
  description: string;
  charges: string[];
  evidence: string[];
  difficulty: Difficulty;
}

export interface CreateCaseResponse {
  session_id: string;
  case: CaseDetails;
  message: string;
}

export interface NextTurnResponse {
  session_id: string;
  entry: TranscriptEntry;
  stage: TrialStage;
  active_agent: AgentRole;
  is_complete: boolean;
}

export interface VerdictResponse {
  session_id: string;
  verdict: Verdict;
  transcript_length: number;
}

export interface ControlResponse {
  session_id: string;
  action: string;
  result: string;
  state: TrialState;
}
