import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtractionOutputSchema } from '../../../lib/extraction/schema';
import {
  computeCostUsd,
  LlmError,
  MODEL_PRICING,
} from '../../../lib/extraction/provider';
import {
  convertZodToOpenAiStrictSchema,
  createOpenAiProvider,
  OPENAI_CHAT_URL,
} from '../../../lib/extraction/providers/openai';
import {
  createAnthropicProvider,
  ANTHROPIC_MESSAGES_URL,
} from '../../../lib/extraction/providers/anthropic';
import {
  createDeepSeekProvider,
  DEEPSEEK_CHAT_URL,
} from '../../../lib/extraction/providers/deepseek';
import {
  createLlmFixtureStore,
  hashPrompt,
} from '../../../lib/extraction/providers/fixture';
import { createFixtureStore, type HttpFixture } from '../../helpers/httpFixture';
import { extractionOutput, proposedEdge } from '../../fixtures/extraction/harness';
import { fixtureResponse } from '../../helpers/llmFixture';

const OUTPUT = extractionOutput({
  focalName: 'World War I',
  direction: 'UPSTREAM',
  edges: [
    proposedEdge({
      verbatimQuote: 'The assassination triggered the July Crisis.',
      relatedEntity: { name: 'Assassination of Archduke Franz Ferdinand' },
    }),
  ],
});

const SYSTEM = 'system prompt';
const USER = 'user prompt';

function fetchFrom(fixtures: HttpFixture[]): typeof fetch {
  const store = createFixtureStore();
  for (const fixture of fixtures) store.register(fixture);
  return store.buildFetch();
}

function openAiContent(output: unknown): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
}

function deepSeekEnvelope(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 60 },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAI adapter', () => {
  it('returns parsed output, raw response and usage on success', async () => {
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        {
          url: OPENAI_CHAT_URL,
          method: 'POST',
          status: 200,
          body: JSON.parse(openAiContent(OUTPUT)),
        },
      ]),
    });

    const result = await provider.generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema });
    expect(result.parsed.focalEntity.name).toBe('World War I');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.rawResponse.length).toBeGreaterThan(0);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('maps 429 to RATE_LIMITED (retryable)', async () => {
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        { url: OPENAI_CHAT_URL, method: 'POST', status: 429, body: { error: 'slow down' } },
      ]),
    });
    const error = await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe('RATE_LIMITED');
    expect((error as LlmError).retryable).toBe(true);
  });

  it('maps 401 to AUTH (not retryable)', async () => {
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        { url: OPENAI_CHAT_URL, method: 'POST', status: 401, body: { error: 'bad key' } },
      ]),
    });
    const error = (await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('AUTH');
    expect(error.retryable).toBe(false);
  });

  it('maps 400 to SCHEMA_MISMATCH (not retryable)', async () => {
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        { url: OPENAI_CHAT_URL, method: 'POST', status: 400, body: { error: 'bad schema' } },
      ]),
    });
    const error = (await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('SCHEMA_MISMATCH');
    expect(error.retryable).toBe(false);
  });

  it('maps a hung request to TIMEOUT (retryable)', async () => {
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      timeoutMs: 20,
      fetchFn: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    const error = (await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });
});

describe('Anthropic adapter', () => {
  it('parses a tool_use response', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        {
          url: ANTHROPIC_MESSAGES_URL,
          method: 'POST',
          status: 200,
          body: {
            content: [{ type: 'tool_use', name: 'emit_extraction', input: OUTPUT }],
            usage: { input_tokens: 80, output_tokens: 40 },
          },
        },
      ]),
    });
    const result = await provider.generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema });
    expect(result.parsed.edges).toHaveLength(1);
    expect(result.usage.outputTokens).toBe(40);
  });

  it('rejects a response with no tool call as SCHEMA_MISMATCH', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        {
          url: ANTHROPIC_MESSAGES_URL,
          method: 'POST',
          status: 200,
          body: { content: [{ type: 'text', text: 'no tool here' }], usage: {} },
        },
      ]),
    });
    const error = (await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('SCHEMA_MISMATCH');
    expect(error.retryable).toBe(false);
  });

  it('maps 500 to PROVIDER_ERROR (retryable)', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        { url: ANTHROPIC_MESSAGES_URL, method: 'POST', status: 500, body: 'oops' },
      ]),
    });
    const error = (await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.retryable).toBe(true);
  });
});

