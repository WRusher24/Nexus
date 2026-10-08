'use client';

/**
 * Client session context wrapper (M9). Auth.js needs its `SessionProvider`
 * above any component that calls `useSession`; the root layout is a server
 * component, so this tiny client boundary provides it.
 */

import type { ReactNode } from 'react';
import { SessionProvider as NextAuthSessionProvider } from 'next-auth/react';

export default function SessionProvider({ children }: { children: ReactNode }) {
  return <NextAuthSessionProvider>{children}</NextAuthSessionProvider>;
}
