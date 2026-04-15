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

export type ControlAction = 'objection' | 'redact' | 'inject_testimony';

export interface Citation {
  case_id: string;
  summary: string;
  relevance_score: number;
}

export interface ToolCallTrace {
  name: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string | null;
}

export interface AgentDebugTrace {
  runner: string;
  system_prompt: string;
  user_prompt: string;
  tool_calls: ToolCallTrace[];
  final_output: string;
}

export interface TranscriptEntry {
  id: string;
  agent: AgentRole;
  stage: TrialStage;
  content: string;
  timestamp: string;
  citations: Citation[];
  redacted: boolean;
  debug?: AgentDebugTrace | null;
}

export interface CaseDetails {
  case_id: string;
  title: string;
  description: string;
  charges: string[];
  evidence: string[];
}

export interface Verdict {
  decision: string;
  reasoning: string;
  key_factors: string[];
  confidence: number;
}

export interface ObjectionRuling {
  ruling: 'SUSTAINED' | 'OVERRULED';
  reason: string;
  timestamp: string;
}

export interface TrialState {
  session_id: string;
  case: CaseDetails;
  stage: TrialStage;
  active_agent: AgentRole;
  transcript: TranscriptEntry[];
  verdict: Verdict | null;
  stage_turn: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCaseRequest {
  title: string;
  description: string;
  charges: string[];
  evidence: string[];
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

export interface ControlRequest {
  action: ControlAction;
  payload?: string;
}

export interface ControlResponse {
  session_id: string;
  action: ControlAction;
  result: string;
  state: TrialState;
  objection_ruling?: ObjectionRuling | null;
}

export interface VerdictResponse {
  session_id: string;
  verdict: Verdict;
  transcript_length: number;
}