describe('DeepSeek adapter', () => {
  it('parses and Zod-validates a JSON response', async () => {
    const provider = createDeepSeekProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        {
          url: DEEPSEEK_CHAT_URL,
          method: 'POST',
          status: 200,
          body: JSON.parse(deepSeekEnvelope(JSON.stringify(OUTPUT))),
        },
      ]),
    });
    const result = await provider.generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema });
    expect(result.parsed.direction).toBe('UPSTREAM');
  });

  it('maps schema-invalid JSON to SCHEMA_MISMATCH (not retryable)', async () => {
    const provider = createDeepSeekProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        {
          url: DEEPSEEK_CHAT_URL,
          method: 'POST',
          status: 200,
          body: JSON.parse(deepSeekEnvelope(JSON.stringify({ not: 'our schema' }))),
        },
      ]),
    });
    const error = (await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('SCHEMA_MISMATCH');
    expect(error.retryable).toBe(false);
  });

  it('maps non-JSON message content to INVALID_RESPONSE (retryable)', async () => {
    const provider = createDeepSeekProvider({
      apiKey: 'test-key',
      fetchFn: fetchFrom([
        {
          url: DEEPSEEK_CHAT_URL,
          method: 'POST',
          status: 200,
          body: JSON.parse(deepSeekEnvelope('this is not json')),
        },
      ]),
    });
    const error = (await provider
      .generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('INVALID_RESPONSE');
    expect(error.retryable).toBe(true);
  });
});

describe('fixture provider', () => {
  it('returns the fixture registered for the matching prompt hash', async () => {
    const store = createLlmFixtureStore();
    const response = fixtureResponse(OUTPUT);
    store.registerByPrompt(SYSTEM, USER, response);
    const provider = store.buildProvider();

    const result = await provider.generate({ systemPrompt: SYSTEM, userPrompt: USER, schema: ExtractionOutputSchema });
    expect(result.parsed.focalEntity.name).toBe('World War I');
    expect(store.getHits()).toEqual([hashPrompt(SYSTEM, USER)]);
  });

  it('throws when no fixture matches', async () => {
    const store = createLlmFixtureStore();
    const provider = store.buildProvider();
    const error = (await provider
      .generate({ systemPrompt: 'x', userPrompt: 'y', schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('PROVIDER_ERROR');
  });

  it('can be configured to throw a specific LlmError', async () => {
    const store = createLlmFixtureStore();
    store.register({
      promptHash: '*',
      response: fixtureResponse(OUTPUT),
      throwError: new LlmError('TIMEOUT', 'forced', true),
    });
    const provider = store.buildProvider();
    const error = (await provider
      .generate({ systemPrompt: 'x', userPrompt: 'y', schema: ExtractionOutputSchema })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });
});

describe('pricing', () => {
  it('computes cost from MODEL_PRICING', () => {
    const price = MODEL_PRICING['gpt-4o-mini']!;
    expect(computeCostUsd('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(
      price.inputPerMillion + price.outputPerMillion,
      10,
    );
  });

  it('uses a conservative fallback for unknown models and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const maxInput = Math.max(...Object.values(MODEL_PRICING).map((p) => p.inputPerMillion));
    const model = `unknown-model-${Date.now()}`;
    expect(computeCostUsd(model, 1_000_000, 0)).toBeCloseTo(maxInput, 10);
    expect(warn).toHaveBeenCalled();
  });
});

describe('convertZodToOpenAiStrictSchema', () => {
  function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visit);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      const obj = node as Record<string, unknown>;
      visit(obj);
      for (const value of Object.values(obj)) walk(value, visit);
    }
  }

  it('strips unsupported keywords and enforces strict objects', () => {
    const schema = convertZodToOpenAiStrictSchema(ExtractionOutputSchema);
    const unsupported = ['maxLength', 'minLength', 'minimum', 'maximum', 'maxItems'];
    walk(schema, (obj) => {
      for (const key of unsupported) {
        expect(obj[key]).toBeUndefined();
      }
      if (obj.properties) {
        expect(obj.additionalProperties).toBe(false);
        expect(obj.required).toEqual(Object.keys(obj.properties as Record<string, unknown>));
      }
      if (obj.type !== undefined) {
        expect(Array.isArray(obj.type)).toBe(false);
      }
    });
  });

  it('makes the optional brief field required and nullable', () => {
    const schema = convertZodToOpenAiStrictSchema(ExtractionOutputSchema);
    const properties = schema.properties as Record<string, unknown>;
    const focal = properties.focalEntity as Record<string, unknown>;
    expect((focal.required as string[]).includes('brief')).toBe(true);
    const brief = (focal.properties as Record<string, unknown>).brief as Record<string, unknown>;
    expect(brief.anyOf).toBeDefined();
  });
});
