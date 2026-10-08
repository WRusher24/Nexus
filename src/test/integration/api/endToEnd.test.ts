import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __setRootNodeDepsForTests, __setSearchServiceForTests } from '../../../lib/http/testOverrides';
import { nodes, sourceDocuments } from '../../../lib/db/schema';
import { __resetRateLimits } from '../../../lib/http/rateLimit';
import { ensureUserQuota } from '../../../lib/queue/quota';
import {
  __resetSseTiming,
  __setSseTimingForTests,
} from '../../../lib/sse/stream';
import { createResolver } from '../../../lib/wikipedia/qidResolver';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createSearchService } from '../../../lib/wikipedia/search';
import { createSourceDocumentService } from '../../../lib/wikipedia/sourceDocuments';
import { createWikidataClient } from '../../../lib/wikipedia/wikidataClient';
import { createWikipediaClient } from '../../../lib/wikipedia/wikipediaClient';
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
import { createFixtureStore } from '../../helpers/httpFixture';
import { extractionOutput, proposedEdge } from '../../fixtures/extraction/harness';
import {
  buildFixtureConfig,
  drainOne,
  seedFocalScenario,
} from '../../helpers/workerHarness';

const WIKIPEDIA_DIR = fileURLToPath(
  new URL('../../fixtures/wikipedia', import.meta.url),
);
const WIKIDATA_DIR = fileURLToPath(
  new URL('../../fixtures/wikidata', import.meta.url),
);

/** Read an SSE response to completion and parse its frames. */
async function collectSse(response: Response): Promise<
  Array<{ event: string | null; data: unknown }>
> {
  if (!response.body) return [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      let event: string | null = null;
      let data: unknown = null;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          const text = line.slice(5).trim();
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }
      }
      return { event, data };
    });
}

/** Pick a sentence from the lead section that names the focal entity. */
function quoteMentioning(rawText: string, startOffset: number, phrase: string): string {
  const lead = rawText.slice(startOffset, startOffset + 900);
  const index = lead.indexOf(phrase);
  const anchor = index >= 0 ? index : 0;
  const start = lead.lastIndexOf('.', anchor) + 1;
  let end = lead.indexOf('.', anchor);
  if (end === -1 || end - start < 20) end = Math.min(lead.length - 1, anchor + 140);
  const quote = lead.slice(start, end + 1).trim();
  return quote.length >= 20 ? quote : `${phrase} was a major historical event that reshaped the world.`;
}

