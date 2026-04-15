const DEFAULT_API_BASE_URL =
  typeof window === 'undefined'
    ? 'http://localhost:8000'
    : `${window.location.protocol}//localhost:8000`;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function stripApiSuffix(value: string): string {
  const normalized = stripTrailingSlashes(value);
  return normalized.endsWith('/api') ? normalized.slice(0, -4) : normalized;
}

function normalizeApiBaseUrl(rawBaseUrl: string | undefined): string {
  const candidate = rawBaseUrl?.trim();
  if (!candidate) {
    return DEFAULT_API_BASE_URL;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'localhost';
    }
    parsed.pathname = stripApiSuffix(parsed.pathname);
    return stripTrailingSlashes(parsed.toString());
  } catch {
    return stripApiSuffix(candidate);
  }
}

export const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);

const API_DEBUG_ENABLED = (import.meta.env.VITE_DEBUG_API as string | undefined)?.toLowerCase() === 'true';

export type ApiTimelineEventType = 'request:start' | 'request:success' | 'request:error' | 'request:network_error';

export type ApiTimelineEvent = {
  id: string;
  at: string;
  event: ApiTimelineEventType;
  method: string;
  path: string;
  url: string;
  status?: number;
  latencyMs?: number;
  requestId?: string;
  code?: string;
  hint?: string;
};

const API_TIMELINE_LIMIT = 300;
const apiTimeline: ApiTimelineEvent[] = [];
const timelineListeners = new Set<(events: ApiTimelineEvent[]) => void>();

function emitTimelineUpdate(): void {
  const snapshot = [...apiTimeline];
  timelineListeners.forEach((listener) => listener(snapshot));
}

function pushApiTimelineEvent(event: Omit<ApiTimelineEvent, 'id' | 'at'>): void {
  apiTimeline.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...event,
  });

  if (apiTimeline.length > API_TIMELINE_LIMIT) {
    apiTimeline.splice(0, apiTimeline.length - API_TIMELINE_LIMIT);
  }

  emitTimelineUpdate();
}

export function getApiTimelineSnapshot(): ApiTimelineEvent[] {
  return [...apiTimeline];
}

export function clearApiTimeline(): void {
  apiTimeline.length = 0;
  emitTimelineUpdate();
}

export function subscribeApiTimeline(listener: (events: ApiTimelineEvent[]) => void): () => void {
  timelineListeners.add(listener);
  listener(getApiTimelineSnapshot());
  return () => {
    timelineListeners.delete(listener);
  };
}

function logApiDebug(event: string, payload: Record<string, unknown>): void {
  if (!API_DEBUG_ENABLED) return;
  const label = `[API] ${event}`;
  if (typeof console.groupCollapsed === 'function') {
    console.groupCollapsed(label);
    console.table(payload);
    console.groupEnd();
    return;
  }
  console.debug(label, payload);
}

type ApiErrorBody = {
  detail?: unknown;
  code?: unknown;
  hint?: unknown;
  request_id?: unknown;
  debug?: unknown;
};

function stringifyErrorDetail(detail: unknown): string | null {
  if (typeof detail === 'string' && detail.trim().length > 0) {
    return detail;
  }

  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (typeof record.msg === 'string') {
            return record.msg;
          }
        }
        return null;
      })
      .filter((item): item is string => Boolean(item && item.trim().length > 0));

    if (parts.length > 0) {
      return parts.join('; ');
    }
  }

  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.msg === 'string' && record.msg.trim().length > 0) {
      return record.msg;
    }
  }

  return null;
}

export class ApiError extends Error {
  status: number;
  details: unknown;
  requestId?: string;
  code?: string;
  hint?: string;

  constructor(
    message: string,
    status: number,
    details?: unknown,
    options?: { requestId?: string; code?: string; hint?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.requestId = options?.requestId;
    this.code = options?.code;
    this.hint = options?.hint;
  }
}

function joinUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = joinUrl(path);
  const method = init?.method || 'GET';
  const startedAt = performance.now();
  logApiDebug('request:start', { method, url, path });
  pushApiTimelineEvent({ event: 'request:start', method, path, url });
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
      ...init,
    });
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    logApiDebug('request:network_error', { method, url, latencyMs, error });
    pushApiTimelineEvent({
      event: 'request:network_error',
      method,
      path,
      url,
      latencyMs,
      code: 'NETWORK_ERROR',
    });
    console.error('API network failure', { method, url, error });
    throw new ApiError(
      `Network error while calling ${method} ${url}. Check that the backend is running and reachable.`,
      0,
      error,
      { code: 'NETWORK_ERROR' },
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? ((await response.json()) as ApiErrorBody | T) : await response.text();
  const latencyMs = Math.round(performance.now() - startedAt);
  const requestId = response.headers.get('x-request-id') || undefined;

  if (!response.ok) {
    const bodyObject = isJson && typeof body === 'object' && body ? (body as ApiErrorBody) : undefined;
    const resolvedRequestId =
      requestId ||
      (typeof bodyObject?.request_id === 'string' ? bodyObject.request_id : undefined);
    const code = typeof bodyObject?.code === 'string' ? bodyObject.code : undefined;
    const hint = typeof bodyObject?.hint === 'string' ? bodyObject.hint : undefined;
    const message =
      (bodyObject && stringifyErrorDetail(bodyObject.detail))
      || `Request failed with status ${response.status}`;
    logApiDebug('request:error', {
      method,
      url,
      status: response.status,
      latencyMs,
      requestId: resolvedRequestId,
      code,
      hint,
      body,
    });
    pushApiTimelineEvent({
      event: 'request:error',
      method,
      path,
      url,
      status: response.status,
      latencyMs,
      requestId: resolvedRequestId,
      code,
      hint,
    });
    console.error('API request failed', {
      method,
      url,
      status: response.status,
      requestId: resolvedRequestId,
      code,
      hint,
      body,
    });
    throw new ApiError(message, response.status, body, { requestId: resolvedRequestId, code, hint });
  }

  logApiDebug('request:success', {
    method,
    url,
    status: response.status,
    latencyMs,
    requestId,
    responseType: isJson ? 'json' : 'text',
  });
  pushApiTimelineEvent({
    event: 'request:success',
    method,
    path,
    url,
    status: response.status,
    latencyMs,
    requestId,
  });

  return body as T;
}
