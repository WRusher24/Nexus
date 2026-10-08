import { describe, expect, it } from 'vitest';
import { parseArticleText, sha256 } from '../../../lib/wikipedia/parser';

describe('parseArticleText', () => {
  it('returns an empty lead section for empty input', () => {
    const parsed = parseArticleText('');
    expect(parsed.plainText).toBe('');
    expect(parsed.sections).toEqual([
      { title: '', startOffset: 0, endOffset: 0 },
    ]);
  });

  it('returns one lead section when no section titles are supplied', () => {
    const parsed = parseArticleText('Just a lead paragraph.');
    expect(parsed.plainText).toBe('Just a lead paragraph.');
    expect(parsed.sections).toHaveLength(1);
    const lead = parsed.sections[0];
    expect(lead?.title).toBe('');
    expect(lead?.startOffset).toBe(0);
    expect(lead?.endOffset).toBe(parsed.plainText.length);
  });

  it('splits lead + Causes + Aftermath at heading lines', () => {
    const raw = 'Lead intro.\n\nCauses\n\nCause body.\n\nAftermath\n\nAfter body.';
    const parsed = parseArticleText(raw, ['Causes', 'Aftermath']);

    expect(parsed.sections.map((section) => section.title)).toEqual([
      '',
      'Causes',
      'Aftermath',
    ]);
    for (const section of parsed.sections) {
      expect(
        parsed.plainText.substring(section.startOffset, section.endOffset),
      ).toContain(section.title);
    }
  });

  it('does not treat a title mentioned inside body text as a heading', () => {
    const raw =
      'Lead paragraph.\n\nCauses\n\nThis body discusses the Causes of the war at length.';
    const parsed = parseArticleText(raw, ['Causes']);
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[1]?.title).toBe('Causes');
    // The first (heading) occurrence wins, not the body mention.
    expect(parsed.plainText[parsed.sections[1]?.startOffset ?? -1]).toBe('C');
  });

  it('skips section titles that are not present in the text', () => {
    const parsed = parseArticleText('Lead.\n\nCauses\n\nBody.', [
      'Not Present',
      'Causes',
    ]);
    expect(parsed.sections.map((section) => section.title)).toEqual([
      '',
      'Causes',
    ]);
  });

  it('normalises CRLF line endings to LF', () => {
    const parsed = parseArticleText('Lead.\r\n\r\nCauses\r\n\r\nBody.', ['Causes']);
    expect(parsed.plainText.includes('\r')).toBe(false);
    expect(parsed.sections).toHaveLength(2);
  });

  it('collapses runs of three or more newlines to two', () => {
    const parsed = parseArticleText('A\n\n\n\n\nB');
    expect(parsed.plainText).toBe('A\n\nB');
  });

  it('produces contiguous section offsets', () => {
    const raw = 'Lead.\n\nOne\n\nOne body.\n\nTwo\n\nTwo body.\n\nThree\n\nThree body.';
    const parsed = parseArticleText(raw, ['One', 'Two', 'Three']);
    for (let i = 0; i < parsed.sections.length - 1; i += 1) {
      expect(parsed.sections[i]?.endOffset).toBe(
        parsed.sections[i + 1]?.startOffset,
      );
    }
  });

  it('ends the last section at plainText.length', () => {
    const raw = 'Lead.\n\nOne\n\nOne body.\n\nTwo\n\nTwo body.';
    const parsed = parseArticleText(raw, ['One', 'Two']);
    const last = parsed.sections[parsed.sections.length - 1];
    expect(last?.endOffset).toBe(parsed.plainText.length);
  });

  it('handles repeated headings deterministically', () => {
    const raw = 'Lead.\n\nNotes\n\nFirst notes.\n\nNotes\n\nSecond notes.';
    const parsed = parseArticleText(raw, ['Notes', 'Notes']);
    const titles = parsed.sections.map((section) => section.title);
    expect(titles).toEqual(['', 'Notes', 'Notes']);
    expect(parsed.sections[1]?.endOffset).toBe(parsed.sections[2]?.startOffset);
  });

  it('trims leading and trailing whitespace before computing offsets', () => {
    const parsed = parseArticleText('\n\n  Lead body.  \n\n', []);
    expect(parsed.plainText).toBe('Lead body.');
    expect(parsed.sections[0]?.endOffset).toBe('Lead body.'.length);
  });
});

describe('sha256', () => {
  it('returns the known hash for "hello"', () => {
    expect(sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});
