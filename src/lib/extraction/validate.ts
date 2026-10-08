/**
 * Deterministic post-extraction validation pipeline (Amendment A7, invariant P3).
 *
 * Turns untrusted, schema-valid LLM proposals into verified graph edges. Every
 * rejection reason is explicit and recorded; nothing is silently dropped.
 *
 * Order of checks per proposed edge (first failure wins):
 *   1. Quote exists in the pinned source AND falls inside a sent chunk.
 *   2. The quote mentions the focal or the related entity (A7 sanity check).
 *   3. The related entity resolves to an identity (QID / page / generated).
 *   4. The related entity is not the focal entity.
 *   5. Chronology (using STORED dates when the entity already exists).
 * Plus a batch-level dedupe by (identity, relationType).
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { checkChronology } from '../dates/chronology';
import type { PartialDate } from '../dates/intervals';
import { nodes } from '../db/schema';
import type { Database } from '../graph/types';
import { normalize, normalizeString, type NormalizedText } from '../quote/normalize';
import {
  quoteMentionsAnyEntity,
  verifyQuote,
  type ChunkRange,
} from '../quote/verify';
import type { Resolver, ResolverResult } from '../wikipedia/qidResolver';
import type { Direction } from '../wikipedia/types';
import type { DateField, ExtractionOutput, ProposedEdge } from './schema';

type NodeRow = typeof nodes.$inferSelect;

/** A sent chunk, carrying its section title (structurally a `ChunkRange`). */
export interface SentChunkRange extends ChunkRange {
  sectionTitle: string;
}

export interface ValidationContext {
  focalNodeId: string;
  focalEntityName: string;
  focalEntityAliases?: string[];
  focalQid: string | null;
  /** Stored dates of the focal node (used for chronology). */
  focalDates: { start: PartialDate; end: PartialDate };
  direction: Direction;
  sourceDocumentId: string;
  sourceRawText: string;
  normalizedSource: NormalizedText;
  sentChunks: SentChunkRange[];
  resolver: Resolver;
  db: Database;
}

export interface AcceptedEdge {
  input: ProposedEdge;
  resolvedRelatedEntity: {
    qid: string | null;
    wikipediaPageId: number | null;
    nexusGeneratedId: string | null;
    identityScheme: 'WIKIDATA' | 'WIKIPEDIA_PAGE' | 'NEXUS_GENERATED';
    existingNodeId: string | null;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
    /** Full resolver result, retained for debugging / score auditing. */
    resolverResult: ResolverResult;
  };
  evidence: {
    quoteText: string;
    normalizedQuote: string;
    charOffsetStart: number;
    charOffsetEnd: number;
    sectionTitle: string | null;
  };
  chronologyStatus: 'VERIFIED' | 'UNVERIFIED';
}

export type RejectionReason =
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_OUTSIDE_SENT_CHUNKS'
  | 'QUOTE_IRRELEVANT'
  | 'CHRONOLOGY_VIOLATION'
  | 'RELATED_ENTITY_UNRESOLVABLE'
  | 'SELF_REFERENCE'
  | 'DUPLICATE_IN_BATCH'
  | 'SCHEMA_INVALID'
  // Late rejections surfaced by insertVerifiedEdge (M4) during persistence.
  | 'CYCLE_DETECTED'
  | 'SELF_EDGE'
  | 'NO_EVIDENCE'
  | 'IMPORTANCE_OUT_OF_RANGE';

export interface RejectedProposalRecord {
  input: ProposedEdge;
  reason: RejectionReason;
  detail: string;
}

export interface ValidationResult {
  accepted: AcceptedEdge[];
  rejected: RejectedProposalRecord[];
  sparsenessReason: string | null;
}

function dateFieldToPartial(field: DateField): PartialDate {
  return {
    year: field.year,
    month: field.month,
    day: field.day,
    precision: field.precision,
  };
}

