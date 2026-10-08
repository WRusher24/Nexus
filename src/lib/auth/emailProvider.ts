/**
 * Auth.js email provider construction (M8, Part 2.2).
 *
 * The provider is assembled by hand (rather than importing
 * `next-auth/providers/nodemailer`) so the default transport — which pulls in
 * the `nodemailer` package — is never loaded. That keeps M8 within its
 * approved dependency budget and lets the console transport work with zero
 * email infrastructure.
 *
 * Env vars:
 *   EMAIL_PROVIDER: 'console' | 'resend' | 'postmark' | 'ses'
 *   EMAIL_FROM:     the From address (default: Nexus <no-reply@nexus.local>)
 *   EMAIL_API_KEY:  for resend/postmark/ses (used by the future real senders)
 *
 * Default: `console`, which logs `[AUTH] Magic link for <email>: <url>` to
 * stdout. Production email delivery is a deployment task; swapping the
 * transport means implementing `sendVerificationRequest` for the chosen
 * service below (the rest of the config is unchanged).
 */

import type { EmailConfig } from 'next-auth/providers/email';

const DEFAULT_FROM = 'Nexus <no-reply@nexus.local>';

function consoleSendVerificationRequest(params: {
  identifier: string;
  url: string;
}): void {
  // Intentionally logs the magic link to stdout for local development.
  console.log(`[AUTH] Magic link for ${params.identifier}: ${params.url}`);
}

export function createEmailProvider(): EmailConfig {
  const from = process.env.EMAIL_FROM ?? DEFAULT_FROM;
  const provider = (process.env.EMAIL_PROVIDER ?? 'console').toLowerCase();

  if (provider !== 'console') {
    // No external email service is configured for M8. Fall back to the
    // console transport rather than failing sign-in outright; the deployment
    // task replaces this branch with the real service.
    console.warn(
      `[AUTH] EMAIL_PROVIDER="${provider}" is not configured in M8; using the console transport.`,
    );
  }

  return {
    id: 'email',
    type: 'email',
    name: 'Email',
    from,
    maxAge: 24 * 60 * 60,
    async sendVerificationRequest({ identifier, url }) {
      consoleSendVerificationRequest({ identifier, url });
    },
  };
}
