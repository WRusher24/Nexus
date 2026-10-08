/**
 * Graceful shutdown signals (M7, Part 10).
 *
 * Registers SIGINT/SIGTERM handlers that abort an AbortController. A second
 * signal forces an immediate exit (130), so a stuck worker can always be
 * stopped without waiting for SIGKILL.
 */

const FORCE_EXIT_CODE = 130;

export function registerShutdownSignals(): AbortSignal {
  const controller = new AbortController();
  let received = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (received) {
      console.warn(`[worker] second signal (${signal}); forcing exit`);
      process.exit(FORCE_EXIT_CODE);
    }
    received = true;
    console.log(`[worker] received ${signal}; finishing in-flight work and shutting down`);
    controller.abort();
  };

  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);

  return controller.signal;
}
