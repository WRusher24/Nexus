import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { normalize } from '../../../lib/quote/normalize';
import {
  quoteMentionsAnyEntity,
  verifyQuote,
  type QuoteVerificationResult,
} from '../../../lib/quote/verify';

const SOURCE =
  'The assassination of Archduke Franz Ferdinand of Austria on 28 June 1914 ' +
  'triggered the July Crisis.[1] The alliance system then drew the great powers into war.[2]';

const NORMALIZED_SOURCE = normalize(SOURCE);

/** Narrow a result to VERIFIED, failing loudly otherwise. */
function expectVerified(result: QuoteVerificationResult) {
  if (result.status !== 'VERIFIED') {
    throw new Error(`expected VERIFIED, got ${result.status}`);
  }
  return result;
}

describe('verifyQuote', () => {
  it('1. exact substring match is VERIFIED with correct offsets', () => {
    const quote = 'Archduke Franz Ferdinand of Austria';
    const result = expectVerified(verifyQuote(quote, NORMALIZED_SOURCE, []));
    expect(result.charOffsetStart).toBe(SOURCE.indexOf('Archduke'));
    expect(result.matchedOriginalText).toBe(quote);
  });

  it('2. matching is case-insensitive', () => {
    const result = expectVerified(
      verifyQuote('ARCHDUKE FRANZ FERDINAND', NORMALIZED_SOURCE, []),
    );
    expect(result.matchedOriginalText).toBe('Archduke Franz Ferdinand');
  });

  it('3. internal whitespace variation still matches', () => {
    const result = expectVerified(
      verifyQuote('Archduke  Franz  Ferdinand', NORMALIZED_SOURCE, []),
    );
    expect(result.matchedOriginalText).toBe('Archduke Franz Ferdinand');
  });

  it('4. a newline instead of a space still matches', () => {
    const result = expectVerified(
      verifyQuote('Archduke\nFranz Ferdinand', NORMALIZED_SOURCE, []),
    );
    expect(result.matchedOriginalText).toBe('Archduke Franz Ferdinand');
  });

  it('5. a quote shorter than 10 normalized chars is NO_MATCH', () => {
    const result = verifyQuote('the', NORMALIZED_SOURCE, []);
    expect(result).toEqual({ status: 'NOT_FOUND', reason: 'NO_MATCH' });
  });

  it('6. a quote absent from the source is NO_MATCH', () => {
    const result = verifyQuote('Napoleon invaded Russia in 1812', NORMALIZED_SOURCE, []);
    expect(result).toEqual({ status: 'NOT_FOUND', reason: 'NO_MATCH' });
  });

  it('7. a quote ending at a citation marker includes the marker in matchedOriginalText', () => {
    const quote = 'triggered the July Crisis.[1]';
    const result = expectVerified(verifyQuote(quote, NORMALIZED_SOURCE, []));
    expect(result.matchedOriginalText).toBe('triggered the July Crisis.[1]');
    expect(result.matchedOriginalText).toBe(
      SOURCE.substring(result.charOffsetStart, result.charOffsetEnd),
    );
  });

  it('8. a quote at the start of the text has charOffsetStart 0', () => {
    const result = expectVerified(
      verifyQuote('The assassination of Archduke Franz Ferdinand', NORMALIZED_SOURCE, []),
    );
    expect(result.charOffsetStart).toBe(0);
  });

  it('9. a quote at the end of the text has charOffsetEnd at the raw length', () => {
    const result = expectVerified(
      verifyQuote('drew the great powers into war.', NORMALIZED_SOURCE, []),
    );
    expect(result.charOffsetEnd).toBe(SOURCE.length);
  });

  it('10. a quote spanning a source marker (but not containing it) is VERIFIED', () => {
    const quote = 'triggered the July Crisis. The alliance';
    const result = expectVerified(verifyQuote(quote, NORMALIZED_SOURCE, []));
    expect(result.matchedOriginalText).toBe('triggered the July Crisis.[1] The alliance');
  });

  it('11. a quote within a single chunk is VERIFIED', () => {
    const result = expectVerified(
      verifyQuote('The assassination of Archduke Franz Ferdinand', NORMALIZED_SOURCE, [
        { startOffset: 0, endOffset: 100 },
      ]),
    );
    expect(result.charOffsetStart).toBe(0);
  });

  it('12. a quote outside every chunk is OUTSIDE_SENT_CHUNKS', () => {
    const result = verifyQuote('The assassination of Archduke Franz Ferdinand', NORMALIZED_SOURCE, [
      { startOffset: 150, endOffset: 220 },
    ]);
    expect(result).toEqual({ status: 'NOT_FOUND', reason: 'OUTSIDE_SENT_CHUNKS' });
  });

  it('13. a quote straddling a chunk boundary is OUTSIDE_SENT_CHUNKS', () => {
    const result = verifyQuote('Archduke Franz Ferdinand of Austria', NORMALIZED_SOURCE, [
      { startOffset: 0, endOffset: 50 },
    ]);
    expect(result).toEqual({ status: 'NOT_FOUND', reason: 'OUTSIDE_SENT_CHUNKS' });
  });

  it('14. an empty chunk list disables the chunk filter', () => {
    const result = expectVerified(
      verifyQuote('Archduke Franz Ferdinand of Austria', NORMALIZED_SOURCE, []),
    );
    expect(result.charOffsetStart).toBe(SOURCE.indexOf('Archduke'));
  });

  it('15. a quote inside the second of several chunks is VERIFIED', () => {
    const start = SOURCE.indexOf('Archduke');
    const result = expectVerified(
      verifyQuote('Archduke Franz Ferdinand', NORMALIZED_SOURCE, [
        { startOffset: 0, endOffset: 20 },
        { startOffset: start, endOffset: start + 40 },
      ]),
    );
    expect(result.charOffsetStart).toBe(start);
  });

  // ── Property-based tests ──────────────────────────────────────────────────

  it('21. property: a contiguous word substring of length >= 10 verifies with equivalent text', () => {
    const word = fc.stringMatching(/^[a-z]{3,6}$/);
    const caseArb = fc.array(word, { minLength: 3, maxLength: 10 }).chain((words) =>
      fc
        .tuple(
          fc.integer({ min: 0, max: words.length - 1 }),
          fc.integer({ min: 0, max: words.length - 1 }),
        )
        .map(([i, j]) => {
          const lo = Math.min(i, j);
          const hi = Math.max(i, j);
          return {
            raw: words.join(' '),
            quote: words.slice(lo, hi + 1).join(' '),
          };
        }),
    );

    fc.assert(
      fc.property(caseArb, ({ raw, quote }) => {
        if (quote.length < 10) return true; // too short to verify by design
        const result = verifyQuote(quote, normalize(raw), []);
        if (result.status !== 'VERIFIED') return false;
        // The matched original text must normalize to the same normalized quote.
        return normalize(result.matchedOriginalText).normalized === normalize(quote).normalized;
      }),
    );
  });

  it('22. property: a quote not present in the normalized source is NOT_FOUND', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        fc.string({ minLength: 0, maxLength: 60 }),
        (raw, quote) => {
          const source = normalize(raw);
          const normalizedQuote = normalize(quote).normalized;
          const result = verifyQuote(quote, source, []);
          const contained =
            normalizedQuote.length >= 10 && source.normalized.includes(normalizedQuote);
          if (contained) return result.status === 'VERIFIED';
          return result.status === 'NOT_FOUND';
        },
      ),
    );
  });

  it('22b. property: a quote from a disjoint alphabet is always NOT_FOUND', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{3,6}$/), { minLength: 1, maxLength: 10 }),
        fc.stringMatching(/^[0-9]{10,20}$/),
        (words, digits) => {
          const raw = words.join(' ');
          const result = verifyQuote(digits, normalize(raw), []);
          return result.status === 'NOT_FOUND';
        },
      ),
    );
  });
});

describe('quoteMentionsAnyEntity', () => {
  it('16. returns true when the quote contains an entity token', () => {
    expect(
      quoteMentionsAnyEntity('Archduke Franz Ferdinand was assassinated', [
        'Archduke Franz Ferdinand',
      ]),
    ).toBe(true);
  });

  it('17. returns false when the quote contains none of the entity tokens', () => {
    expect(
      quoteMentionsAnyEntity('The weather was pleasant that day', ['Archduke Franz Ferdinand']),
    ).toBe(false);
  });

  it('18. returns true (cannot judge) when no entity yields a 4+ char token', () => {
    expect(quoteMentionsAnyEntity('anything at all here', ['War', 'Bat'])).toBe(true);
  });

  it('19. returns true when one of several entities matches', () => {
    expect(
      quoteMentionsAnyEntity('Franz was present at the signing', [
        'Napoleon Bonaparte',
        'Franz Ferdinand',
      ]),
    ).toBe(true);
  });

  it('20. returns true when a multi-token entity name has one matching token', () => {
    expect(
      quoteMentionsAnyEntity('The Austria region was affected', [
        'Archduke Franz Ferdinand of Austria',
      ]),
    ).toBe(true);
  });
});
