/**
 * Auth.js (NextAuth v5) configuration for Nexus (M8, Part 2.2).
 *
 * - Email provider (magic link) with invite-only allowlisting via `signIn`.
 * - Drizzle adapter storing users/sessions/accounts/verificationTokens in our
 *   own PostgreSQL database. Database (not JWT) sessions so a sign-out or an
 *   admin revoke can simply delete the session row.
 *
 * Runtime: this module must run on the Node.js runtime (the Drizzle adapter
 * uses `pg`). The route handler exporting `handlers` sets `runtime = 'nodejs'`.
 */

import { DrizzleAdapter } from '@auth/drizzle-adapter';
import NextAuth from 'next-auth';
import { db as rawDb } from '../db/client';
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from '../db/schema';
import type { Database } from '../graph/types';
import { isEmailAllowed } from './allowlist';
import { createEmailProvider } from './emailProvider';

// `db` is a union of the Neon-HTTP and node-postgres Drizzle clients; the
// adapter is typed against the node-postgres flavour. Same cast as the graph
// layer / worker use.
const db = rawDb as unknown as Database;

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  trustHost: true,
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'database' },
  providers: [createEmailProvider()],
  callbacks: {
    signIn({ user }) {
      const email = user.email;
      if (!email) return false;
      return isEmailAllowed(email);
    },
    session({ session, user }) {
      if (session.user) {
        (session.user as { id?: string }).id = user.id;
      }
      return session;
    },
  },
});
