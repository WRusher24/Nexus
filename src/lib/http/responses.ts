/**
 * Typed JSON response helpers (M8, Part 3.1).
 *
 * All API routes return plain WHATWG `Response` objects so the handlers can be
 * invoked directly from tests without a running Next.js server.
 */

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function json(body: unknown, status: number, init?: ResponseInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { ...init, status, headers });
}

/** 200 OK with a JSON body. */
export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return json(data, init?.status ?? 200, init);
}

/** 201 Created. */
export function jsonCreated<T>(data: T, init?: ResponseInit): Response {
  return json(data, 201, init);
}

/** 202 Accepted. */
export function jsonAccepted<T>(data: T, init?: ResponseInit): Response {
  return json(data, 202, init);
}

/** 204 No Content (no body). */
export function jsonNoContent(): Response {
  return new Response(null, { status: 204 });
}
