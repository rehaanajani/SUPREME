export type Difficulty = 'easy' | 'medium' | 'hard';

export type AgentRole = 'prosecution' | 'defense' | 'judge' | 'witness';

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

export type ObjectionDecision = 'SUSTAINED' | 'OVERRULED';

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

export interface Diagnostics {
  request_id: string;
  timings_ms: {
    total: number;
  };
  model?: {
    id?: string | null;
    provider: string;
  } | null;
  rag?: {
    source?: string | null;
  } | null;
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
  plea?: string | null;
  difficulty: Difficulty;
}

export interface Verdict {
  decision: string;
  reasoning: string;
  key_factors: string[];
  confidence: number;
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
  created_at: string;
  updated_at: string;
}

export interface SessionResponse extends TrialState {
  diagnostics?: Diagnostics | null;
}

export interface CreateCaseRequest {
  title: string;
  description: string;
  charges: string[];
  evidence: string[];
  plea?: string;
  difficulty?: Difficulty;
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
  diagnostics?: Diagnostics | null;
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
  objection?: {
    decision: ObjectionDecision;
    reason: string;
    code?: string | null;
  } | null;
  diagnostics?: Diagnostics | null;
}

export interface VerdictResponse {
  session_id: string;
  verdict: Verdict;
  transcript_length: number;
  diagnostics?: Diagnostics | null;
}
