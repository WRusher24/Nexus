/**
 * Root node creation (Milestone 5).
 *
 * The entry point for a new graph: given a user-selected disambiguation
 * candidate, fetch and cache the revision-pinned SourceDocument, resolve the
 * canonical identity (QID when confident, otherwise Wikipedia page id), infer
 * the node type and dates from Wikidata, and upsert the node.
 *
 * This is the ONLY code path that creates a node with `isRoot = true`.
 * Nodes discovered later through expansion (M7) are created with the
 * `upsertNode` default (`isRoot = false`).
 */

import { eq } from 'drizzle-orm';
import { nodes } from '../db/schema';
import type { DatePrecision } from '../dates/intervals';
import type { DisambiguationCandidate } from '../wikipedia/search';
import {
  mapInstanceOfToNodeType,
} from '../wikipedia/qidResolver';
import {
  parseWikidataTime,
  type WikidataClient,
  type WikidataEntity,
  type WikidataTimeValue,
} from '../wikipedia/wikidataClient';
import type { SourceDocumentService } from '../wikipedia/sourceDocuments';
import type { Database, NodeType, UpsertNodeInput } from './types';
import { upsertNode } from './upsertNode';

export interface CreateRootNodeInput {
  candidate: DisambiguationCandidate;
  nodeType?: NodeType;
}

export interface CreateRootNodeResult {
  nodeId: string;
  sourceDocumentId: string;
  qid: string | null;
  outcome: 'CREATED' | 'EXISTING';
}

/** Map a Wikidata precision code to our `DatePrecision` enum. */
function mapWikidataPrecision(precision: number): DatePrecision {
  switch (precision) {
    case 11:
      return 'DAY';
    case 10:
      return 'MONTH';
    case 9:
      return 'YEAR';
    case 8:
      return 'DECADE';
    case 7:
      return 'CENTURY';
    case 6:
      return 'MILLENNIUM';
    default:
      return 'UNKNOWN';
  }
}

interface DateColumns {
  year: number | null;
  month: number | null;
  day: number | null;
  precision: DatePrecision;
}

/**
 * Convert one Wikidata time claim into the four columns that make up a start
 * or end date. Respects precision: month/day are dropped when the claim is
 * coarser than the month. Degrades gracefully when the value is incomplete.
 */
function toDateColumns(value: WikidataTimeValue): DateColumns {
  const parsed = parseWikidataTime(value.time);
  if (parsed.year === null) {
    return { year: null, month: null, day: null, precision: 'UNKNOWN' };
  }

  let precision = mapWikidataPrecision(value.precision);
  let { month, day } = parsed;

  if (precision === 'UNKNOWN') {
    precision = 'YEAR';
  }
  if (precision === 'DAY' && (month === null || day === null)) {
    precision = month !== null ? 'MONTH' : 'YEAR';
    day = null;
  }
  if (precision === 'MONTH' && month === null) {
    precision = 'YEAR';
  }
  if (
    precision === 'YEAR' ||
    precision === 'DECADE' ||
    precision === 'CENTURY' ||
    precision === 'MILLENNIUM'
  ) {
    month = null;
    day = null;
  }

  return { year: parsed.year, month, day, precision };
}

/**
 * Extract node date columns from a Wikidata entity. Start date priority is
 * P585 (point in time) → P580 (start time) → P571 (inception); end date is
 * P582 (end time).
 */
export function extractEntitiesDates(
  entity: WikidataEntity,
): Partial<UpsertNodeInput> {
  const start =
    entity.claims.P585?.[0] ??
    entity.claims.P580?.[0] ??
    entity.claims.P571?.[0];
  const end = entity.claims.P582?.[0];

  const result: Partial<UpsertNodeInput> = {};

  if (start) {
    const columns = toDateColumns(start);
    result.dateStartYear = columns.year;
    result.dateStartMonth = columns.month;
    result.dateStartDay = columns.day;
    result.dateStartPrecision = columns.precision;
  }

  if (end) {
    const columns = toDateColumns(end);
    result.dateEndYear = columns.year;
    result.dateEndMonth = columns.month;
    result.dateEndDay = columns.day;
    result.dateEndPrecision = columns.precision;
  }

  return result;
}

/**
 * Create (or promote) a root node from a disambiguation candidate.
 *
 * The source document is always ensured first, so the node always has a
 * pinned source even when the node itself already existed.
 */
export async function createRootNode(
  db: Database,
  sourceDocuments: SourceDocumentService,
  wikidata: WikidataClient,
  input: CreateRootNodeInput,
): Promise<CreateRootNodeResult> {
  const { candidate } = input;

  // 1. Always ensure a pinned SourceDocument exists.
  const sourceDocument = await sourceDocuments.fetchAndStore(candidate.pageId);

  // 2. Canonical identity: a HIGH/MEDIUM QID wins; otherwise the page id.
  const useQid =
    candidate.resolvedQid !== null &&
    (candidate.qidConfidence === 'HIGH' || candidate.qidConfidence === 'MEDIUM');
  const qid = useQid ? candidate.resolvedQid : null;

  // 3. Fetch the Wikidata entity (best effort) for type/date inference.
  let entity: WikidataEntity | null = null;
  if (qid) {
    try {
      entity = await wikidata.getEntity(qid);
    } catch {
      entity = null;
    }
  }

  const inferredType = entity ? mapInstanceOfToNodeType(entity.instanceOf) : null;
  const nodeType: NodeType = input.nodeType ?? inferredType ?? 'EVENT';

  const label =
    entity?.label && entity.label.trim() !== '' ? entity.label : candidate.title;
  const brief = entity?.description ?? undefined;

  const upsertInput: UpsertNodeInput = {
    identity: qid ? { wikidataQid: qid } : { wikipediaPageId: candidate.pageId },
    label,
    nodeType,
    isRoot: true,
    ...(brief !== undefined ? { brief } : {}),
    ...(entity ? extractEntitiesDates(entity) : {}),
  };

  const result = await upsertNode(db, upsertInput);

  // 4. Promote an existing non-root node (previously discovered by expansion).
  const outcome: 'CREATED' | 'EXISTING' = result.outcome;
  if (result.outcome === 'EXISTING') {
    const [row] = await db
      .select({ isRoot: nodes.isRoot })
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    if (row && !row.isRoot) {
      await db
        .update(nodes)
        .set({ isRoot: true, updatedAt: new Date() })
        .where(eq(nodes.id, result.nodeId));
    }
  }

  return {
    nodeId: result.nodeId,
    sourceDocumentId: sourceDocument.id,
    qid,
    outcome,
  };
}
