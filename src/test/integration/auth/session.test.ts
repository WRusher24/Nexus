import { afterEach, describe, expect, it } from 'vitest';
import {
  getOptionalUserId,
  requireUser,
} from '../../../lib/auth/session';
import { clearTestSession, setTestSession } from '../../helpers/authSession';

const request = new Request('http://localhost:3000/api/test');

describe('auth/session', () => {
  afterEach(() => {
    clearTestSession();
  });

  it('requireUser returns a 401 Response when there is no session', async () => {
    setTestSession(null);
    const result = await requireUser(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it('requireUser returns the userId for a valid session', async () => {
    setTestSession('user-123');
    const result = await requireUser(request);
    expect(result).toBe('user-123');
  });

  it('honours the test override and clearing it removes the override', async () => {
    setTestSession('override-user');
    expect(await getOptionalUserId()).toBe('override-user');

    clearTestSession();
    // With no override the real Auth.js path runs outside a request scope and
    // degrades to null rather than throwing.
    expect(await getOptionalUserId()).toBeNull();
  });

  it('getOptionalUserId returns null without a session (no error)', async () => {
    setTestSession(null);
    await expect(getOptionalUserId(request)).resolves.toBeNull();
  });

  it('rejects installing a test override outside the test environment', async () => {
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      expect(() => setTestSession('user-1')).toThrow(/test-only/);
    } finally {
      env.NODE_ENV = original;
    }
  });
});
