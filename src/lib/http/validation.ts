/**
 * Request parsing + validation (M8, Part 3.3).
 *
 * Each helper returns either the parsed value or a 400 `Response`; callers use
 * the `instanceof Response` guard.
 */

import { z } from 'zod';
import { badRequest } from './errors';

/** Canonical UUID (v1-5) textual form. */
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** A Zod schema for a UUID string. */
export const uuidSchema = z.string().regex(UUID_RE, 'Invalid UUID');


/** Parse and validate a JSON request body. */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return badRequest('Request validation failed', parsed.error.issues);
  }
  return parsed.data;
}

/** Parse and validate URL search params against a Zod schema. */
export function parseSearchParams<T>(
  url: URL,
  schema: z.ZodType<T>,
): T | Response {
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return badRequest('Invalid query parameters', parsed.error.issues);
  }
  return parsed.data;
}
