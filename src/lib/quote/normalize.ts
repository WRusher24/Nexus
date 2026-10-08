/**
 * Position-preserving quote normalization (Amendment A5).
 *
 * This module is the foundation of invariant P3: every production quote is
 * located against a `NormalizedText` built here, so a bug in this file would
 * corrupt the entire evidence chain. It contains no I/O and is fully
 * deterministic.
 *
 * NOTE ON OFFSETS: the task brief calls these "byte offsets", but every
 * consumer (EvidenceSpan.charOffsetStart, `String.prototype.substring`) treats
 * them as JavaScript UTF-16 code-unit indices. This module deliberately uses
 * UTF-16 code-unit indices as well so that `rawText.substring(start, end)` is
 * correct. A code unit is one JS string index; non-BMP characters occupy two.
 */

/** Maximum distance an opening `[` may be from its closing `]` to be treated
 * as a citation marker. Beyond this the `[` is literal text. */
const MAX_MARKER_LENGTH = 60;

/** Matches a single Unicode whitespace code point (space, tab, newline,
 * non-breaking space U+00A0, and the other Unicode `\\s` code points). */
const WHITESPACE_RE = /\s/u;

function isWhitespace(codePointChar: string): boolean {
  return WHITESPACE_RE.test(codePointChar);
}

// ── Hangul jamo composition helpers (NFC composes jamo pairs) ────────────────

function isHangulL(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c);
}
function isHangulV(cp: number): boolean {
  return (cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6);
}
function isHangulT(cp: number): boolean {
  return (cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb);
}
function isHangulSyllable(cp: number): boolean {
  return cp >= 0xac00 && cp <= 0xd7a3;
}
/** True for precomposed Hangul syllables with no trailing consonant (LV). */
function isHangulLV(cp: number): boolean {
  return isHangulSyllable(cp) && (cp - 0xac00) % 28 === 0;
}

/**
 * True when `cp` forms one canonical composition cluster with the preceding
 * code point `prevCp`.
 *
 * Grouping these code points before calling `String.prototype.normalize('NFC')`
 * is what lets a base + combining mark (e.g. `e` + U+0301) compose into a
 * single `é`. Calling NFC on each UTF-16 code unit in isolation would not
 * compose across code-point boundaries.
 */
function isClusterExtender(cp: number, prevCp: number): boolean {
  const ch = String.fromCodePoint(cp);
  // Unicode combining marks (Mn, Mc, Me).
  if (/\p{M}/u.test(ch)) return true;
  // Hangul jamo composition: L+V, V+T, LV+T.
  if (isHangulL(prevCp) && isHangulV(cp)) return true;
  if (isHangulV(prevCp) && isHangulT(cp)) return true;
  if (isHangulLV(prevCp) && isHangulT(cp)) return true;
  return false;
}

/**
 * If `rawText[start]` begins one of the citation markers this module strips,
 * return the index just past its closing `]`. Otherwise return -1 (including
 * the "no closing bracket within 60 characters" case, which keeps the `[` as
 * literal text).
 */
function matchCitationMarker(rawText: string, start: number): number {
  const close = rawText.indexOf(']', start + 1);
  if (close === -1 || close > start + MAX_MARKER_LENGTH) return -1;

  const content = rawText.slice(start + 1, close);
  const lower = content.toLowerCase();

  if (/^\d+$/.test(content)) return close + 1; // [1], [42]
  if (/^citation\s+needed$/.test(lower)) return close + 1; // [citation needed]
  if (/^clarification\s+needed$/.test(lower)) return close + 1; // [clarification needed]
  if (lower.startsWith('dubious')) return close + 1; // [dubious – discuss]
  if (lower === 'which?') return close + 1; // [which?]

  return -1;
}

/**
 * Represents a normalized version of a source text alongside an index map
 * that records, for each character position in the normalized string, the
 * UTF-16 code-unit offset in the original rawText that produced it.
 */
