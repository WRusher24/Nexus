/**
 * Direct API-route invoker for tests (M8, Part 5.1).
 *
 * Imports a route handler and calls it with a constructed WHATWG `Request` —
 * no HTTP server, no Next.js middleware. Dynamic segments are extracted from
 * the path and passed through the Next.js 15 `{ params: Promise<...> }`
 * contract.
 *
 * Usage:
 *   const res = await callApi('/api/search?q=versailles', {
 *     method: 'GET',
 *     session: { userId: 'test-user-id' },
 *   });
 */

import type { Database } from '../../lib/graph/types';
import { __setDbForTests } from '../../lib/http/db';
import { users } from '../../lib/db/schema';
import { randomUUID } from 'node:crypto';
import { clearTestSession, setTestSession } from './authSession';

export interface RouteContextParams {
  params: Promise<Record<string, string>>;
}

export type RouteHandler = (
  request: Request,
  context: RouteContextParams,
) => Promise<Response>;

export interface LoadedRoute {
  GET?: RouteHandler;
  POST?: RouteHandler;
}

interface RouteDef {
  method: 'GET' | 'POST';
  regex: RegExp;
  load: () => Promise<LoadedRoute>;
}

function route(
  method: 'GET' | 'POST',
  regex: RegExp,
  load: () => Promise<unknown>,
): RouteDef {
  return {
    method,
    regex,
    load: async () => (await load()) as unknown as LoadedRoute,
  };
}

// Dynamic segments accept any non-slash text so the handler (not the test
// client) is responsible for UUID validation / 400 responses.
const SEGMENT = '[^/]+';

const ROUTES: RouteDef[] = [
  route('GET', /^\/api\/search$/, () => import('../../app/api/search/route')),
  route('POST', /^\/api\/root-nodes$/, () =>
    import('../../app/api/root-nodes/route'),
  ),
  route('GET', new RegExp(`^/api/nodes/(?<id>${SEGMENT})$`), () =>
    import('../../app/api/nodes/[id]/route'),
  ),
  route('GET', new RegExp(`^/api/nodes/(?<id>${SEGMENT})/ancestors$`), () =>
    import('../../app/api/nodes/[id]/ancestors/route'),
  ),
  route('GET', new RegExp(`^/api/nodes/(?<id>${SEGMENT})/descendants$`), () =>
    import('../../app/api/nodes/[id]/descendants/route'),
  ),
  route('POST', /^\/api\/expansions$/, () =>
    import('../../app/api/expansions/route'),
  ),
  route('GET', new RegExp(`^/api/expansions/(?<id>${SEGMENT})/stream$`), () =>
    import('../../app/api/expansions/[id]/stream/route'),
  ),
  route('GET', new RegExp(`^/api/expansions/(?<id>${SEGMENT})$`), () =>
    import('../../app/api/expansions/[id]/route'),
  ),
  route('POST', new RegExp(`^/api/edges/(?<id>${SEGMENT})/feedback$`), () =>
    import('../../app/api/edges/[id]/feedback/route'),
  ),
  route('GET', /^\/api\/quota$/, () => import('../../app/api/quota/route')),
];

/** Point API routes at the test Drizzle handle. */
export function setTestDb(db: Database): void {
  __setDbForTests(db);
}

/**
 * Insert a `users` row so a test session id resolves to a real Auth.js user.
 * Returns the user id.
 */
export async function insertTestUser(
  db: Database,
  overrides: { id?: string; email?: string; name?: string } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insert(users).values({
    id,
    email: overrides.email ?? `${id}@test.nexus.local`,
    name: overrides.name ?? 'Test User',
  });
  return id;
}

export interface CallApiOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  /** `null` = unauthenticated; omit to leave the current override alone. */
  session?: { userId: string } | null;
}

export async function callApi(
  path: string,
  options: CallApiOptions,
): Promise<Response> {
  const url = new URL(path, 'http://localhost:3000');

  const def = ROUTES.find(
    (candidate) =>
      candidate.method === options.method && candidate.regex.test(url.pathname),
  );
  if (!def) {
    throw new Error(`callApi: no route for ${options.method} ${url.pathname}`);
  }

  const match = def.regex.exec(url.pathname);
  const params: Record<string, string> = { ...(match?.groups ?? {}) };

  const loader = await def.load();
  const handler = options.method === 'GET' ? loader.GET : loader.POST;
  if (!handler) {
    throw new Error(`callApi: handler missing for ${options.method} ${url.pathname}`);
  }

  const init: RequestInit = { method: options.method };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'content-type': 'application/json' };
  }
  const request = new Request(url.toString(), init);

  if (options.session !== undefined) {
    setTestSession(options.session === null ? null : options.session.userId);
  }

  try {
    return await handler(request, { params: Promise.resolve(params) });
  } finally {
    if (options.session !== undefined) clearTestSession();
  }
}
