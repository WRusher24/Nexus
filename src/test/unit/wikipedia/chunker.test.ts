import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { chunkArticle } from '../../../lib/wikipedia/chunker';
import type { Direction, SectionInfo } from '../../../lib/wikipedia/types';

const FIXTURE_DIR = resolve(process.cwd(), 'src', 'test', 'fixtures', 'sources');

function loadFixture(name: string): { raw: string; sections: SectionInfo[] } {
  const raw = readFileSync(resolve(FIXTURE_DIR, `${name}.txt`), 'utf8');
  const parsed = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8')) as {
    sections: SectionInfo[];
  };
  return { raw, sections: parsed.sections };
}

function build(parts: Array<{ title: string; text: string }>): {
  raw: string;
  sections: SectionInfo[];
} {
  let raw = '';
  const sections: SectionInfo[] = [];
  for (const part of parts) {
    const startOffset = raw.length;
    raw += part.text;
    sections.push({ title: part.title, startOffset, endOffset: raw.length });
  }
  return { raw, sections };
}

describe('chunkArticle', () => {
  it('1. an empty sections array returns an empty array', () => {
    expect(chunkArticle('some raw text', [], 'UPSTREAM')).toEqual([]);
  });

  it('2. a single lead section returns one priority-1 chunk', () => {
    const { raw, sections } = build([{ title: '', text: 'Lead section text.' }]);
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.priority).toBe(1);
    expect(chunks[0]?.sectionTitle).toBe('');
    expect(chunks[0]?.text).toBe('Lead section text.');
  });

  it('3. UPSTREAM gives a Causes section priority 10', () => {
    const { raw, sections } = build([
      { title: '', text: 'Lead.' },
      { title: 'Causes', text: 'Cause text.' },
    ]);
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks.map((c) => c.priority)).toEqual([1, 10]);
  });

  it('4. UPSTREAM leaves an Aftermath section at priority 50', () => {
    const { raw, sections } = build([
      { title: '', text: 'Lead.' },
      { title: 'Aftermath', text: 'Aftermath text.' },
    ]);
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks.map((c) => c.priority)).toEqual([1, 50]);
  });

  it('5. DOWNSTREAM gives an Aftermath section priority 10', () => {
    const { raw, sections } = build([
      { title: '', text: 'Lead.' },
      { title: 'Aftermath', text: 'Aftermath text.' },
    ]);
    const chunks = chunkArticle(raw, sections, 'DOWNSTREAM');
    expect(chunks.map((c) => c.priority)).toEqual([1, 10]);
  });

  it('6. a "See also" section is excluded', () => {
    const { raw, sections } = build([
      { title: '', text: 'Lead.' },
      { title: 'See also', text: 'Links.' },
    ]);
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks.map((c) => c.sectionTitle)).toEqual(['']);
  });

  it('7. a "References" section is excluded', () => {
    const { raw, sections } = build([
      { title: '', text: 'Lead.' },
      { title: 'References', text: 'Refs.' },
    ]);
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks.map((c) => c.sectionTitle)).toEqual(['']);
  });

  it('8. chunks are sorted by ascending priority', () => {
    const { raw, sections } = build([
      { title: 'References', text: 'Refs.' },
      { title: 'Aftermath', text: 'After.' },
      { title: '', text: 'Lead.' },
      { title: 'Causes', text: 'Cause.' },
    ]);
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    for (let i = 0; i + 1 < chunks.length; i++) {
      const a = chunks[i];
      const b = chunks[i + 1];
      if (a === undefined || b === undefined) throw new Error('missing chunk');
      expect(a.priority).toBeLessThanOrEqual(b.priority);
    }
  });

  it('9. the lead section is first even when listed last', () => {
    const { raw, sections } = build([
      { title: 'Causes', text: 'Cause.' },
      { title: 'Aftermath', text: 'After.' },
      { title: '', text: 'Lead.' },
    ]);
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks[0]?.priority).toBe(1);
    expect(chunks[0]?.sectionTitle).toBe('');
  });

  it('10. every chunk text equals the raw substring at its offsets (WWI fixture)', () => {
    const { raw, sections } = loadFixture('wwi-abbreviated');
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(raw.substring(chunk.startOffset, chunk.endOffset));
      expect(chunk.text.length).toBe(chunk.endOffset - chunk.startOffset);
    }
  });

  it('11. long article respects the character budget (lead exempt)', () => {
    const { raw, sections } = loadFixture('long-article');
    const maxTotalChars = 2000;
    const chunks = chunkArticle(raw, sections, 'UPSTREAM', { maxTotalChars });

    const lead = chunks.find((c) => c.priority === 1);
    expect(lead).toBeDefined();

    let nonLeadChars = 0;
    let totalChars = 0;
    for (const chunk of chunks) {
      const len = chunk.text.length;
      totalChars += len;
      if (chunk.priority !== 1) nonLeadChars += len;
      expect(chunk.text).toBe(raw.substring(chunk.startOffset, chunk.endOffset));
    }

    expect(nonLeadChars).toBeLessThanOrEqual(maxTotalChars);
    expect(totalChars).toBeLessThanOrEqual(maxTotalChars + (lead?.text.length ?? 0));
  });

  it('12. the stub article fixture yields a single chunk', () => {
    const { raw, sections } = loadFixture('stub-article');
    const chunks = chunkArticle(raw, sections, 'UPSTREAM');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.priority).toBe(1);
    expect(chunks[0]?.text).toBe(raw);
  });

  it('13. property: every returned chunk preserves offsets exactly', () => {
    const partsArb = fc.array(
      fc.record({
        title: fc.string(),
        length: fc.integer({ min: 1, max: 60 }),
      }),
      { minLength: 1, maxLength: 8 },
    );

    fc.assert(
      fc.property(partsArb, fc.constantFrom<Direction>('UPSTREAM', 'DOWNSTREAM'), (parts, direction) => {
        let raw = '';
        const sections: SectionInfo[] = [];
        for (const part of parts) {
          const startOffset = raw.length;
          raw += 'x'.repeat(part.length);
          sections.push({ title: part.title, startOffset, endOffset: raw.length });
        }

        const chunks = chunkArticle(raw, sections, direction);
        return chunks.every(
          (chunk) =>
            chunk.text === raw.substring(chunk.startOffset, chunk.endOffset) &&
            chunk.startOffset >= 0 &&
            chunk.endOffset <= raw.length,
        );
      }),
    );
  });
});
