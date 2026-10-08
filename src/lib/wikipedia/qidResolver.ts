/**
 * QID resolver (Milestone 5).
 *
 * Resolves an entity name (+ optional context hints) to a Wikidata QID with a
 * confidence score. The score is a sum of four 0-25 components:
 * name match, type match, date match, description match.
 *
 * The P31 ("instance of") QID mappings below are intentionally conservative
 * and opinion-based; the scorer tolerates imperfect mappings through neutral
 * fallbacks. They are expected to be tuned over time.
 */

import type { EntityType, ResolverConfidence } from './types';
import {
  parseWikidataYear,
  type WikidataClient,
  type WikidataEntity,
  type WikidataSearchResult,
} from './wikidataClient';

// ─────────────────────────────────────────────────────────────────────────────
// Entity type → expected P31 QIDs
//
// Verified against live Wikidata labels/descriptions at implementation time:
//   Q5 human, Q215627 person, Q16334295 group of humans,
//   Q3024240 historical country, Q43229 organization, Q4830453 business,
//   Q327333 government agency, Q17149090 armed organization,
//   Q1190554 occurrence, Q1656682 planned event, Q178561 battle, Q198 war,
//   Q273120 protest, Q131569 treaty, Q625298 peace treaty,
//   Q13418847 historical event, Q1150070 change, Q3249551 process,
//   Q40231 public election, Q7748 law, Q49371 legislation,
//   Q7257 ideology, Q179805 political philosophy, Q49773 social movement,
//   Q17334923 physical location, Q486972 human settlement, Q82794 region,
//   Q3624078 sovereign state, Q6256 country, Q11016 technology,
//   Q39546 physical tool, Q11862829 academic discipline.
// ─────────────────────────────────────────────────────────────────────────────

export const ENTITY_TYPE_TO_P31: Record<EntityType, readonly string[]> = {
  EVENT: [
    'Q1190554', // occurrence
    'Q1656682', // planned event
    'Q178561', // battle
    'Q198', // war
    'Q273120', // protest
    'Q13418847', // historical event
  ],
  ACTOR: [
    'Q5', // human
    'Q215627', // person
    'Q16334295', // group of humans
    'Q3024240', // historical country
    'Q43229', // organization
  ],
  POLICY: [
    'Q7748', // law
    'Q49371', // legislation
    'Q131569', // treaty
    'Q625298', // peace treaty
  ],
  PROCESS: [
    'Q1150070', // change
    'Q3249551', // process
    'Q1190554', // occurrence
    'Q40231', // public election
  ],
  INSTITUTION: [
    'Q43229', // organization
    'Q16334295', // group of humans
    'Q4830453', // business
    'Q327333', // government agency
    'Q17149090', // armed organization
  ],
  IDEOLOGY: [
    'Q7257', // ideology
    'Q179805', // political philosophy
    'Q49773', // social movement
  ],
  PLACE: [
    'Q17334923', // physical location
    'Q486972', // human settlement
    'Q82794', // region
    'Q3624078', // sovereign state
    'Q6256', // country
  ],
  TECHNOLOGY: [
    'Q11016', // technology
    'Q39546', // physical tool
    'Q11862829', // academic discipline
  ],
};

const ENTITY_TYPE_ORDER: EntityType[] = [
  'EVENT',
  'PROCESS',
  'POLICY',
  'ACTOR',
  'IDEOLOGY',
  'INSTITUTION',
  'TECHNOLOGY',
  'PLACE',
];

/**
 * Map a list of `instanceOf` (P31) QIDs to a coarse node type. Returns null
 * when nothing matches. Deterministic: fixed type order, first match wins.
 */
export function mapInstanceOfToNodeType(
  instanceOf: readonly string[],
): EntityType | null {
  for (const type of ENTITY_TYPE_ORDER) {
    const expected = ENTITY_TYPE_TO_P31[type];
    if (instanceOf.some((qid) => expected.includes(qid))) {
      return type;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver types
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolverHint {
  entityType?: EntityType;
  description?: string;
  approximateDateRange?: string;
  expectedYear?: number;
}

export interface ResolverResult {
  qid: string | null;
  wikipediaTitle: string | null;
  confidence: ResolverConfidence;
  score: number;
  scoreBreakdown: {
    nameMatch: number;
    typeMatch: number;
    dateMatch: number;
    descriptionMatch: number;
  };
  candidates: Array<{
    qid: string;
    label: string;
    description: string | null;
    score: number;
  }>;
}

export interface Resolver {
  resolve(entityName: string, hint?: ResolverHint): Promise<ResolverResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with',
]);

function wordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));
  return new Set(words);
}

