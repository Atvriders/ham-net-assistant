import type { ApiError } from '@hna/shared';

export class ApiErrorException extends Error {
  constructor(public status: number, public payload: ApiError['error']) {
    super(payload.message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isFormData =
    typeof FormData !== 'undefined' && init.body instanceof FormData;
  const baseHeaders: Record<string, string> = isFormData
    ? {}
    : { 'Content-Type': 'application/json' };
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...baseHeaders, ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    if (!res.ok) {
      throw new ApiErrorException(res.status, { code: 'INTERNAL', message: res.statusText });
    }
    return (await res.blob()) as T;
  }
  const body = await res.json();
  if (!res.ok) {
    throw new ApiErrorException(res.status, body.error);
  }
  return body as T;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