export interface NormalizedText {
  /** The normalized text: lowercased, whitespace-collapsed, markers stripped, NFC. */
  normalized: string;
  /**
   * toOriginal[i] = the offset in rawText that produced normalized[i].
   * For characters that expand under NFC or lowercasing (rare), the mapping
   * points to the first code unit of the source character. For collapsed
   * whitespace runs, the mapping points to the first whitespace character of
   * the run.
   */
  toOriginal: Int32Array;
  /**
   * The original, un-normalized text this map refers to.
   *
   * API DECISION: the brief's `NormalizedText` interface listed only
   * `normalized` and `toOriginal`, but `verifyQuote` must return
   * `matchedOriginalText` (a slice of the original rawText) and the specified
   * `verifyQuote(quoteText, normalizedSource, sentChunks)` signature has no
   * rawText parameter. Carrying rawText on the value produced by `normalize()`
   * keeps `verifyQuote`'s signature exactly as specified; the index map is
   * meaningless without the text it indexes anyway.
   */
  rawText: string;
}

/**
 * Build a NormalizedText from a raw source string, in a single left-to-right
 * pass. Normalization rules (per source character):
 *   1. Skip citation markers ([N], [citation needed], [clarification needed],
 *      [dubious ...], [which?]).
 *   2. Apply Unicode NFC normalization.
 *   3. Collapse any Unicode whitespace run to a single ASCII space.
 *   4. Lowercase using String.prototype.toLowerCase().
 *   5. Trim leading/trailing whitespace from the final result.
 */
export function normalize(rawText: string): NormalizedText {
  const out: string[] = [];
  const offsets: number[] = [];
  // Offset of the first whitespace character in the current pending run, or -1.
  let pendingWhitespaceOffset = -1;

  const length = rawText.length;
  let i = 0;

  while (i < length) {
    // ── Rule 1: citation markers ───────────────────────────────────────────
    if (rawText[i] === '[') {
      const markerEnd = matchCitationMarker(rawText, i);
      if (markerEnd !== -1) {
        // Skip the whole marker; do NOT reset pendingWhitespaceOffset so that
        // whitespace on either side of a removed marker collapses together.
        i = markerEnd;
        continue;
      }
    }

    // ── Rule 2: gather one canonical composition cluster, then NFC it ──────
    const clusterStart = i;
    let cluster = '';
    let prevCp = -1;
    while (i < length) {
      const cp = rawText.codePointAt(i);
      if (cp === undefined) break;
      if (cluster.length > 0 && !isClusterExtender(cp, prevCp)) break;
      const ch = String.fromCodePoint(cp);
      cluster += ch;
      prevCp = cp;
      i += ch.length;
    }

    const composed = cluster.normalize('NFC');

    // ── Rules 3 & 4: whitespace collapse + lowercase ───────────────────────
    for (const sourceChar of composed) {
      if (isWhitespace(sourceChar)) {
        if (pendingWhitespaceOffset === -1) {
          pendingWhitespaceOffset = clusterStart;
        }
        continue;
      }

      if (pendingWhitespaceOffset !== -1 && out.length > 0) {
        out.push(' ');
        offsets.push(pendingWhitespaceOffset);
      }
      pendingWhitespaceOffset = -1;

      const lowered = sourceChar.toLowerCase();
      for (let k = 0; k < lowered.length; k++) {
        const unit = lowered[k];
        if (unit === undefined) continue;
        out.push(unit);
        offsets.push(clusterStart);
      }
    }
  }

  // Rule 5: any still-pending trailing whitespace is dropped (trimmed).
  return {
    normalized: out.join(''),
    toOriginal: Int32Array.from(offsets),
    rawText,
  };
}

/**
 * Convenience: just the normalized string, no map. Use only when you do not
 * need to map positions back (e.g., comparing two quotes to each other).
 */
export function normalizeString(text: string): string {
  return normalize(text).normalized;
}
