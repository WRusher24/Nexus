/**
 * Typed HTTP errors (M8, Part 3.2).
 *
 * Internal errors are logged server-side and never leak details to clients.
 */

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
  detail?: unknown;
}

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Build a JSON error Response. */
export function jsonError(
  code: ApiErrorCode,
  message: string,
  detail?: unknown,
): Response {
  const body: ApiErrorBody = { error: code, message };
  if (detail !== undefined) body.detail = detail;
  return new Response(JSON.stringify(body), {
    status: STATUS_BY_CODE[code],
    headers: { 'content-type': 'application/json' },
  });
}

export function badRequest(message: string, detail?: unknown): Response {
  return jsonError('BAD_REQUEST', message, detail);
}

export function unauthorized(message = 'Authentication required'): Response {
  return jsonError('UNAUTHORIZED', message);
}

export function forbidden(message = 'Forbidden'): Response {
  return jsonError('FORBIDDEN', message);
}

export function notFound(message = 'Not found'): Response {
  return jsonError('NOT_FOUND', message);
}

export function conflict(message: string, detail?: unknown): Response {
  return jsonError('CONFLICT', message, detail);
}

export function tooManyRequests(
  message = 'Too many requests',
  retryAfterSeconds?: number,
): Response {
  const response = jsonError('TOO_MANY_REQUESTS', message);
  if (retryAfterSeconds !== undefined) {
    response.headers.set('retry-after', String(retryAfterSeconds));
  }
  return response;
}

export function serviceUnavailable(
  message = 'Service temporarily unavailable',
): Response {
  return jsonError('SERVICE_UNAVAILABLE', message);
}

/** 500: logs server-side; the client only sees a generic message. */
export function internalError(error: unknown): Response {
  console.error('[api] internal error:', error);
  return jsonError('INTERNAL_ERROR', 'Internal server error');
}
