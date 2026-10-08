/**
 * LLM provider abstraction (Milestone 6).
 *
 * A provider is a tiny surface: one `generate` method. Providers are built on
 * the global `fetch` (or an injected `fetchFn` for tests) so that recorded HTTP
 * fixtures can serve responses without a network. No provider SDKs are used.
 *
 * Errors are normalised into `LlmError` with a machine-readable code and a
 * `retryable` flag. Adapters never retry internally; the caller decides.
 */

import { z } from 'zod';
import { ExtractionOutputSchema, type ExtractionOutput } from './schema';
import { createOpenAiProvider } from './providers/openai';
import { createAnthropicProvider } from './providers/anthropic';
import { createDeepSeekProvider } from './providers/deepseek';

export interface LlmCallInput {
  systemPrompt: string;
  userPrompt: string;
  /**
   * The canonical Zod schema for structured output. Each adapter derives the
   * shape it needs from this (JSON Schema, tool schema, or prompt text).
   */
  schema: unknown;
  /** Max output tokens hint. Default: 4000. */
  maxOutputTokens?: number;
  /** Model-specific temperature override. Default: 0 for determinism. */
  temperature?: number;
}

export interface LlmCallResult {
  /** The parsed structured output, already validated against the Zod schema. */
  parsed: ExtractionOutput;
  /** The raw response body as a string, for audit storage. */
  rawResponse: string;
  modelId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Estimated cost in USD, computed from the provider pricing table. */
  estimatedCostUsd: number;
}

export type LlmErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'SCHEMA_MISMATCH'
  | 'AUTH'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR';

export class LlmError extends Error {
  constructor(
    public code: LlmErrorCode,
    public detail: string,
    public retryable: boolean,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'LlmError';
  }
}

export interface LlmProvider {
  readonly providerId: 'openai' | 'anthropic' | 'deepseek' | 'fixture';
  readonly defaultModel: string;
  generate(input: LlmCallInput): Promise<LlmCallResult>;
}

/**
 * Approximate per-million-token pricing, in USD.
 *
 * Sources (retrieved 2026-10-08):
 *   - OpenAI:    https://openai.com/api/pricing/
 *   - Anthropic: https://www.anthropic.com/pricing
 *   - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
 *
 * These drift; update when a provider changes its published rates.
 */
export const MODEL_PRICING: Record<
  string,
  { inputPerMillion: number; outputPerMillion: number }
> = {
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'claude-3-5-sonnet-latest': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-3-5-haiku-latest': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19 },
};

/** Conservative fallback price: the maximum known price in each direction. */
function conservativeFallback(): { inputPerMillion: number; outputPerMillion: number } {
  let input = 0;
  let output = 0;
  for (const price of Object.values(MODEL_PRICING)) {
    input = Math.max(input, price.inputPerMillion);
    output = Math.max(output, price.outputPerMillion);
  }
  return { inputPerMillion: input, outputPerMillion: output };
}

const warnedModels = new Set<string>();

/**
 * Estimate cost in USD from a model id and token counts. Unknown models use
 * the most expensive known price and log a warning once per model id.
 */
export function computeCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  let price = MODEL_PRICING[modelId];
  if (!price) {
    price = conservativeFallback();
    if (!warnedModels.has(modelId)) {
      warnedModels.add(modelId);
      console.warn(
        `[extraction] unknown model "${modelId}"; using conservative pricing ($${price.inputPerMillion}/M in, $${price.outputPerMillion}/M out)`,
      );
    }
  }
  const cost =
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion;
  return cost;
}

/** Build the canonical JSON Schema (draft 2020-12) for the extraction output. */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  const json = z.toJSONSchema(schema as z.ZodType, { target: 'draft-2020-12' });
  const copy = { ...(json as Record<string, unknown>) };
  delete copy.$schema;
  return copy;
}

/**
 * Parse and Zod-validate a provider response body. Shared by every adapter so
 * that SCHEMA_MISMATCH semantics are identical.
 */
export function validateExtractionJson(
  value: unknown,
  rawResponse: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): LlmCallResult {
  const parsed = ExtractionOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new LlmError(
      'SCHEMA_MISMATCH',
      `response failed Zod validation: ${parsed.error.message.slice(0, 500)}`,
      false,
    );
  }
  return {
    parsed: parsed.data,
    rawResponse,
    modelId,
    usage: { inputTokens, outputTokens },
    estimatedCostUsd: computeCostUsd(modelId, inputTokens, outputTokens),
  };
}

/**
 * `fetch` with a hard timeout. Even if the injected fetch ignores the abort
 * signal, the timeout race rejects, so tests can simulate a hung provider.
 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LlmError('TIMEOUT', `request to ${url} exceeded ${timeoutMs}ms`, true));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchFn(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw new LlmError('NETWORK_ERROR', `request to ${url} failed: ${String(error)}`, true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Map a non-2xx response to a normalised `LlmError`. */
export async function mapHttpError(response: Response, url: string): Promise<LlmError> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '<unreadable body>';
  }
  const snippet = body.slice(0, 500);

  if (response.status === 401 || response.status === 403) {
    return new LlmError('AUTH', `HTTP ${response.status} from ${url}: ${snippet}`, false);
  }
  if (response.status === 429) {
    return new LlmError(
      'RATE_LIMITED',
      `HTTP 429 from ${url}: ${snippet}`,
      true,
    );
  }
  if (response.status === 400) {
    // Often a schema problem; retrying the identical request would fail again.
    return new LlmError('SCHEMA_MISMATCH', `HTTP 400 from ${url}: ${snippet}`, false);
  }
  if (response.status >= 500) {
    return new LlmError('PROVIDER_ERROR', `HTTP ${response.status} from ${url}: ${snippet}`, true);
  }
  return new LlmError(
    'PROVIDER_ERROR',
    `HTTP ${response.status} from ${url}: ${snippet}`,
    false,
  );
}

export interface ProviderFactoryOptions {
  providerId?: string;
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Factory that returns the configured provider.
 *
 * `EXTRACTION_PROVIDER` selects openai | anthropic | deepseek. In a Vitest
 * process we refuse to build a live provider (fixtures only). Fails fast when
 * the selected provider's API key is missing.
 */
export function getProvider(options: ProviderFactoryOptions = {}): LlmProvider {
  const providerId =
    options.providerId ??
    process.env.EXTRACTION_PROVIDER ??
    (process.env.VITEST ? 'fixture' : 'deepseek');

  if (providerId === 'fixture') {
    // Imported lazily to avoid a hard dependency in production builds.
    throw new Error(
      'getProvider("fixture") is only available through createLlmFixtureStore() in tests.',
    );
  }

  const apiKey =
    options.apiKey ??
    (providerId === 'openai'
      ? process.env.OPENAI_API_KEY
      : providerId === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.DEEPSEEK_API_KEY);

  if (!apiKey) {
    throw new Error(
      `getProvider: API key is required for provider "${providerId}". Set the corresponding environment variable.`,
    );
  }

  // Adapters are imported statically at the top of this module. The module
  // cycle (provider <-> adapter) is benign: adapters only touch provider
  // exports inside their function bodies, never at module-evaluation time.
  switch (providerId) {
    case 'openai':
      return createOpenAiProvider({
        apiKey,
        ...(options.model ? { model: options.model } : {}),
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    case 'anthropic':
      return createAnthropicProvider({
        apiKey,
        ...(options.model ? { model: options.model } : {}),
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    case 'deepseek':
      return createDeepSeekProvider({
        apiKey,
        ...(options.model ? { model: options.model } : {}),
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    default:
      throw new Error(`getProvider: unknown provider "${providerId}"`);
  }
}
