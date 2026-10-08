/**
 * Server-Sent Events helpers (M8, Part 4.7).
 *
 * `createSseStream` pumps a polling loop into a WHATWG `ReadableStream`,
 * emitting:
 *   - `status` events only when the serialized payload changes,
 *   - a `: keepalive` comment every `keepAliveMs` to defeat proxy timeouts,
 *   - `timeout` and close at `timeoutMs` (the client then reconnects),
 *   - `close` + stream close on a terminal value,
 *   - nothing further when the client aborts.
 *
 * Timing is overridable so the SSE tests run in milliseconds instead of
 * minutes. The production defaults (2s poll / 15s keepalive / 120s timeout)
 * are documented in docs/STATUS.md.
 */

export interface SseTiming {
  pollIntervalMs: number;
  keepAliveMs: number;
  timeoutMs: number;
}

export const DEFAULT_SSE_TIMING: SseTiming = {
  pollIntervalMs: 2_000,
  keepAliveMs: 15_000,
  timeoutMs: 120_000,
};

let currentTiming: SseTiming = { ...DEFAULT_SSE_TIMING };

export function getSseTiming(): SseTiming {
  return currentTiming;
}

/** Test-only: override the polling/keepalive/timeout intervals. */
export function __setSseTimingForTests(partial: Partial<SseTiming>): void {
  currentTiming = { ...DEFAULT_SSE_TIMING, ...partial };
}

/** Test-only: restore the production timings. */
export function __resetSseTiming(): void {
  currentTiming = { ...DEFAULT_SSE_TIMING };
}

/** Format one SSE frame. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export interface SseStreamOptions<T> {
  /** Aborts when the client disconnects. */
  signal: AbortSignal;
  /** The snapshot used for the very first `status` event. */
  initial: T;
  /** Read the latest snapshot; returns null when the resource vanished. */
  poll: () => Promise<T | null>;
  /** Map a snapshot to the `status` event payload. */
  serialize: (value: T) => unknown;
  /** Whether a snapshot ends the stream. */
  isTerminal: (value: T) => boolean;
  /** Timing overrides (tests). */
  timing?: Partial<SseTiming>;
}

export function createSseStream<T>(
  options: SseStreamOptions<T>,
): ReadableStream<Uint8Array> {
  const timing: SseTiming = { ...currentTiming, ...options.timing };
  const encoder = new TextEncoder();

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let polling = false;
  let lastPayload = '';

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const clearTimers = (): void => {
        if (pollTimer) clearInterval(pollTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      };

      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The consumer detached; stop quietly.
          closed = true;
          clearTimers();
        }
      };

      const emitStatus = (value: T): void => {
        const payload = JSON.stringify(options.serialize(value));
        if (payload === lastPayload) return;
        lastPayload = payload;
        send(`event: status\ndata: ${payload}\n\n`);
      };

      const finish = (eventName: string, data: unknown): void => {
        if (closed) return;
        send(formatSseEvent(eventName, data));
        closed = true;
        clearTimers();
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      };

      emitStatus(options.initial);
      if (options.isTerminal(options.initial)) {
        finish('close', {});
        return;
      }

      options.signal.addEventListener('abort', () => {
        closed = true;
        clearTimers();
      });

      pollTimer = setInterval(() => {
        if (closed || polling) return;
        polling = true;
        void options
          .poll()
          .then((value) => {
            if (closed || !value) return;
            if (options.isTerminal(value)) {
              emitStatus(value);
              finish('close', {});
              return;
            }
            emitStatus(value);
          })
          .catch((error: unknown) => {
            console.error('[sse] poll failed:', error);
          })
          .finally(() => {
            polling = false;
          });
      }, timing.pollIntervalMs);

      keepAliveTimer = setInterval(() => {
        send(': keepalive\n\n');
      }, timing.keepAliveMs);

      timeoutTimer = setTimeout(() => {
        finish('timeout', {});
      }, timing.timeoutMs);
    },

    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    },
  });
}
