/**
 * OpenAI adapter (Milestone 6).
 *
 * Uses the Chat Completions API with Structured Outputs
 * (`response_format: { type: 'json_schema', ..., strict: true }`). OpenAI's
 * strict mode accepts only a subset of JSON Schema, so the Zod-derived schema
 * is post-processed by `convertZodToOpenAiStrictSchema`.
 *
 * No SDK: requests go through `fetch` (injectable for tests).
 */

import { z } from 'zod';
import { ExtractionOutputSchema } from '../schema';
import {
  fetchWithTimeout,
  LlmError,
  mapHttpError,
  validateExtractionJson,
  type LlmCallInput,
  type LlmCallResult,
  type LlmProvider,
} from '../provider';

export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 60000;

export interface OpenAiProviderOptions {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * JSON Schema keywords OpenAI Structured Outputs does not accept. They are
 * stripped from the generated schema; the application layer re-validates the
 * returned value with Zod, which restores every constraint.
 */
const UNSUPPORTED_KEYS = new Set([
  'maxLength',
  'minLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
  'examples',
  '$comment',
  'contentMediaType',
  'contentEncoding',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively transform a JSON Schema into OpenAI's strict subset:
 *   - drop unsupported keywords (`maxLength`, `minimum`, ...)
 *   - convert `type: ['string', 'null']` unions to `anyOf`
 *   - require every property; optional properties become required + nullable
 *   - force `additionalProperties: false` on every object
 */
function transformStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(transformStrict);
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYS.has(key) || key === '$schema') continue;
    out[key] = transformStrict(value);
  }

  // `type: [a, b, null]` -> `anyOf: [{type:a}, {type:b}, {type:null}]`.
  if (Array.isArray(out.type)) {
    const types = out.type as unknown[];
    delete out.type;
    out.anyOf = types.map((t) => ({ type: t }));
  }

  if (isPlainObject(out.properties)) {
    const properties = out.properties as Record<string, unknown>;
    const originalRequired = Array.isArray(out.required)
      ? (out.required as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const requiredSet = new Set(originalRequired);

    const transformed: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) {
      let propSchema = properties[key];
      if (!requiredSet.has(key)) {
        // Optional in Zod -> required + nullable in OpenAI strict mode.
        propSchema = { anyOf: [propSchema, { type: 'null' }] };
      }
      transformed[key] = propSchema;
    }

    out.properties = transformed;
    out.required = Object.keys(transformed);
    out.additionalProperties = false;
  }

  return out;
}

/**
 * Convert a Zod schema to a schema OpenAI Strict Structured Outputs accepts.
 * Exported for direct testing.
 */
export function convertZodToOpenAiStrictSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  const transformed = transformStrict(json);
  if (!isPlainObject(transformed)) {
    throw new Error('convertZodToOpenAiStrictSchema: root schema is not an object');
  }
  return transformed;
}

/**
 * OpenAI strict mode forces optional fields to be required-and-nullable, so a
 * model may emit `brief: null`. Zod `.optional()` accepts absence, not null;
 * strip nulls from known optional fields before validation.
 */
function stripNullOptionals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullOptionals);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null && key === 'brief') continue;
      out[key] = stripNullOptionals(entry);
    }
    return out;
  }
  return value;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAiProvider(options: OpenAiProviderOptions): LlmProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function generate(input: LlmCallInput): Promise<LlmCallResult> {
    const jsonSchema = convertZodToOpenAiStrictSchema(
      (input.schema as z.ZodType | undefined) ?? ExtractionOutputSchema,
    );

    const body = {
      model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      temperature: input.temperature ?? 0,
      max_tokens: input.maxOutputTokens ?? 4000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extraction_output',
          schema: jsonSchema,
          strict: true,
        },
      },
    };

    const response = await fetchWithTimeout(
      fetchFn,
      OPENAI_CHAT_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (!response.ok) {
      throw await mapHttpError(response, OPENAI_CHAT_URL);
    }

    const rawResponse = await response.text();

    let json: OpenAiResponse;
    try {
      json = JSON.parse(rawResponse) as OpenAiResponse;
    } catch (error) {
      throw new LlmError('INVALID_RESPONSE', `OpenAI returned non-JSON: ${String(error)}`, true);
    }

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LlmError('INVALID_RESPONSE', 'OpenAI response contained no message content', true);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (error) {
      throw new LlmError('INVALID_RESPONSE', `OpenAI content was not JSON: ${String(error)}`, true);
    }

    return validateExtractionJson(
      stripNullOptionals(parsedJson),
      rawResponse,
      model,
      json.usage?.prompt_tokens ?? 0,
      json.usage?.completion_tokens ?? 0,
    );
  }

  return { providerId: 'openai', defaultModel: model, generate };
}
