import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { normalize, normalizeString } from '../../../lib/quote/normalize';

/** Safe element access for Int32Array under noUncheckedIndexedAccess. */
function at(array: Int32Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw new Error(`no element at index ${index}`);
  return value;
}

describe('normalize', () => {
  it('1. empty string returns empty normalized text and map', () => {
    const result = normalize('');
    expect(result.normalized).toBe('');
    expect(result.toOriginal.length).toBe(0);
    expect(result.rawText).toBe('');
  });

  it('2. ASCII lowercase passes through with identity map', () => {
    const result = normalize('hello world');
    expect(result.normalized).toBe('hello world');
    for (let i = 0; i < result.normalized.length; i++) {
      expect(at(result.toOriginal, i)).toBe(i);
    }
  });

  it('3. uppercase is lowercased with correct offsets', () => {
    const result = normalize('Hello');
    expect(result.normalized).toBe('hello');
    expect(Array.from(result.toOriginal)).toEqual([0, 1, 2, 3, 4]);
  });

  it('4. multiple spaces collapse to one, mapped to the first space', () => {
    const result = normalize('a  b');
    expect(result.normalized).toBe('a b');
    expect(result.toOriginal.length).toBe(3);
    expect(at(result.toOriginal, 1)).toBe(1);
    expect(at(result.toOriginal, 2)).toBe(3);
  });

  it('5. tab collapses to a space', () => {
    expect(normalize('a\tb').normalized).toBe('a b');
  });

  it('6. newline collapses to a space', () => {
    expect(normalize('a\nb').normalized).toBe('a b');
  });

  it('7. mixed whitespace run collapses and maps to the following char offset', () => {
    const result = normalize('a  \t\n  b');
    expect(result.normalized).toBe('a b');
    expect(at(result.toOriginal, 1)).toBe(1);
    expect(at(result.toOriginal, 2)).toBe(7);
  });

  it('8. non-breaking space U+00A0 collapses to a regular space', () => {
    const result = normalize('a\u00A0b');
    expect(result.normalized).toBe('a b');
  });

  it('9. leading whitespace is trimmed', () => {
    expect(normalize('   hello').normalized).toBe('hello');
  });

  it('10. trailing whitespace is trimmed', () => {
    expect(normalize('hello   \n').normalized).toBe('hello');
  });

  it('11. strips a single citation marker', () => {
    expect(normalize('text [1] more').normalized).toBe('text more');
  });

  it('12. strips a multi-digit citation marker', () => {
    expect(normalize('text [42] more').normalized).toBe('text more');
  });

  it('13. strips [citation needed]', () => {
    expect(normalize('text [citation needed] more').normalized).toBe('text more');
  });

  it('14. strips [clarification needed]', () => {
    expect(normalize('text [clarification needed] more').normalized).toBe('text more');
  });

  it('15. strips [dubious – discuss] (en-dash)', () => {
    expect(normalize('text [dubious – discuss] more').normalized).toBe('text more');
  });

  it('16. strips [which?]', () => {
    expect(normalize('text [which?] more').normalized).toBe('text more');
  });

  it('17. marker words are case-insensitive', () => {
    expect(normalize('text [Citation Needed] more').normalized).toBe('text more');
  });

  it('18. unclosed bracket more than 60 chars away is literal', () => {
    const raw =
      'text [unclosed more text that goes on and on and on and never closes properly here';
    const result = normalize(raw);
    expect(result.normalized.includes('[')).toBe(true);
    expect(result.normalized).toContain('[unclosed');
  });

  it('19. bracket whose close is just outside the 60-char window is literal', () => {
    const raw = '[' + 'x'.repeat(70) + ']';
    const result = normalize(raw);
    expect(result.normalized).toBe(raw);
  });

  it('20. multiple markers in sequence are all stripped', () => {
    expect(normalize('a[1] b[2] c').normalized).toBe('a b c');
  });

  it('21. mapping across a marker points to the following source char', () => {
    const result = normalize('abc[1]def');
    expect(result.normalized).toBe('abcdef');
    expect(at(result.toOriginal, 3)).toBe(6);
    expect(at(result.toOriginal, 4)).toBe(7);
    expect(at(result.toOriginal, 5)).toBe(8);
  });

  it('22. NFC composes precomposed and decomposed forms identically', () => {
    const precomposed = 'caf\u00E9'; // café (é = U+00E9)
    const decomposed = 'cafe\u0301'; // cafe + combining acute
    expect(normalizeString(precomposed)).toBe('caf\u00E9');
    expect(normalizeString(decomposed)).toBe(normalizeString(precomposed));
  });

  it('23. the index map is monotonically non-decreasing', () => {
    const raw = 'The Assassination [1]  of\n  Archduke\tFranz Ferdinand!';
    const result = normalize(raw);
    for (let i = 0; i + 1 < result.toOriginal.length; i++) {
      expect(at(result.toOriginal, i)).toBeLessThanOrEqual(at(result.toOriginal, i + 1));
    }
  });

  it('24. normalized length always equals map length', () => {
    for (const raw of ['', 'abc', 'a  b', 'x[1]y', '\u00A0  ', 'cafe\u0301']) {
      const result = normalize(raw);
      expect(result.normalized.length).toBe(result.toOriginal.length);
    }
  });

  it('25. normalizeString equals normalize().normalized', () => {
    const raw = 'Some [2] Mixed\nWhitespace  Text';
    expect(normalizeString(raw)).toBe(normalize(raw).normalized);
  });

  // ── Property-based tests ──────────────────────────────────────────────────

  it('26. property: every map value is a valid index into rawText', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normalize(raw);
        if (result.normalized.length === 0) return true;
        for (let i = 0; i < result.toOriginal.length; i++) {
          const value = result.toOriginal[i];
          if (value === undefined) return false;
          if (value < 0 || value >= raw.length) return false;
        }
        return true;
      }),
    );
  });

  it('27. property: the index map is non-decreasing', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normalize(raw);
        for (let i = 0; i + 1 < result.toOriginal.length; i++) {
          const a = result.toOriginal[i];
          const b = result.toOriginal[i + 1];
          if (a === undefined || b === undefined || a > b) return false;
        }
        return true;
      }),
    );
  });

  it('28. property: normalization is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normalize(raw).normalized;
        const twice = normalize(once).normalized;
        return twice === once;
      }),
    );
  });

  it('29. property: normalized length always equals map length', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normalize(raw);
        return result.normalized.length === result.toOriginal.length;
      }),
    );
  });
});
