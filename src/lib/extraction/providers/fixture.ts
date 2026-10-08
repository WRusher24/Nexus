/**
 * Fixture-backed LLM provider (Milestone 6).
 *
 * Tests never call a live LLM. Instead they record the full call keyed by the
 * hash of the exact prompt:
 *
 *     sha256(systemPrompt + '\n---\n' + userPrompt)
 *
 * Because the prompt is deterministic (Amendment A1), the same input always
 * maps to the same recorded response. A `promptHash` of `'*'` registers a
 * wildcard used by tests that do not care to reproduce the raw prompt; an
 * exact match always wins over the wildcard.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../../wikipedia/parser';
import { ExtractionOutputSchema, type ExtractionOutput } from '../schema';
import { LlmError, type LlmCallInput, type LlmCallResult, type LlmProvider } from '../provider';

export const WILDCARD_PROMPT_HASH = '*';

export interface LlmFixtureResponse {
  parsed: ExtractionOutput;
  rawResponse: string;
  modelId: string;
  usage: { inputTokens: number; outputTokens: number };
  estimatedCostUsd: number;
}

export interface LlmFixture {
  /**
   * SHA-256 of (systemPrompt + '\n---\n' + userPrompt), or `'*'` for a
   * wildcard fixture.
   */
  promptHash: string;
  response: LlmFixtureResponse;
  /** Optional: force this fixture to throw instead of returning. */
  throwError?: LlmError;
}

export interface LlmFixtureStore {
  register(fixture: LlmFixture): void;
  registerByPrompt(
    systemPrompt: string,
    userPrompt: string,
    response: LlmFixtureResponse,
  ): void;
  loadDirectory(dir: string): Promise<void>;
  clear(): void;
  getHits(): string[];
  buildProvider(): LlmProvider;
}

/** Compute the canonical prompt hash used to key fixtures. */
export function hashPrompt(systemPrompt: string, userPrompt: string): string {
  return sha256(`${systemPrompt}\n---\n${userPrompt}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface SerializedThrowError {
  code: LlmError['code'];
  detail: string;
  retryable: boolean;
}

function reviveThrowError(value: unknown): LlmError | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.code;
  const detail = value.detail;
  const retryable = value.retryable;
  if (
    typeof code === 'string' &&
    typeof detail === 'string' &&
    typeof retryable === 'boolean'
  ) {
    return new LlmError(code as LlmError['code'], detail, retryable);
  }
  return undefined;
}

/**
 * Normalise a JSON fixture file into an LlmFixture. The `response.parsed` value
 * is validated with the Zod schema at load time so a malformed fixture fails
 * loudly rather than mid-test.
 */
function reviveFixture(raw: unknown): LlmFixture {
  if (!isRecord(raw)) {
    throw new Error('LlmFixture: fixture must be an object');
  }
  const promptHash = raw.promptHash;
  if (typeof promptHash !== 'string') {
    throw new Error('LlmFixture: promptHash must be a string');
  }

  const responseRaw = raw.response;
  if (!isRecord(responseRaw)) {
    throw new Error('LlmFixture: response must be an object');
  }

  const parsed = ExtractionOutputSchema.parse(responseRaw.parsed);
  const usageRaw = isRecord(responseRaw.usage) ? responseRaw.usage : {};
  const inputTokens =
    typeof usageRaw.inputTokens === 'number' ? usageRaw.inputTokens : 0;
  const outputTokens =
    typeof usageRaw.outputTokens === 'number' ? usageRaw.outputTokens : 0;

  const fixture: LlmFixture = {
    promptHash,
    response: {
      parsed,
      rawResponse:
        typeof responseRaw.rawResponse === 'string'
          ? responseRaw.rawResponse
          : JSON.stringify(parsed),
      modelId:
        typeof responseRaw.modelId === 'string' ? responseRaw.modelId : 'fixture',
      usage: { inputTokens, outputTokens },
      estimatedCostUsd:
        typeof responseRaw.estimatedCostUsd === 'number'
          ? responseRaw.estimatedCostUsd
          : 0,
    },
  };

  const throwError = reviveThrowError(raw.throwError);
  if (throwError) fixture.throwError = throwError;
  return fixture;
}

export function createLlmFixtureStore(): LlmFixtureStore {
  const fixtures = new Map<string, LlmFixture>();
  const hits: string[] = [];

  function register(fixture: LlmFixture): void {
    fixtures.set(fixture.promptHash, fixture);
  }

  function registerByPrompt(
    systemPrompt: string,
    userPrompt: string,
    response: LlmFixtureResponse,
  ): void {
    register({ promptHash: hashPrompt(systemPrompt, userPrompt), response });
  }

  async function loadDirectory(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const raw = JSON.parse(await readFile(join(dir, entry.name), 'utf8')) as unknown;
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        register(reviveFixture(item));
      }
    }
  }

  function clear(): void {
    fixtures.clear();
    hits.length = 0;
  }

  function getHits(): string[] {
    return [...hits];
  }

  function buildProvider(): LlmProvider {
    const defaultModel =
      fixtures.values().next().value?.response.modelId ?? 'fixture';

    async function generate(input: LlmCallInput): Promise<LlmCallResult> {
      const hash = hashPrompt(input.systemPrompt, input.userPrompt);
      const fixture =
        fixtures.get(hash) ?? fixtures.get(WILDCARD_PROMPT_HASH);
      if (!fixture) {
        throw new LlmError(
          'PROVIDER_ERROR',
          `no LLM fixture registered for prompt hash ${hash}`,
          false,
        );
      }
      hits.push(fixture.promptHash === WILDCARD_PROMPT_HASH ? hash : fixture.promptHash);
      if (fixture.throwError) throw fixture.throwError;
      return {
        parsed: fixture.response.parsed,
        rawResponse: fixture.response.rawResponse,
        modelId: fixture.response.modelId,
        usage: { ...fixture.response.usage },
        estimatedCostUsd: fixture.response.estimatedCostUsd,
      };
    }

    return { providerId: 'fixture', defaultModel, generate };
  }

  return { register, registerByPrompt, loadDirectory, clear, getHits, buildProvider };
}

/** Type-only helper for fixture authors. */
export type { SerializedThrowError };
