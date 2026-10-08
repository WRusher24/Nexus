/**
 * Quote verification against a normalized source (Amendment A5, invariant P3).
 *
 * `verifyQuote` locates a normalized quote inside a normalized source and maps
 * the match back to UTF-16 offsets in the original rawText. `quoteMentionsAnyEntity`
 * implements the low-bar relevance check from Amendment A7.
 *
 * No I/O. Pure functions.
 */

import { normalize, type NormalizedText } from './normalize';

export type QuoteVerificationResult =
  | {
      status: 'VERIFIED';
      /** Offset in the ORIGINAL rawText where the quote begins. */
      charOffsetStart: number;
      /** Offset in the ORIGINAL rawText where the quote ends (exclusive). */
      charOffsetEnd: number;
      /**
       * The matched text as it appears in the original rawText. This is
       * `rawText.substring(charOffsetStart, charOffsetEnd)`; because the
       * normalization strips citation markers, a quote ending immediately
       * before a marker will include that marker here (matching the raw text).
       */
      matchedOriginalText: string;
    }
  | {
      status: 'NOT_FOUND';
      reason: 'NO_MATCH' | 'MULTIPLE_MATCHES_OUTSIDE_CHUNKS' | 'OUTSIDE_SENT_CHUNKS';
    };

export interface ChunkRange {
  /** Offset in rawText where this chunk begins. */
  startOffset: number;
  /** Offset in rawText where this chunk ends (exclusive). */
  endOffset: number;
}

/** Quotes shorter than this (after normalization) are too ambiguous to accept. */
const MIN_QUOTE_LENGTH = 10;

function readInt32(array: Int32Array, index: number, fallback: number): number {
  const value = array[index];
  return value === undefined ? fallback : value;
}

/**
 * Verify that a quote exists in the source text and record its original offsets.
 *
 * Algorithm (see the M3 brief):
 *   1. Normalize the quote with the same `normalize()` used for the source.
 *   2. Find every occurrence of the normalized quote in the normalized source.
 *   3. Map each match back to original offsets via `toOriginal`.
 *   4. Keep only matches that fall entirely within one sent chunk.
 *   5. Zero matches overall -> NO_MATCH.
 *   6. Matches exist but none inside sent chunks -> OUTSIDE_SENT_CHUNKS.
 *   7. Otherwise return the first valid match by position.
 *
 * An empty `sentChunks` array disables the chunk filter (testing only).
 */
export function verifyQuote(
  quoteText: string,
  normalizedSource: NormalizedText,
  sentChunks: ChunkRange[],
): QuoteVerificationResult {
  const normalizedQuote = normalize(quoteText).normalized;

  if (normalizedQuote.length < MIN_QUOTE_LENGTH) {
    return { status: 'NOT_FOUND', reason: 'NO_MATCH' };
  }

  const haystack = normalizedSource.normalized;
  const map = normalizedSource.toOriginal;
  const rawText = normalizedSource.rawText;

  // Find every (possibly overlapping) occurrence.
  const matchStarts: number[] = [];
  let fromIndex = 0;
  for (;;) {
    const found = haystack.indexOf(normalizedQuote, fromIndex);
    if (found === -1) break;
    matchStarts.push(found);
    fromIndex = found + 1;
  }

  if (matchStarts.length === 0) {
    return { status: 'NOT_FOUND', reason: 'NO_MATCH' };
  }

  for (const start of matchStarts) {
    const end = start + normalizedQuote.length;
    const charOffsetStart = readInt32(map, start, 0);
    // The exclusive end is the origin of the next normalized character; when
    // the match reaches the end of the normalized text, extend to rawText end.
    // This naturally includes any citation markers stripped immediately after
    // the final matched character.
    const charOffsetEnd =
      end < map.length ? readInt32(map, end, rawText.length) : rawText.length;

    const withinChunk =
      sentChunks.length === 0 ||
      sentChunks.some(
        (chunk) =>
          charOffsetStart >= chunk.startOffset && charOffsetEnd <= chunk.endOffset,
      );

    if (withinChunk) {
      return {
        status: 'VERIFIED',
        charOffsetStart,
        charOffsetEnd,
        matchedOriginalText: rawText.substring(charOffsetStart, charOffsetEnd),
      };
    }
  }

  return { status: 'NOT_FOUND', reason: 'OUTSIDE_SENT_CHUNKS' };
}

/**
 * Entity-mention sanity check (Amendment A7).
 *
 * Returns true if the quote contains at least one 4+ character whitespace-
 * delimited token of the normalized form of ANY provided entity name. Entity
 * names that produce no 4+ character token cannot be judged against, so the
 * function returns true in that case (it is a low bar by design).
 */
export function quoteMentionsAnyEntity(quoteText: string, entityNames: string[]): boolean {
  const normalizedQuote = normalize(quoteText).normalized;
  let sawCandidateToken = false;

  for (const name of entityNames) {
    const normalizedName = normalize(name).normalized;
    const tokens = normalizedName.split(/\s+/u);

    for (const token of tokens) {
      if (token.length < 4) continue;
      sawCandidateToken = true;
      if (normalizedQuote.includes(token)) return true;
    }
  }

  return !sawCandidateToken;
}
