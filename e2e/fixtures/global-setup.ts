/**
 * Playwright global setup (M9).
 *
 * The smoke test exercises a real expansion, which needs the queue worker
 * running. The worker is a long-lived process that Playwright's `webServer`
 * cannot own (it opens no port), so it is spawned here and torn down at the end
 * of the run.
 *
 * Set `E2E_SKIP_WORKER=1` to skip (e.g. when the worker already runs in another
 * terminal, or when only the search/create half of the journey is being tested).
 */

import { spawn, type ChildProcess } from 'node:child_process';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_SKIP_WORKER === '1') {
    console.log('[e2e] E2E_SKIP_WORKER=1 — not starting the queue worker');
    return async () => {};
  }

  console.log('[e2e] starting the queue worker (pnpm run worker)');
  const worker: ChildProcess = spawn('pnpm', ['run', 'worker'], {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  // Give the worker a moment to boot before the first test navigates.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  return async () => {
    console.log('[e2e] stopping the queue worker');
    // The worker is launched through a shell, so `kill()` would only signal the
    // shell. Kill the whole tree on Windows; a plain kill is fine elsewhere.
    if (process.platform === 'win32' && worker.pid !== undefined) {
      spawn('taskkill', ['/pid', String(worker.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: true,
      });
    } else {
      worker.kill();
    }
  };
}
