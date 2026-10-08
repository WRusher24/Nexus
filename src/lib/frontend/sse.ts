'use client';

/**
 * SSE client for expansion status (M9, Part 1.4).
 *
 * Wraps `EventSource` over `GET /api/expansions/{id}/stream`. The server emits
 * `status` events on change, then either `close` (terminal) or `timeout` (the
 * 120s function budget was reached). `EventSource` auto-reconnects on network
 * errors, which we take over so that reconnection is bounded (`maxReconnects`)
 * and every attempt is accounted for.
 *
 * Cookies are sent automatically by `EventSource` (same-origin), so the
 * authenticated stream works without custom headers.
 */

export interface SseSubscription {
  close(): void;
}

export interface ExpansionSseCallbacks {
  onStatus: (data: { status: string; attempt: number }) => void;
  onComplete: (data: { finalState: string; extractionRunId: string }) => void;
  onError: (error: string) => void;
}

export interface SubscribeOptions {
  /** Maximum automatic reconnections after a timeout/connection drop. */
  maxReconnects?: number;
}

interface SseStatusPayload {
  status?: string;
  attempt?: number;
  extractionRunId?: string | null;
  finalState?: string | null;
  lastError?: string | null;
}

function isTerminal(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

/**
 * Subscribe to expansion status updates via SSE.
 *
 * Calls `onStatus` for every status event, `onComplete` when a terminal status
 * arrives, and `onError` on an unrecoverable failure. The returned handle must
 * be closed by the caller (e.g. on unmount) to stop reconnection.
 */
export function subscribeToExpansion(
  requestId: string,
  callbacks: ExpansionSseCallbacks,
  options?: SubscribeOptions,
): SseSubscription {
  const maxReconnects = options?.maxReconnects ?? 5;
  let reconnects = 0;
  let closed = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (source !== null) {
      source.close();
      source = null;
    }
  };

  const fail = (message: string): void => {
    if (closed) return;
    closed = true;
    cleanup();
    callbacks.onError(message);
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    cleanup();
  };

  const reconnect = (reason: string): void => {
    if (closed) return;
    cleanup();
    if (reconnects >= maxReconnects) {
      fail(`Expansion stream stopped after ${maxReconnects} reconnects (${reason})`);
      return;
    }
    reconnects += 1;
    const delay = 1000 * reconnects;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  };

  const open = (): void => {
    if (closed) return;
    const src = new EventSource(`/api/expansions/${requestId}/stream`);
    source = src;

    src.addEventListener('status', (event) => {
      if (source !== src) return;
      const message = event as MessageEvent<string>;
      let payload: SseStatusPayload;
      try {
        payload = JSON.parse(message.data) as SseStatusPayload;
      } catch {
        return;
      }
      const status = payload.status ?? 'UNKNOWN';
      callbacks.onStatus({ status, attempt: payload.attempt ?? 0 });
      if (isTerminal(status)) {
        callbacks.onComplete({
          finalState: payload.finalState ?? status,
          extractionRunId: payload.extractionRunId ?? '',
        });
        finish();
      }
    });

    src.addEventListener('close', () => {
      if (source !== src) return;
      finish();
    });

    src.addEventListener('timeout', () => {
      if (source !== src) return;
      reconnect('timeout');
    });

    src.onerror = () => {
      // EventSource would auto-reconnect; take over so reconnects are bounded.
      if (closed || source !== src) return;
      reconnect('connection error');
    };
  };

  open();

  return { close: finish };
}
