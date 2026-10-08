import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expansionRequests } from '../../../lib/db/schema';
import {
  __resetSseTiming,
  __setSseTimingForTests,
} from '../../../lib/sse/stream';
import {
  callApi,
  insertTestUser,
  setTestDb,
} from '../../helpers/apiClient';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import {
  insertExpansionRequest,
  seedFocalScenario,
} from '../../helpers/workerHarness';

interface SseFrame {
  event: string | null;
  data: unknown;
  raw: string;
}

function parseFrame(raw: string): SseFrame {
  let event: string | null = null;
  let data: unknown = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      const text = line.slice('data:'.length).trim();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
  }
  return { event, data, raw };
}

/** Minimal SSE consumer: buffers frames and resolves `next()` when one arrives. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private frames: SseFrame[] = [];
  private done = false;
  private wakeups: Array<() => void> = [];

  constructor(response: Response) {
    if (!response.body) throw new Error('SSE response has no body');
    this.reader = response.body.getReader();
    void this.pump();
  }

  private notify(): void {
    const wakeups = this.wakeups;
    this.wakeups = [];
    for (const wakeup of wakeups) wakeup();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) {
          this.done = true;
          this.notify();
          return;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        this.parse();
      }
    } catch {
      this.done = true;
      this.notify();
    }
  }

  private parse(): void {
    let index = this.buffer.indexOf('\n\n');
    while (index !== -1) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.frames.push(parseFrame(raw));
      index = this.buffer.indexOf('\n\n');
    }
    if (this.frames.length > 0) this.notify();
  }

  async next(timeoutMs = 3000): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.frames.shift();
      if (frame) {
        if (process.env.SSE_DEBUG) {
          console.log(
            `[sse] event=${frame.event ?? 'comment'} data=${JSON.stringify(frame.data)}`,
          );
        }
        return frame;
      }
      if (this.done) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('SseReader.next timed out');
      await new Promise<void>((resolve) => {
        this.wakeups.push(resolve);
        setTimeout(resolve, remaining);
      });
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // Already closed.
    }
  }
}

describe('GET /api/expansions/{id}/stream', () => {
  let testDb: TestDb;
  const readers: SseReader[] = [];

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    setTestDb(testDb.db);
  });

  afterEach(async () => {
    __resetSseTiming();
    await Promise.all(readers.splice(0).map((r) => r.close()));
  });

  async function openStream(
    requestId: string,
    userId: string,
  ): Promise<{ response: Response; reader: SseReader | null }> {
    const response = await callApi(`/api/expansions/${requestId}/stream`, {
      method: 'GET',
      session: { userId },
    });
    if (response.status !== 200) return { response, reader: null };
    const reader = new SseReader(response);
    readers.push(reader);
    return { response, reader };
  }

  it('emits the initial status immediately on connection', async () => {
    __setSseTimingForTests({ pollIntervalMs: 5000, keepAliveMs: 60000, timeoutMs: 60000 });
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'PENDING',
      attempt: 1,
    });

    const { reader } = await openStream(requestId, userId);
    const first = await reader!.next();
    expect(first?.event).toBe('status');
    expect(first?.data).toMatchObject({ status: 'PENDING', attempt: 1 });
  });

  it('emits a new status event when the request status changes', async () => {
    __setSseTimingForTests({ pollIntervalMs: 25, keepAliveMs: 60000, timeoutMs: 60000 });
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'PENDING',
    });

    const { reader } = await openStream(requestId, userId);
    expect((await reader!.next())?.data).toMatchObject({ status: 'PENDING' });

    await testDb.db
      .update(expansionRequests)
      .set({ status: 'LOCKED' })
      .where(eq(expansionRequests.id, requestId));

    const changed = await reader!.next(2000);
    expect(changed?.event).toBe('status');
    expect(changed?.data).toMatchObject({ status: 'LOCKED' });
  });

  it('emits a terminal event on COMPLETED and closes the stream', async () => {
    __setSseTimingForTests({ pollIntervalMs: 25, keepAliveMs: 60000, timeoutMs: 60000 });
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'PENDING',
    });

    const { reader } = await openStream(requestId, userId);
    await reader!.next();

    await testDb.db
      .update(expansionRequests)
      .set({ status: 'COMPLETED' })
      .where(eq(expansionRequests.id, requestId));

    const terminal = await reader!.next(2000);
    expect(terminal?.data).toMatchObject({ status: 'COMPLETED' });

    const close = await reader!.next(2000);
    expect(close?.event).toBe('close');

    const after = await reader!.next(2000);
    expect(after).toBeNull();
  });

  it('emits a terminal event on FAILED and closes the stream', async () => {
    __setSseTimingForTests({ pollIntervalMs: 25, keepAliveMs: 60000, timeoutMs: 60000 });
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'PENDING',
    });

    const { reader } = await openStream(requestId, userId);
    await reader!.next();

    await testDb.db
      .update(expansionRequests)
      .set({ status: 'FAILED', lastError: 'LLM timeout' })
      .where(eq(expansionRequests.id, requestId));

    const terminal = await reader!.next(2000);
    expect(terminal?.data).toMatchObject({
      status: 'FAILED',
      lastError: 'LLM timeout',
    });

    const close = await reader!.next(2000);
    expect(close?.event).toBe('close');
    expect(await reader!.next(2000)).toBeNull();
  });

  it('returns 401 for an unauthenticated connection', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: 'someone',
    });
    const response = await callApi(`/api/expansions/${requestId}/stream`, {
      method: 'GET',
      session: null,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it("returns 403 for another user's request", async () => {
    const userId = await insertTestUser(testDb.db);
    const other = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: other,
    });
    const response = await callApi(`/api/expansions/${requestId}/stream`, {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(403);
  });

  it('emits a timeout event when the request never completes', async () => {
    __setSseTimingForTests({ pollIntervalMs: 50, keepAliveMs: 60000, timeoutMs: 60 });
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'PENDING',
    });

    const { reader } = await openStream(requestId, userId);
    await reader!.next();
    const timeout = await reader!.next(2000);
    expect(timeout?.event).toBe('timeout');
  });

  it('sends keep-alive comments periodically', async () => {
    __setSseTimingForTests({ pollIntervalMs: 60000, keepAliveMs: 25, timeoutMs: 60000 });
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'PENDING',
    });

    const { reader } = await openStream(requestId, userId);
    await reader!.next(); // initial status
    const keepAlive = await reader!.next(2000);
    expect(keepAlive?.raw.startsWith(':')).toBe(true);
  });
});
