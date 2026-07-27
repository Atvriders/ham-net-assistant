import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorCode } from '@hna/shared';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Errors thrown by Express-ecosystem middleware (body-parser above all) carry
 * their own HTTP status instead of extending HttpError. Read it so malformed
 * JSON stays a 400 and an oversize body stays a 413 — both used to fall
 * through to the generic branch and be reported as "Internal error", which
 * hid client bugs and, worse, ran `console.error(err)` on a body-parser error
 * whose `.body` property is the raw request payload (passwords included).
 */
function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = (err as { status?: unknown; statusCode?: unknown });
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  return null;
}

/**
 * Status → contract error code. The client only branches on these codes, so an
 * unmapped status has to land on something it already understands.
 */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION',
  415: 'VALIDATION',
};

/**
 * Canned message per status. Deliberately NOT `err.message`: body-parser's
 * JSON errors quote the offending fragment of the request body, so echoing
 * them leaks whatever the client sent (a mistyped password field, say) into
 * the response and into any log that captures it.
 */
function messageForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Malformed request';
    case 401:
      return 'Login required';
    case 403:
      return 'Not allowed';
    case 404:
      return 'Not found';
    case 409:
      return 'Conflict';
    case 413:
      return 'Request body too large';
    case 415:
      return 'Unsupported content type';
    default:
      return 'Request failed';
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Streaming responses (CSV export, PDF summary) have already flushed a 200
  // and part of the file by the time a mid-stream failure lands here. Writing
  // a JSON envelope on top of that throws ERR_HTTP_HEADERS_SENT and leaves the
  // user holding a truncated download that looks complete. Hand back to
  // Express's default handler, which closes the connection so the browser
  // reports a failed transfer.
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION', message: 'Invalid request', details: err.flatten() },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  const status = statusOf(err);
  if (status !== null && status < 500) {
    // Method + path only. Never the body, never the error object.
    console.warn(`[api] ${status} ${req.method} ${req.path}`);
    res.status(status).json({
      error: { code: CODE_BY_STATUS[status] ?? 'VALIDATION', message: messageForStatus(status) },
    });
    return;
  }
  console.error(err);
  res.status(status ?? 500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
};
