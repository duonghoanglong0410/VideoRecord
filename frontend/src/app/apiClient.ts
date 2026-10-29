import type { ApiErrorPayload } from './types';

export const SESSION_EXPIRED_EVENT = 'packingproof:session-expired';

export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly errorCode: string;
  public readonly details: string[];

  constructor(status: number, errorCode: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}

let cachedCsrfToken: string | null = null;

export function setCsrfToken(token: string | null | undefined): void {
  if (token) {
    cachedCsrfToken = token;
  }
}

export function clearCsrfToken(): void {
  cachedCsrfToken = null;
}

export async function fetchCsrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      'CSRF_FETCH_FAILED',
      'Không thể khởi tạo phiên bảo mật CSRF.'
    );
  }

  const data = (await response.json()) as { token?: string };
  cachedCsrfToken = data.token ?? '';
  return cachedCsrfToken;
}

export async function ensureCsrfToken(): Promise<string> {
  if (cachedCsrfToken) {
    return cachedCsrfToken;
  }
  return fetchCsrfToken();
}

function isMutatingMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE';
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  suppressSessionExpiredEvent?: boolean;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  return executeRequest<T>(path, method, options.body, options.suppressSessionExpiredEvent ?? false, true);
}

async function executeRequest<T>(
  path: string,
  method: string,
  body: unknown,
  suppressSessionExpiredEvent: boolean,
  allowCsrfRetry: boolean
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json'
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (isMutatingMethod(method)) {
    const token = await ensureCsrfToken();
    headers['X-CSRF-Token'] = token;
  }

  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (payload && typeof payload === 'object' && 'csrfToken' in payload) {
    const maybeToken = (payload as { csrfToken?: string | null }).csrfToken;
    if (maybeToken) {
      setCsrfToken(maybeToken);
    }
  }

  if (!response.ok) {
    const errPayload = (payload ?? {}) as ApiErrorPayload;
    const errorCode = errPayload.errorCode ?? `HTTP_${response.status}`;

    if (
      response.status === 403 &&
      errorCode === 'CSRF_TOKEN_INVALID' &&
      isMutatingMethod(method) &&
      allowCsrfRetry
    ) {
      await fetchCsrfToken();
      return executeRequest<T>(path, method, body, suppressSessionExpiredEvent, false);
    }

    if (response.status === 401 && !suppressSessionExpiredEvent) {
      // Dispatch session-expired event so upload queues pause safely WITHOUT deleting IndexedDB bytes
      window.dispatchEvent(
        new CustomEvent(SESSION_EXPIRED_EVENT, {
          detail: { path, timestamp: Date.now() }
        })
      );
    }

    throw new ApiRequestError(
      response.status,
      errorCode,
      errPayload.message ?? 'Yêu cầu không thành công. Vui lòng thử lại.',
      errPayload.details ?? []
    );
  }

  return payload as T;
}