describe('end-to-end API journey', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await getTestDb();
    const store = createFixtureStore();
    await store.loadDirectory(WIKIPEDIA_DIR);
    await store.loadDirectory(WIKIDATA_DIR);
    const fetchFn = store.buildFetch();
    const limiter = new RateLimiter({ requestsPerSecond: 1_000_000 });
    const wikipedia = createWikipediaClient({
      contactEmail: 'dev@example.com',
      fetchFn,
      rateLimiter: limiter,
    });
    const wikidata = createWikidataClient({
      contactEmail: 'dev@example.com',
      fetchFn,
      rateLimiter: limiter,
    });
    __setSearchServiceForTests(
      createSearchService({ wikipedia, wikidata, resolver: createResolver(wikidata) }),
    );
    __setRootNodeDepsForTests({
      sourceDocuments: createSourceDocumentService({ db: testDb.db, wikipedia }),
      wikidata,
    });
  }, 60000);

  afterAll(async () => {
    __setSearchServiceForTests(null);
    __setRootNodeDepsForTests(null);
    __resetSseTiming();
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    setTestDb(testDb.db);
    __resetRateLimits();
    __setSseTimingForTests({ pollIntervalMs: 25, keepAliveMs: 60000, timeoutMs: 60000 });
  });

  it('search -> create root node -> expand -> complete -> read the graph', async () => {
    const userId = await insertTestUser(testDb.db);
    const session = { userId };

    // 1. Search.
    const searchResponse = await callApi(
      '/api/search?q=Treaty%20of%20Versailles',
      { method: 'GET', session },
    );
    expect(searchResponse.status).toBe(200);
    const search = (await searchResponse.json()) as {
      candidates: Array<{ pageId: number; title: string }>;
    };
    const top = search.candidates[0];
    expect(top).toBeDefined();

    // 2. Create a root node from the candidate.
    const rootResponse = await callApi('/api/root-nodes', {
      method: 'POST',
      session,
      body: {
        pageId: top!.pageId,
        title: top!.title,
        snippet: 'Treaty of Versailles',
        wordCount: 1000,
        resolvedQid: null,
        qidConfidence: 'NONE',
      },
    });
    expect(rootResponse.status).toBe(201);
    const root = (await rootResponse.json()) as {
      nodeId: string;
      sourceDocumentId: string;
    };

    // 3. Request an expansion over HTTP.
    const expandResponse = await callApi('/api/expansions', {
      method: 'POST',
      session,
      body: { nodeId: root.nodeId, direction: 'UPSTREAM' },
    });
    expect(expandResponse.status).toBe(202);
    const queued = (await expandResponse.json()) as { requestId: string };

    // 4. Run the worker against a fixture LLM + the node's real source doc.
    const [doc] = await testDb.db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, root.sourceDocumentId));
    expect(doc).toBeDefined();
    const quote = quoteMentioning(
      doc!.rawText,
      doc!.sectionIndex[0]?.startOffset ?? 0,
      'Treaty of Versailles',
    );
    const output = extractionOutput({
      focalName: 'Treaty of Versailles',
      edges: [
        proposedEdge({
          verbatimQuote: quote,
          relatedEntity: {
            name: 'World War I',
            entityType: 'EVENT',
            dateStart: { year: 1914, month: null, day: null, precision: 'YEAR' },
            dateEnd: { year: 1918, month: null, day: null, precision: 'YEAR' },
          },
        }),
      ],
    });
    const config = buildFixtureConfig(
      {
        sourceDocumentId: doc!.id,
        rawText: doc!.rawText,
        sectionIndex: doc!.sectionIndex,
      },
      output,
      { 'World War I': { qid: 'Q361', confidence: 'HIGH' } },
    );
    const drained = await drainOne(testDb.db, 'worker-e2e', config);
    expect(drained?.result.outcome).toBe('COMPLETED');

    // 5. Status endpoint reports COMPLETED.
    const statusResponse = await callApi(`/api/expansions/${queued.requestId}`, {
      method: 'GET',
      session,
    });
    expect(statusResponse.status).toBe(200);
    expect(((await statusResponse.json()) as { status: string }).status).toBe(
      'COMPLETED',
    );

    // 6. Streaming endpoint replays the terminal state and closes.
    const streamResponse = await callApi(
      `/api/expansions/${queued.requestId}/stream`,
      { method: 'GET', session },
    );
    expect(streamResponse.status).toBe(200);
    const frames = await collectSse(streamResponse);
    expect(frames[0]?.data).toMatchObject({ status: 'COMPLETED' });
    expect(frames.some((frame) => frame.event === 'close')).toBe(true);

    // 7. The new edge is visible in the node neighborhood.
    const neighborhood = await callApi(`/api/nodes/${root.nodeId}`, {
      method: 'GET',
      session,
    });
    expect(neighborhood.status).toBe(200);
    const body = (await neighborhood.json()) as { causes: unknown[] };
    expect(body.causes.length).toBeGreaterThan(0);

    const [node] = await testDb.db
      .select({ upstreamState: nodes.upstreamState })
      .from(nodes)
      .where(eq(nodes.id, root.nodeId));
    expect(node?.upstreamState).toBe('EXPANDED');
  });

  it('enforces quota across the expansion and quota endpoints', async () => {
    const userId = await insertTestUser(testDb.db);
    const session = { userId };
    await ensureUserQuota(testDb.db, userId, { dailyLimit: 1, monthlyLimit: 100 });

    const first = await seedFocalScenario(testDb.db, { label: 'Focal One' });
    const second = await seedFocalScenario(testDb.db, { label: 'Focal Two' });

    const queued = await callApi('/api/expansions', {
      method: 'POST',
      session,
      body: { nodeId: first.nodeId, direction: 'UPSTREAM' },
    });
    expect(queued.status).toBe(202);

    const blocked = await callApi('/api/expansions', {
      method: 'POST',
      session,
      body: { nodeId: second.nodeId, direction: 'UPSTREAM' },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    const quotaResponse = await callApi('/api/quota', {
      method: 'GET',
      session,
    });
    expect(quotaResponse.status).toBe(200);
    const quota = (await quotaResponse.json()) as {
      expansionsToday: number;
      remainingToday: number;
    };
    expect(quota.expansionsToday).toBe(1);
    expect(quota.remainingToday).toBe(0);
  });
});
