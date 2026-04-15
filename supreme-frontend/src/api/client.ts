const DEFAULT_API_BASE_URL =
  typeof window === 'undefined'
    ? 'http://127.0.0.1:8000'
    : `${window.location.protocol}//${window.location.hostname}:8000`;

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ||
  DEFAULT_API_BASE_URL;

const API_DEBUG_ENABLED = (import.meta.env.VITE_DEBUG_API as string | undefined)?.toLowerCase() === 'true';

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

export async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const url = joinUrl(path);
  const method = init?.method || 'GET';
  const startedAt = performance.now();
  logApiDebug('request:start', { method, url, path });
  let response: Response;

  const timeoutMs = init?.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const latencyMs = Math.round(performance.now() - startedAt);

    if (error instanceof DOMException && error.name === 'AbortError') {
      logApiDebug('request:timeout', { method, url, latencyMs, timeoutMs });
      throw new ApiError(
        `Request to ${method} ${url} timed out after ${Math.round(timeoutMs / 1000)}s. Is the backend running?`,
        0,
        error,
        { code: 'REQUEST_TIMEOUT' },
      );
    }

    logApiDebug('request:network_error', { method, url, latencyMs, error });
    console.error('API network failure', { method, url, error });
    throw new ApiError(
      `Network error while calling ${method} ${url}. Check that the backend is running and reachable.`,
      0,
      error,
      { code: 'NETWORK_ERROR' },
    );
  }

  clearTimeout(timeoutId);

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
      (bodyObject && typeof bodyObject.detail === 'string' && bodyObject.detail) ||
      `Request failed with status ${response.status}`;
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

  return body as T;
}

/**
 * Upload a file via multipart/form-data (no JSON Content-Type).
 */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const url = joinUrl(path);
  const form = new FormData();
  form.append('file', file);

  const response = await fetch(url, { method: 'POST', body: form });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new ApiError(
      (errBody as Record<string, string>)?.error || `Upload failed with status ${response.status}`,
      response.status,
      errBody,
    );
  }

  return (await response.json()) as T;
}
