'use client';

/**
 * Sign-in button (M9). Invite-only magic-link auth: the user enters an email,
 * `signIn('email')` triggers the Auth.js email flow, and the console transport
 * logs the magic link in development. When already signed in it shows the email
 * and a sign-out control.
 */

import { useState } from 'react';
import { signIn, signOut, useSession } from 'next-auth/react';

export default function SignInButton() {
  const { data: session, status } = useSession();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (status === 'loading') {
    return <p className="text-sm text-gray-500">Checking session…</p>;
  }

  if (session?.user) {
    return (
      <div className="flex items-center gap-3" data-testid="signed-in">
        <span className="text-sm text-gray-700">
          {session.user.email ?? 'Signed in'}
        </span>
        <button
          type="button"
          data-testid="sign-out-button"
          className="rounded border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm hover:bg-gray-50"
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (email.trim().length === 0) return;
        setBusy(true);
        setMessage(null);
        void signIn('email', { email: email.trim(), redirect: false })
          .then(() => {
            setMessage('Check the server console for your magic link.');
          })
          .catch(() => {
            setMessage('Sign-in failed. Are you on the invite list?');
          })
          .finally(() => setBusy(false));
      }}
    >
      <label className="text-sm text-gray-600" htmlFor="nexus-email">
        Email address
      </label>
      <input
        id="nexus-email"
        data-testid="email-input"
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        placeholder="you@example.com"
      />
      <button
        type="submit"
        data-testid="sign-in-button"
        disabled={busy}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Sign in with email'}
      </button>
      {message ? <p className="text-xs text-gray-600">{message}</p> : null}
    </form>
  );
}
