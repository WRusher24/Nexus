/**
 * DeepSeek adapter (Milestone 6).
 *
 * DeepSeek's API is OpenAI-compatible, and it supports `json_object` response
 * mode (weaker than JSON-schema mode): the model guarantees syntactically
 * valid JSON but not conformance to our schema. The schema is therefore echoed
 * into the system prompt and the response is validated strictly with Zod.
 * A Zod failure is a `SCHEMA_MISMATCH` (not retryable) — the adapter never
 * silently retries.
 */

import { z } from 'zod';
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

export const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;

export interface DeepSeekProviderOptions {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createDeepSeekProvider(
  options: DeepSeekProviderOptions,
): LlmProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function generate(input: LlmCallInput): Promise<LlmCallResult> {
    const schemaForPrompt = zodToJsonSchema(
      (input.schema as z.ZodType | undefined) ?? ExtractionOutputSchema,
    );
    const systemWithSchema = `${input.systemPrompt}\n\n## RESPONSE FORMAT\n\nReturn ONLY a single JSON object (no markdown fence, no commentary) conforming to this JSON Schema:\n${JSON.stringify(schemaForPrompt)}`;

    const body = {
      model,
      messages: [
        { role: 'system', content: systemWithSchema },
        { role: 'user', content: input.userPrompt },
      ],
      temperature: input.temperature ?? 0,
      max_tokens: input.maxOutputTokens ?? 4000,
      response_format: { type: 'json_object' },
    };

    const response = await fetchWithTimeout(
      fetchFn,
      DEEPSEEK_CHAT_URL,
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
      throw await mapHttpError(response, DEEPSEEK_CHAT_URL);
    }

    const rawResponse = await response.text();

    let json: DeepSeekResponse;
    try {
      json = JSON.parse(rawResponse) as DeepSeekResponse;
    } catch (error) {
      throw new LlmError(
        'INVALID_RESPONSE',
        `DeepSeek returned non-JSON envelope: ${String(error)}`,
        true,
      );
    }

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LlmError(
        'INVALID_RESPONSE',
        'DeepSeek response contained no message content',
        true,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (error) {
      throw new LlmError(
        'INVALID_RESPONSE',
        `DeepSeek content was not JSON: ${String(error)}`,
        true,
      );
    }

    return validateExtractionJson(
      parsedJson,
      rawResponse,
      model,
      json.usage?.prompt_tokens ?? 0,
      json.usage?.completion_tokens ?? 0,
    );
  }

  return { providerId: 'deepseek', defaultModel: model, generate };
}
