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

export function createCase(payload: CreateCaseRequest): Promise<CreateCaseResponse> {
  return request<CreateCaseResponse>('/api/case', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getSession(sessionId: string): Promise<TrialState> {
  return request<TrialState>(`/api/session/${sessionId}`);
}

export function nextTurn(sessionId: string): Promise<NextTurnResponse> {
  return request<NextTurnResponse>(`/api/session/${sessionId}/next`, {
    method: 'POST',
  });
}

export function control(sessionId: string, payload: ControlRequest): Promise<ControlResponse> {
  return request<ControlResponse>(`/api/session/${sessionId}/control`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function forceVerdict(sessionId: string): Promise<VerdictResponse> {
  return request<VerdictResponse>(`/api/session/${sessionId}/verdict`, {
    method: 'POST',
  });
}

export function fastForward(sessionId: string): Promise<VerdictResponse> {
  return request<VerdictResponse>(`/api/session/${sessionId}/fast-forward`, {
    method: 'POST',
  });
}

export function resetTrial(sessionId: string): Promise<CreateCaseResponse> {
  return request<CreateCaseResponse>(`/api/session/${sessionId}/reset`, {
    method: 'POST',
  });
}

export interface SessionListItem {
  session_id: string;
  title: string;
  stage: string;
  created_at: string | null;
  updated_at: string | null;
}

export function listSessions(): Promise<SessionListItem[]> {
  return request<SessionListItem[]>('/api/sessions');
}
