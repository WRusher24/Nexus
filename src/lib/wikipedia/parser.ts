/**
 * Wikipedia plain-text parsing (Milestone 5).
 *
 * Converts the raw TextExtracts `extract` string (requested with
 * `explaintext=1&exsectionformat=plain`) into clean, offset-addressable text
 * plus a section index. Offsets are UTF-16 code-unit indices, matching
 * SourceDocument.sectionIndex and EvidenceSpan offsets used elsewhere.
 *
 * The authoritative list of section titles comes from a separate
 * `action=parse&prop=sections` request (see `wikipediaClient.ts`), because
 * `exsectionformat=plain` emits headings as bare lines with no structural
 * markers.
 *
 * Pure functions; no I/O.
 */

import { createHash } from 'node:crypto';
import type { SectionInfo } from './types';

export interface ParsedArticle {
  plainText: string;
  sections: SectionInfo[];
}

/**
 * Compute SHA-256 of a string, returned as a lowercase hex string. Uses
 * Node's built-in crypto module (no new dependency).
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Locate `title` as a standalone line at or after `from`. A standalone line is
 * preceded by the start of the string or `\n`, and followed by `\n` or the end
 * of the string. Case-sensitive.
 */
function findStandaloneLine(text: string, title: string, from: number): number {
  let index = text.indexOf(title, from);
  while (index !== -1) {
    const beforeOk = index === 0 || text[index - 1] === '\n';
    const afterIndex = index + title.length;
    const afterOk = afterIndex === text.length || text[afterIndex] === '\n';
    if (beforeOk && afterOk) return index;
    index = text.indexOf(title, index + 1);
  }
  return -1;
}

/**
 * Parse a plain-text extract into cleaned text and a section index.
 *
 * Normalisation order:
 *   1. Line endings normalised to `\n`.
 *   2. Runs of 3+ newlines collapsed to 2 (paragraph breaks preserved).
 *   3. Leading/trailing whitespace trimmed.
 *
 * Then each provided title is located as a standalone line (in order, after
 * the previous match so repeated headings are handled deterministically).
 * Titles that are not found are skipped (Wikipedia sometimes omits empty
 * sections). The lead section is always first with `title = ''` and
 * `startOffset = 0`. When no titles are found the whole document is returned
 * as a single lead section.
 */
export function parseArticleText(
  rawExtract: string,
  sectionTitles: string[] = [],
): ParsedArticle {
  let text = rawExtract.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  const found: Array<{ title: string; start: number }> = [];
  let searchFrom = 0;
  for (const title of sectionTitles) {
    if (title.trim() === '') continue;
    const start = findStandaloneLine(text, title, searchFrom);
    if (start === -1) continue;
    found.push({ title, start });
    searchFrom = start + title.length;
  }

  if (found.length === 0) {
    return {
      plainText: text,
      sections: [{ title: '', startOffset: 0, endOffset: text.length }],
    };
  }

  const first = found[0];
  const sections: SectionInfo[] = [
    { title: '', startOffset: 0, endOffset: first ? first.start : text.length },
  ];

  for (let i = 0; i < found.length; i += 1) {
    const current = found[i];
    if (!current) continue;
    const next = found[i + 1];
    sections.push({
      title: current.title,
      startOffset: current.start,
      endOffset: next ? next.start : text.length,
    });
  }

  return { plainText: text, sections };
}
