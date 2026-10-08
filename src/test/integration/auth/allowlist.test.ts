import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAllowlist,
  isEmailAllowed,
} from '../../../lib/auth/allowlist';

// `process.env.NODE_ENV` is declared read-only by the Next.js ambient types, so
// tests mutate a mutable view of the environment.
const env = process.env as Record<string, string | undefined>;

const ORIGINAL_NODE_ENV = env.NODE_ENV;
const ORIGINAL_ALLOWED = env.ALLOWED_EMAILS;

function restoreEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ALLOWED === undefined) delete env.ALLOWED_EMAILS;
  else env.ALLOWED_EMAILS = ORIGINAL_ALLOWED;
}

describe('auth/allowlist', () => {
  beforeEach(() => {
    delete env.ALLOWED_EMAILS;
  });

  afterEach(restoreEnv);

  it('allows an email that is present in the allowlist', () => {
    env.ALLOWED_EMAILS = 'alice@example.com,bob@example.com';
    env.NODE_ENV = 'production';
    expect(isEmailAllowed('alice@example.com')).toBe(true);
  });

  it('rejects an email that is not in the allowlist', () => {
    env.ALLOWED_EMAILS = 'alice@example.com';
    env.NODE_ENV = 'production';
    expect(isEmailAllowed('mallory@example.com')).toBe(false);
  });

  it('compares case-insensitively and trims whitespace', () => {
    env.ALLOWED_EMAILS = '  Alice@Example.COM , bob@example.com ';
    env.NODE_ENV = 'production';
    expect(isEmailAllowed('alice@example.com')).toBe(true);
    expect(isEmailAllowed('  BOB@EXAMPLE.com  ')).toBe(true);
    expect(isEmailAllowed('ALICE@EXAMPLE.COM')).toBe(true);
  });

  it('fails closed when the allowlist is empty in production', () => {
    delete env.ALLOWED_EMAILS;
    env.NODE_ENV = 'production';
    expect(isEmailAllowed('anyone@example.com')).toBe(false);
  });

  it('allows any email in dev/test when the allowlist is empty', () => {
    delete env.ALLOWED_EMAILS;
    env.NODE_ENV = 'development';
    expect(isEmailAllowed('anyone@example.com')).toBe(true);
  });

  it('parses the allowlist into a normalised array', () => {
    env.ALLOWED_EMAILS = ' a@x.com ,, B@Y.COM, ';
    expect(getAllowlist()).toEqual(['a@x.com', 'b@y.com']);
  });

  it('rejects an empty email regardless of configuration', () => {
    env.ALLOWED_EMAILS = 'alice@example.com';
    env.NODE_ENV = 'development';
    expect(isEmailAllowed('   ')).toBe(false);
  });
});
