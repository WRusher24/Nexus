/**
 * Anthropic adapter (Milestone 6).
 *
 * Anthropic has no strict JSON-schema response mode, so structured output is
 * coerced through tool use: a single tool `emit_extraction` is declared with
 * the Zod-derived input schema and the model is forced to call it. The tool
 * call's `input` is already a JSON object — we validate it with Zod, never
 * `JSON.parse`.
 */

import { ExtractionOutputSchema } from '../schema';
import {
  fetchWithTimeout,
  LlmError,
  mapHttpError,
  validateExtractionJson,
  zodToJsonSchema,
  type LlmCallInput,
  type LlmCallResult,
  type LlmProvider,
} from '../provider';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-3-5-haiku-latest';
const DEFAULT_TIMEOUT_MS = 60000;
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface AnthropicContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripNullBriefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullBriefs);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null && key === 'brief') continue;
      out[key] = stripNullBriefs(entry);
    }
    return out;
  }
  return value;
}

export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): LlmProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function generate(input: LlmCallInput): Promise<LlmCallResult> {
    const inputSchema = zodToJsonSchema(
      (input.schema as unknown) ?? ExtractionOutputSchema,
    );

    const body = {
      model,
      max_tokens: input.maxOutputTokens ?? 4000,
      temperature: input.temperature ?? 0,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt }],
      tools: [
        {
          name: 'emit_extraction',
          description:
            'Emit the structured causal-extraction result. Always call this tool exactly once.',
          input_schema: inputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_extraction' },
    };

    const response = await fetchWithTimeout(
      fetchFn,
      ANTHROPIC_MESSAGES_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (!response.ok) {
      throw await mapHttpError(response, ANTHROPIC_MESSAGES_URL);
    }

    const rawResponse = await response.text();

    let json: AnthropicResponse;
    try {
      json = JSON.parse(rawResponse) as AnthropicResponse;
    } catch (error) {
      throw new LlmError(
        'INVALID_RESPONSE',
        `Anthropic returned non-JSON: ${String(error)}`,
        true,
      );
    }

    const toolUse = (json.content ?? []).find(
      (block) => block.type === 'tool_use' && block.name === 'emit_extraction',
    );

    if (!toolUse || toolUse.input === undefined) {
      throw new LlmError(
        'SCHEMA_MISMATCH',
        'Anthropic response contained no emit_extraction tool call',
        false,
      );
    }

    return validateExtractionJson(
      stripNullBriefs(toolUse.input),
      rawResponse,
      model,
      json.usage?.input_tokens ?? 0,
      json.usage?.output_tokens ?? 0,
    );
  }

  return { providerId: 'anthropic', defaultModel: model, generate };
}
