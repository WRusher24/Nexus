import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createLlmFixtureStore,
  hashPrompt,
  WILDCARD_PROMPT_HASH,
} from '../../../lib/extraction/providers/fixture';
import { fixtureResponse } from '../../helpers/llmFixture';
import { extractionOutput } from '../../fixtures/extraction/harness';

const LLM_DIR = fileURLToPath(new URL('../../fixtures/llm', import.meta.url));

describe('LLM fixture inventory', () => {
  it('loads every recorded fixture (each is validated by Zod)', async () => {
    const store = createLlmFixtureStore();
    await expect(store.loadDirectory(LLM_DIR)).resolves.toBeUndefined();
  });

  it('contains the required fixture files', async () => {
    const entries = await readdir(LLM_DIR);
    const jsonFiles = entries.filter((name) => name.endsWith('.json')).sort();
    expect(jsonFiles).toEqual(
      [
        'chronology-violation.json',
        'fabricated-quote.json',
        'injection-attempt-malicious.json',
        'napoleon-upstream.json',
        'treaty-of-versailles-downstream.json',
        'treaty-of-versailles-upstream.json',
        'wwi-upstream-rich.json',
        'wwi-upstream-sparse.json',
      ].sort(),
    );
  });

  it('exact prompt matches take precedence over a wildcard', async () => {
    const store = createLlmFixtureStore();
    const exact = extractionOutput({ focalName: 'Exact match' });
    const wildcard = extractionOutput({ focalName: 'Wildcard match' });
    store.register({ promptHash: WILDCARD_PROMPT_HASH, response: fixtureResponse(wildcard) });
    store.registerByPrompt('sys', 'user', fixtureResponse(exact));

    const provider = store.buildProvider();
    const result = await provider.generate({
      systemPrompt: 'sys',
      userPrompt: 'user',
      schema: {},
    });
    expect(result.parsed.focalEntity.name).toBe('Exact match');
    expect(store.getHits()).toEqual([hashPrompt('sys', 'user')]);
  });
});