function nameMatchScore(
  entity: WikidataEntity,
  searchResult: WikidataSearchResult,
  entityName: string,
): number {
  const name = entityName.trim();
  const lowerName = name.toLowerCase();
  const label = entity.label.toLowerCase();

  if (label === lowerName && label !== '') return 25;

  const aliases = entity.aliases.map((alias) => alias.toLowerCase());
  if (aliases.includes(lowerName)) return 20;

  if (label !== '' && name !== '') {
    const longer = Math.max(label.length, lowerName.length);
    const shorter = Math.min(label.length, lowerName.length);
    const ratio = longer === 0 ? 0 : shorter / longer;
    if ((label.includes(lowerName) || lowerName.includes(label)) && ratio >= 0.6) {
      return 15;
    }
  }

  if (searchResult.match.text.toLowerCase() === lowerName) return 10;

  const labelWords = wordSet(entity.label);
  const nameWords = wordSet(name);
  if (nameWords.size > 0) {
    let overlap = 0;
    for (const word of nameWords) {
      if (labelWords.has(word)) overlap += 1;
    }
    if (overlap / nameWords.size >= 0.5) return 5;
  }

  return 0;
}

function typeMatchScore(entity: WikidataEntity, hint: ResolverHint | undefined): number {
  const entityType = hint?.entityType;
  if (!entityType) return 10;
  if (entity.instanceOf.length === 0) return 5;

  const expected = ENTITY_TYPE_TO_P31[entityType];
  if (entity.instanceOf.some((qid) => expected.includes(qid))) return 25;
  return 15;
}

function dateMatchScore(entity: WikidataEntity, hint: ResolverHint | undefined): number {
  const expectedYear = hint?.expectedYear;
  if (expectedYear === undefined) return 10;

  const claims = entity.claims;
  const timeValues = [
    ...(claims.P585 ?? []),
    ...(claims.P580 ?? []),
    ...(claims.P571 ?? []),
    ...(claims.P582 ?? []),
  ];
  const years = timeValues
    .map((value) => parseWikidataYear(value.time))
    .filter((year): year is number => year !== null);

  if (years.length === 0) return 10;

  let bestDistance = Number.POSITIVE_INFINITY;
  for (const year of years) {
    bestDistance = Math.min(bestDistance, Math.abs(year - expectedYear));
  }

  if (bestDistance === 0) return 25;
  if (bestDistance <= 10) return 20;
  if (bestDistance <= 50) return 10;
  if (bestDistance <= 200) return 5;
  return 0;
}

function descriptionMatchScore(
  entity: WikidataEntity,
  hint: ResolverHint | undefined,
): number {
  if (!hint?.description || !entity.description) return 10;

  const hintWords = wordSet(hint.description);
  const entityWords = wordSet(entity.description);
  if (hintWords.size === 0 || entityWords.size === 0) return 10;

  let intersection = 0;
  for (const word of hintWords) {
    if (entityWords.has(word)) intersection += 1;
  }
  const union = new Set([...hintWords, ...entityWords]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  return Math.min(25, Math.round(25 * jaccard * 2));
}

interface ScoredCandidate {
  qid: string;
  label: string;
  description: string | null;
  score: number;
  breakdown: ResolverResult['scoreBreakdown'];
  wikipediaTitle: string | null;
}

function confidenceForScore(score: number): ResolverConfidence {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  if (score >= 20) return 'LOW';
  return 'NONE';
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────

export function createResolver(wikidata: WikidataClient): Resolver {
  async function resolve(
    entityName: string,
    hint?: ResolverHint,
  ): Promise<ResolverResult> {
    const empty: ResolverResult = {
      qid: null,
      wikipediaTitle: null,
      confidence: 'NONE',
      score: 0,
      scoreBreakdown: { nameMatch: 0, typeMatch: 0, dateMatch: 0, descriptionMatch: 0 },
      candidates: [],
    };

    const results = await wikidata.search(entityName, 5);
    if (results.length === 0) return empty;

    const scored: ScoredCandidate[] = [];
    for (const result of results) {
      let entity: WikidataEntity;
      try {
        entity = await wikidata.getEntity(result.qid);
      } catch {
        continue;
      }
      const breakdown = {
        nameMatch: nameMatchScore(entity, result, entityName),
        typeMatch: typeMatchScore(entity, hint),
        dateMatch: dateMatchScore(entity, hint),
        descriptionMatch: descriptionMatchScore(entity, hint),
      };
      const score =
        breakdown.nameMatch +
        breakdown.typeMatch +
        breakdown.dateMatch +
        breakdown.descriptionMatch;
      scored.push({
        qid: entity.qid,
        label: entity.label || result.label,
        description: entity.description,
        score,
        breakdown,
        wikipediaTitle: entity.wikipediaTitle,
      });
    }

    if (scored.length === 0) return empty;

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0;
    });

    const top = scored[0];
    if (!top) return empty;

    const confidence = confidenceForScore(top.score);
    return {
      qid: confidence === 'NONE' ? null : top.qid,
      wikipediaTitle: confidence === 'NONE' ? null : top.wikipediaTitle,
      confidence,
      score: top.score,
      scoreBreakdown: top.breakdown,
      candidates: scored.slice(0, 5).map((candidate) => ({
        qid: candidate.qid,
        label: candidate.label,
        description: candidate.description,
        score: candidate.score,
      })),
    };
  }

  return { resolve };
}
