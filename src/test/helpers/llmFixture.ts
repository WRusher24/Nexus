/**
 * Convenience helpers for the LLM fixture store (Milestone 6).
 *
 * The production-facing store lives in
 * `src/lib/extraction/providers/fixture.ts`. This module re-exports it and
 * adds a tiny `fixtureResponse` builder so tests can register recorded-looking
 * responses without hand-writing every field.
 */

import type { ExtractionOutput } from '../../lib/extraction/schema';
import {
  createLlmFixtureStore,
  hashPrompt,
  WILDCARD_PROMPT_HASH,
  type LlmFixtureResponse,
  type LlmFixtureStore,
} from '../../lib/extraction/providers/fixture';

export { createLlmFixtureStore, hashPrompt, WILDCARD_PROMPT_HASH };
export type { LlmFixtureResponse, LlmFixtureStore };

/** Build a response envelope with sane defaults. */
export function fixtureResponse(
  parsed: ExtractionOutput,
  overrides: Partial<LlmFixtureResponse> = {},
): LlmFixtureResponse {
  return {
    parsed,
    rawResponse: JSON.stringify(parsed),
    modelId: 'gpt-4o-mini',
    usage: { inputTokens: 1800, outputTokens: 450 },
    estimatedCostUsd: 0.00054,
    ...overrides,
  };
}

/** Register a wildcard fixture (matches any prompt) for a test. */
export function registerWildcard(
  store: LlmFixtureStore,
  response: LlmFixtureResponse,
): void {
  store.register({ promptHash: WILDCARD_PROMPT_HASH, response });
}
