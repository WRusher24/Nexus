import { describe, expect, it } from 'vitest';
import { buildPrompt, PROMPT_VERSION } from '../../../lib/extraction/prompt';

const CHUNKS = [
  { sectionTitle: '', text: 'World War I was a global conflict from 1914 to 1918.' },
  {
    sectionTitle: 'Causes',
    text: 'The assassination of Archduke Franz Ferdinand triggered the July Crisis.',
  },
  {
    sectionTitle: 'Aftermath',
    text: 'The war led to the collapse of several empires.',
  },
];

function input(overrides: Partial<Parameters<typeof buildPrompt>[0]> = {}) {
  return {
    focalEntity: {
      name: 'World War I',
      nodeType: 'EVENT',
      qid: 'Q361',
      briefDates: '1914-1918',
    },
    direction: 'UPSTREAM' as const,
    chunks: CHUNKS,
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('returns non-empty system and user prompts', () => {
    const result = buildPrompt(input());
    expect(result.systemPrompt.length).toBeGreaterThan(200);
    expect(result.userPrompt.length).toBeGreaterThan(50);
  });

  it('wraps the source text in <source_text> delimiters', () => {
    const result = buildPrompt(input());
    expect(result.userPrompt).toContain('<source_text>');
    expect(result.userPrompt).toContain('</source_text>');
  });

  it('places the concatenated chunk text verbatim inside the delimiters', () => {
    const result = buildPrompt(input());
    const expected = CHUNKS.map((chunk) => chunk.text).join('\n\n');
    expect(result.concatenatedSourceText).toBe(expected);
    expect(result.userPrompt).toContain(`<source_text>\n${expected}\n</source_text>`);
  });

  it('does not contain ROOT_TOPIC (Amendment A1)', () => {
    const result = buildPrompt(input());
    const combined = `${result.systemPrompt}\n${result.userPrompt}`;
    expect(combined).not.toContain('ROOT_TOPIC');
  });

  it('does not contain any "depth" language (Amendment A1)', () => {
    const result = buildPrompt(input());
    const combined = `${result.systemPrompt}\n${result.userPrompt}`;
    expect(combined.toLowerCase()).not.toContain('depth');
    expect(combined).not.toContain('DEPTH_PENALTY');
  });

  it('mentions the focal entity name and node type', () => {
    const result = buildPrompt(input());
    expect(result.userPrompt).toContain('World War I');
    expect(result.userPrompt).toContain('EVENT');
  });

  it('includes the direction in the user prompt', () => {
    expect(buildPrompt(input({ direction: 'UPSTREAM' })).userPrompt).toContain('UPSTREAM');
    expect(buildPrompt(input({ direction: 'DOWNSTREAM' })).userPrompt).toContain('DOWNSTREAM');
  });

  it('includes chunks in the order provided (lead first)', () => {
    const result = buildPrompt(input());
    const leadIndex = result.userPrompt.indexOf(CHUNKS[0]!.text);
    const causesIndex = result.userPrompt.indexOf(CHUNKS[1]!.text);
    const aftermathIndex = result.userPrompt.indexOf(CHUNKS[2]!.text);
    expect(leadIndex).toBeGreaterThan(-1);
    expect(causesIndex).toBeGreaterThan(leadIndex);
    expect(aftermathIndex).toBeGreaterThan(causesIndex);
  });

  it('states the maximum of 12 edges', () => {
    const result = buildPrompt(input());
    expect(result.systemPrompt).toMatch(/at most 12 edges/i);
  });

  it('exports a semver PROMPT_VERSION', () => {
    expect(PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is deterministic for identical input', () => {
    const a = buildPrompt(input());
    const b = buildPrompt(input());
    expect(a).toEqual(b);
  });

  it('omits the QID line when the focal entity has no QID', () => {
    const result = buildPrompt(
      input({
        focalEntity: { name: 'Stub', nodeType: 'PLACE', qid: null, briefDates: 'unknown' },
      }),
    );
    expect(result.userPrompt).not.toContain('Wikidata QID');
  });
});
