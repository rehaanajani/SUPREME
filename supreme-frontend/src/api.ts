// src/api.ts — All backend API calls

import type {
  CreateCaseRequest,
  CreateCaseResponse,
  ControlResponse,
  NextTurnResponse,
  TrialState,
  VerdictResponse,
} from './types';

const BASE = '/api'; // proxied by Vite → http://localhost:8000

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail ?? `HTTP ${res.status}`);
  }
  return data as T;
}

// ── Trial management ──────────────────────────────────────────────────────────

export const createCase = (req: CreateCaseRequest) =>
  request<CreateCaseResponse>('POST', '/case', req);

export const getSession = (sessionId: string) =>
  request<TrialState>('GET', `/session/${sessionId}`);

export const nextTurn = (sessionId: string) =>
  request<NextTurnResponse>('POST', `/session/${sessionId}/next`);

export const forceVerdict = (sessionId: string) =>
  request<VerdictResponse>('POST', `/session/${sessionId}/verdict`);

export const fastForward = (sessionId: string) =>
  request<VerdictResponse>('POST', `/session/${sessionId}/fast-forward`);

export const resetTrial = (sessionId: string) =>
  request<CreateCaseResponse>('POST', `/session/${sessionId}/reset`);

// ── User controls ─────────────────────────────────────────────────────────────

export const raiseObjection = (sessionId: string, payload?: string) =>
  request<ControlResponse>('POST', `/session/${sessionId}/control`, {
    action: 'objection',
    payload: payload ?? "Counsel's statement is improper and prejudicial.",
  });

export const redactEntry = (sessionId: string, keyword: string) =>
  request<ControlResponse>('POST', `/session/${sessionId}/control`, {
    action: 'redact',
    payload: keyword,
  });

export const injectTestimony = (sessionId: string, text: string) =>
  request<ControlResponse>('POST', `/session/${sessionId}/control`, {
    action: 'inject_testimony',
    payload: text,
  });
