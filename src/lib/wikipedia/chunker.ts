/**
 * Section-aware article chunking (pure function; no I/O).
 *
 * Selects the most causally relevant sections of an article for a given
 * extraction direction and packs them under a character budget, preserving
 * exact rawText offsets so that downstream quote verification works against
 * the exact text that was sent to the LLM.
 */

import type { Chunk, Direction, SectionInfo } from './types';

export interface ChunkingOptions {
  /**
   * Maximum total characters across all NON-LEAD chunks. Default: 12000
   * (approximately 3000 tokens, leaving room for prompt and output). The lead
   * section is exempt from this budget.
   */
  maxTotalChars?: number;
  /**
   * Section titles (case-insensitive, substring match) that are ALWAYS
   * excluded regardless of priority. Default: references, external links,
   * see also, notes, further reading, bibliography.
   */
  excludeSections?: string[];
}

const DEFAULT_MAX_TOTAL_CHARS = 12000;

const DEFAULT_EXCLUDE_SECTIONS = [
  'references',
  'external links',
  'see also',
  'notes',
  'further reading',
  'bibliography',
];

const UPSTREAM_KEYWORDS = [
  'background',
  'causes',
  'origins',
  'context',
  'prelude',
  'lead-up',
  'lead up',
  'factors',
  'preconditions',
  'antecedents',
];

const DOWNSTREAM_KEYWORDS = [
  'aftermath',
  'consequences',
  'effects',
  'impact',
  'legacy',
  'results',
  'outcome',
  'significance',
  'influence',
];

function isLeadTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === '' || normalized === 'lead' || normalized === 'introduction';
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Priority for a section, or `null` when the section must be excluded.
 * Priority order (checked in this order):
 *   - excluded sections            -> null (filtered out entirely)
 *   - lead / '' / introduction     -> 1
 *   - direction-relevant keywords  -> 10
 *   - "history" or "overview"      -> 20
 *   - everything else              -> 50
 */
function sectionPriority(
  title: string,
  direction: Direction,
  excludeSections: string[],
): number | null {
  const lower = title.toLowerCase();

  if (containsAny(lower, excludeSections)) return null;
  if (isLeadTitle(title)) return 1;

  const keywords = direction === 'UPSTREAM' ? UPSTREAM_KEYWORDS : DOWNSTREAM_KEYWORDS;
  if (containsAny(lower, keywords)) return 10;

  if (lower.includes('history') || lower.includes('overview')) return 20;

  return 50;
}

function toChunk(rawText: string, section: SectionInfo, priority: number): Chunk {
  return {
    sectionTitle: section.title,
    text: rawText.substring(section.startOffset, section.endOffset),
    startOffset: section.startOffset,
    endOffset: section.endOffset,
    priority,
  };
}

/**
 * Chunk an article into priority-ordered sections for extraction.
 *
 * Selection: sort by (priority asc, startOffset asc), then greedily include
 * sections while the running total of non-lead characters stays at or under
 * `maxTotalChars`. The lead section is always included and does not count
 * toward the budget.
 *
 * Pure function. No I/O.
 */
export function chunkArticle(
  rawText: string,
  sections: SectionInfo[],
  direction: Direction,
  options?: ChunkingOptions,
): Chunk[] {
  if (sections.length === 0) return [];

  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const excludeSections = options?.excludeSections ?? DEFAULT_EXCLUDE_SECTIONS;

  type Prioritized = { section: SectionInfo; priority: number };
  const prioritized: Prioritized[] = [];
  for (const section of sections) {
    const priority = sectionPriority(section.title, direction, excludeSections);
    if (priority === null) continue;
    prioritized.push({ section, priority });
  }

  prioritized.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.section.startOffset - b.section.startOffset;
  });

  const chunks: Chunk[] = [];
  let nonLeadChars = 0;

  for (const { section, priority } of prioritized) {
    const length = section.endOffset - section.startOffset;

    if (priority === 1) {
      // Lead: always included regardless of budget.
      chunks.push(toChunk(rawText, section, priority));
      continue;
    }

    if (nonLeadChars + length <= maxTotalChars) {
      chunks.push(toChunk(rawText, section, priority));
      nonLeadChars += length;
    }
  }

  return chunks;
}
