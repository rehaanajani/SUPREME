import { request } from './client';
import type {
  ControlRequest,
  ControlResponse,
  CreateCaseRequest,
  CreateCaseResponse,
  NextTurnResponse,
  TrialState,
  VerdictResponse,
} from './types';

type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function pickNestedObject(payload: unknown, keys: string[]): unknown {
  if (!isObject(payload)) return null;
  for (const key of keys) {
    if (key in payload) return payload[key];
  }
  return null;
}

function looksLikeTrialState(value: unknown): value is TrialState {
  if (!isObject(value)) return false;
  return (
    typeof value.session_id === 'string'
    && isObject(value.case)
    && typeof value.stage === 'string'
    && Array.isArray(value.transcript)
  );
}

function normalizeTrialState(payload: unknown): TrialState {
  if (looksLikeTrialState(payload)) return payload;

  const nested = pickNestedObject(payload, ['state', 'session', 'trial_state', 'data']);
  if (looksLikeTrialState(nested)) return nested;

  return payload as unknown as TrialState;
}

function normalizeVerdictResponse(payload: unknown): VerdictResponse {
  if (isObject(payload) && 'session_id' in payload && 'verdict' in payload) {
    return payload as unknown as VerdictResponse;
  }

  const state = normalizeTrialState(payload);
  if (state?.session_id && state?.verdict) {
    return {
      session_id: state.session_id,
      verdict: state.verdict,
      transcript_length: state.transcript.length,
      diagnostics: isObject(payload) && 'diagnostics' in payload ? (payload.diagnostics as VerdictResponse['diagnostics']) : null,
    };
  }

  return payload as unknown as VerdictResponse;
}

export function createCase(payload: CreateCaseRequest): Promise<CreateCaseResponse> {
  return request<CreateCaseResponse>('/api/case', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getSession(sessionId: string): Promise<TrialState> {
  const response = await request<unknown>(`/api/session/${sessionId}`);
  return normalizeTrialState(response);
}

export async function nextTurn(sessionId: string): Promise<NextTurnResponse> {
  const response = await request<unknown>(`/api/session/${sessionId}/next`, {
    method: 'POST',
  });

  if (isObject(response) && 'entry' in response && 'stage' in response) {
    return response as unknown as NextTurnResponse;
  }

  const state = normalizeTrialState(response);
  const entry = state.transcript[state.transcript.length - 1];
  return {
    session_id: state.session_id,
    entry,
    stage: state.stage,
    active_agent: state.active_agent,
    is_complete: state.stage === 'COMPLETE',
  };
}

export function control(sessionId: string, payload: ControlRequest): Promise<ControlResponse> {
  return request<ControlResponse>(`/api/session/${sessionId}/control`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function forceVerdict(sessionId: string): Promise<VerdictResponse> {
  const response = await request<unknown>(`/api/session/${sessionId}/verdict`, {
    method: 'POST',
  });

  return normalizeVerdictResponse(response);
}

export async function fastForward(sessionId: string): Promise<VerdictResponse> {
  const response = await request<unknown>(`/api/session/${sessionId}/fast-forward`, {
    method: 'POST',
  });

  return normalizeVerdictResponse(response);
}

export function resetTrial(sessionId: string): Promise<CreateCaseResponse> {
  return request<CreateCaseResponse>(`/api/session/${sessionId}/reset`, {
    method: 'POST',
  });
}