/** Deterministic fallback identity for entities with no resolvable QID. */
export function nexusGeneratedIdFor(
  name: string,
  nodeType: string,
  startYear: number | null,
): string {
  const key = `${normalizeString(name)}|${nodeType}|${startYear ?? 'unknown'}`;
  return `nexus_${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

function identityKey(identity: {
  qid: string | null;
  wikipediaPageId: number | null;
  nexusGeneratedId: string | null;
}): string {
  if (identity.qid) return `qid:${identity.qid}`;
  if (identity.nexusGeneratedId) return `nid:${identity.nexusGeneratedId}`;
  if (identity.wikipediaPageId != null) return `page:${identity.wikipediaPageId}`;
  return 'unknown';
}

async function findExistingNode(
  db: Database,
  identity: {
    qid: string | null;
    wikipediaPageId: number | null;
    nexusGeneratedId: string | null;
  },
): Promise<NodeRow | undefined> {
  if (identity.qid) {
    const [row] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.wikidataQid, identity.qid))
      .limit(1);
    return row;
  }
  if (identity.nexusGeneratedId) {
    const [row] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.nexusGeneratedId, identity.nexusGeneratedId))
      .limit(1);
    return row;
  }
  if (identity.wikipediaPageId != null) {
    const [row] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.wikipediaPageId, identity.wikipediaPageId))
      .limit(1);
    return row;
  }
  return undefined;
}

function storedStartDate(row: NodeRow): PartialDate {
  return {
    year: row.dateStartYear,
    month: row.dateStartMonth,
    day: row.dateStartDay,
    precision: row.dateStartPrecision,
  };
}

function sectionForOffset(
  sentChunks: SentChunkRange[],
  start: number,
  end: number,
): string | null {
  for (const chunk of sentChunks) {
    if (start >= chunk.startOffset && end <= chunk.endOffset) {
      return chunk.sectionTitle;
    }
  }
  return null;
}

/**
 * Run the full post-extraction validation pipeline.
 *
 * The pipeline is deterministic given the inputs, except for QID resolution
 * (live Wikidata in production, fixture-backed in tests).
 */
export async function validateExtractionOutput(
  output: ExtractionOutput,
  context: ValidationContext,
): Promise<ValidationResult> {
  const accepted: AcceptedEdge[] = [];
  const rejected: RejectedProposalRecord[] = [];

  for (const edge of output.edges) {
    const related = edge.relatedEntity;

    // ── Step 1: quote verification (existence + chunk filter). ──
    const verification = verifyQuote(
      edge.evidence.verbatimQuote,
      context.normalizedSource,
      context.sentChunks,
    );

    if (verification.status !== 'VERIFIED') {
      const reason: RejectionReason =
        verification.reason === 'OUTSIDE_SENT_CHUNKS'
          ? 'QUOTE_OUTSIDE_SENT_CHUNKS'
          : 'QUOTE_NOT_FOUND';
      rejected.push({
        input: edge,
        reason,
        detail:
          `Quote for "${related.name}" was not verified: ${verification.reason}. ` +
          `Quote: "${edge.evidence.verbatimQuote.slice(0, 120)}"`,
      });
      continue;
    }

    // ── Step 2: entity-mention check (A7). ──
    const mentionTargets = [
      context.focalEntityName,
      related.name,
      ...(context.focalEntityAliases ?? []),
    ];
    if (!quoteMentionsAnyEntity(edge.evidence.verbatimQuote, mentionTargets)) {
      rejected.push({
        input: edge,
        reason: 'QUOTE_IRRELEVANT',
        detail: `Quote does not mention either endpoint entity ("${context.focalEntityName}" / "${related.name}").`,
      });
      continue;
    }

    // ── Step 3: resolve the related entity to a canonical identity. ──
    const resolverResult = await context.resolver.resolve(related.name, {
      entityType: related.entityType,
      description: related.disambiguationHint.description,
      approximateDateRange: related.disambiguationHint.approximateDateRange,
      ...(related.dateStart.year !== null
        ? { expectedYear: related.dateStart.year }
        : {}),
    });

    let qid: string | null = null;
    const wikipediaPageId: number | null = null;
    let nexusGeneratedId: string | null = null;
    let identityScheme: AcceptedEdge['resolvedRelatedEntity']['identityScheme'];

    if (
      resolverResult.qid &&
      (resolverResult.confidence === 'HIGH' || resolverResult.confidence === 'MEDIUM')
    ) {
      qid = resolverResult.qid;
      identityScheme = 'WIKIDATA';
    } else if (resolverResult.confidence === 'NONE') {
      rejected.push({
        input: edge,
        reason: 'RELATED_ENTITY_UNRESOLVABLE',
        detail: `Could not resolve "${related.name}" to a Wikidata entity.`,
      });
      continue;
    } else {
      // LOW confidence: MVP falls back to a deterministic generated id. A
      // resolver candidate page id is not available (the resolver works off
      // Wikidata), so WIKIPEDIA_PAGE is not reachable here.
      nexusGeneratedId = nexusGeneratedIdFor(
        related.name,
        related.entityType,
        related.dateStart.year,
      );
      identityScheme = 'NEXUS_GENERATED';
    }

    const identity = { qid, wikipediaPageId, nexusGeneratedId };

    // ── Step 4: self-reference. ──
    if (qid !== null && context.focalQid !== null && qid === context.focalQid) {
      rejected.push({
        input: edge,
        reason: 'SELF_REFERENCE',
        detail: `Related entity resolved to the focal entity's QID (${qid}).`,
      });
      continue;
    }

    // ── Step 5: dedupe against the existing graph + chronology. ──
    const existing = await findExistingNode(context.db, identity);
    if (existing && existing.id === context.focalNodeId) {
      rejected.push({
        input: edge,
        reason: 'SELF_REFERENCE',
        detail: 'Related entity resolved to the focal node.',
      });
      continue;
    }

    const relatedDate = existing
      ? storedStartDate(existing)
      : dateFieldToPartial(related.dateStart);

    const causeDate =
      context.direction === 'UPSTREAM' ? relatedDate : context.focalDates.start;
    const effectDate =
      context.direction === 'UPSTREAM' ? context.focalDates.start : relatedDate;

    const chronology = checkChronology(causeDate, effectDate);
    if (chronology.status === 'VIOLATION') {
      rejected.push({
        input: edge,
        reason: 'CHRONOLOGY_VIOLATION',
        detail: chronology.reason,
      });
      continue;
    }

    const actualSection = sectionForOffset(
      context.sentChunks,
      verification.charOffsetStart,
      verification.charOffsetEnd,
    );

    accepted.push({
      input: edge,
      resolvedRelatedEntity: {
        ...identity,
        identityScheme,
        existingNodeId: existing?.id ?? null,
        confidence: resolverResult.confidence,
        resolverResult,
      },
      evidence: {
        quoteText: verification.matchedOriginalText,
        normalizedQuote: normalize(verification.matchedOriginalText).normalized,
        charOffsetStart: verification.charOffsetStart,
        charOffsetEnd: verification.charOffsetEnd,
        sectionTitle: actualSection ?? (edge.evidence.sectionTitle || null),
      },
      chronologyStatus: chronology.status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
    });
  }

  // ── Batch-level dedupe: same (identity, relationType) keeps the most
  // important edge (lowest importanceRank; ties keep the first). ──
  const byKey = new Map<string, number>();
  const duplicateIndices = new Set<number>();
  for (let i = 0; i < accepted.length; i += 1) {
    const entry = accepted[i];
    if (!entry) continue;
    const key = `${identityKey(entry.resolvedRelatedEntity)}|${entry.input.relationType}`;
    const previous = byKey.get(key);
    if (previous === undefined) {
      byKey.set(key, i);
      continue;
    }
    const prior = accepted[previous];
    if (!prior) {
      byKey.set(key, i);
      continue;
    }
    // Lower numeric rank = more important.
    if (entry.input.importanceRank < prior.input.importanceRank) {
      duplicateIndices.add(previous);
      byKey.set(key, i);
    } else {
      duplicateIndices.add(i);
    }
  }

  const dedupedAccepted: AcceptedEdge[] = [];
  for (let i = 0; i < accepted.length; i += 1) {
    const entry = accepted[i];
    if (!entry) continue;
    if (duplicateIndices.has(i)) {
      rejected.push({
        input: entry.input,
        reason: 'DUPLICATE_IN_BATCH',
        detail: `Duplicate ${entry.input.relationType} edge for "${entry.input.relatedEntity.name}" in this batch; a more important proposal was kept.`,
      });
    } else {
      dedupedAccepted.push(entry);
    }
  }

  return {
    accepted: dedupedAccepted,
    rejected,
    sparsenessReason: output.metadata.sparsenessReason,
  };
}
