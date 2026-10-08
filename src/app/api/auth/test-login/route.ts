/**
 * POST /api/auth/test-login (M9, test-only).
 *
 * Creates a database session for a test user without the magic-link round trip.
 * Returns 404 unless `NODE_ENV === 'test'` or `E2E_TEST_AUTH === '1'`, so it is
 * inert in production. The Playwright smoke test sets `E2E_TEST_AUTH=1` because
 * Next.js ignores `.env.local` when `NODE_ENV=test` (which would drop
 * DATABASE_URL); the flag avoids that.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/http/db';
import { sessions, users } from '@/lib/db/schema';
import { internalError, notFound } from '@/lib/http/errors';
import { jsonOk } from '@/lib/http/responses';
import { parseJsonBody } from '@/lib/http/validation';

export const runtime = 'nodejs';

const bodySchema = z.object({
  email: z.string().email(),
});

export async function POST(request: Request): Promise<Response> {
  if (
    process.env.NODE_ENV !== 'test' &&
    process.env.E2E_TEST_AUTH !== '1'
  ) {
    return notFound('Not found');
  }

  const body = await parseJsonBody(request, bodySchema);
  if (body instanceof Response) return body;

  try {
    const db = await getDb();

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    const user =
      existing ??
      (
        await db
          .insert(users)
          .values({ email: body.email, name: body.email })
          .returning({ id: users.id })
      )[0];

    if (!user) {
      return internalError(new Error('could not create test user'));
    }

    const sessionToken = randomUUID();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db
      .insert(sessions)
      .values({ sessionToken, userId: user.id, expires });

    const cookie =
      `authjs.session-token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Expires=${expires.toUTCString()}`;

    return jsonOk(
      { userId: user.id, email: body.email },
      { headers: { 'set-cookie': cookie } },
    );
  } catch (error) {
    return internalError(error);
  }
}
