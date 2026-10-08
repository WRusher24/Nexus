/**
 * The one and only edge write path (invariants P1-P3).
 *
 * AGENTS.md forbids `db.insert(edges)` anywhere else; the custom ESLint rule
 * enforces that. Everything an edge needs - the cycle check, the chronology
 * check, the partial-unique ON CONFLICT, and the evidence spans - happens
 * inside a single SERIALIZABLE transaction here.
 *
 * The caller is responsible for having ALREADY verified every quote. This
 * function does not call `verifyQuote`; it records evidence the caller has
 * proven and lets the deferred trigger confirm the P3 invariant at COMMIT.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { checkChronology } from '../dates/chronology';
import type { PartialDate } from '../dates/intervals';
import { edges, evidenceSpans, nodes } from '../db/schema';
import { checkForCycle } from './cycleCheck';
import type {
  BatchEdgeResult,
  Database,
  DbClient,
  EdgeInsertInput,
  EdgeInsertResult,
  Transaction,
} from './types';

const MIN_IMPORTANCE_RANK = 1;
const MAX_IMPORTANCE_RANK = 10;
const MAX_SERIALIZABLE_RETRIES = 3;

/** PostgreSQL SQLSTATE codes worth retrying. */
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

/**
 * Insert a single verified edge with its evidence spans, enforcing P1-P3.
 *
 * Cheap input validation happens BEFORE a serializable transaction is opened;
 * rejected inputs never contend for locks. Accepted inputs run the cycle and
 * chronology checks and the edge/evidence inserts in one SERIALIZABLE
 * transaction, retried on serialization failure.
 *
 * @param db - Drizzle database handle (this function opens its own transaction)
 */
export async function insertVerifiedEdge(
  db: Database,
  input: EdgeInsertInput,
): Promise<EdgeInsertResult> {
  // ── Step 1: validate without touching the database. ──
  if (input.causeNodeId === input.effectNodeId) {
    return {
      outcome: 'REJECTED',
      reason: 'SELF_EDGE',
      detail: 'causeNodeId and effectNodeId are the same node',
    };
  }

  if (
    !Number.isInteger(input.importanceRank) ||
    input.importanceRank < MIN_IMPORTANCE_RANK ||
    input.importanceRank > MAX_IMPORTANCE_RANK
  ) {
    return {
      outcome: 'REJECTED',
      reason: 'IMPORTANCE_OUT_OF_RANGE',
      detail: `importanceRank must be an integer in [${MIN_IMPORTANCE_RANK}, ${MAX_IMPORTANCE_RANK}], got ${input.importanceRank}`,
    };
  }

  if (input.evidence.length === 0) {
    return {
      outcome: 'REJECTED',
      reason: 'NO_EVIDENCE',
      detail: 'at least one evidence span is required (P3)',
    };
  }

  // ── Steps 2-6: cycle check + chronology + insert, atomically. ──
  return withSerializableRetry(db, async (tx) => {
    const cycle = await checkForCycle(tx, input.causeNodeId, input.effectNodeId);
    if (cycle.wouldCreateCycle) {
      return {
        outcome: 'REJECTED',
        reason: 'CYCLE_DETECTED',
        detail: cycle.cyclePath
          ? `edge would create a cycle: ${cycle.cyclePath.join(' -> ')}`
          : 'edge would create a cycle',
      };
    }

    const chronology = await checkChronologyFromStoredDates(
      tx,
      input.causeNodeId,
      input.effectNodeId,
    );
    if (chronology.status === 'VIOLATION') {
      return {
        outcome: 'REJECTED',
        reason: 'CHRONOLOGY_VIOLATION',
        detail: chronology.reason,
      };
    }
    const chronologyStatus: 'VERIFIED' | 'UNVERIFIED' =
      chronology.status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';

    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO "edges"
        ("causeNodeId", "effectNodeId", "relationType", "status",
         "chronologyStatus", "importanceRank", "contested", "firstExtractionRunId")
      VALUES (
        ${input.causeNodeId}::uuid,
        ${input.effectNodeId}::uuid,
        ${input.relationType}::relation_type,
        'ACTIVE',
        ${chronologyStatus}::chronology_status,
        ${input.importanceRank},
        ${input.contested},
        ${input.extractionRunId}::uuid
      )
      ON CONFLICT ("causeNodeId", "effectNodeId", "relationType")
        WHERE "status" = 'ACTIVE'
      DO NOTHING
      RETURNING "id"
    `);

    const createdEdgeId = inserted.rows[0]?.id;

    if (createdEdgeId) {
      await insertEvidenceSpans(tx, createdEdgeId, input);
      return {
        outcome: 'CREATED',
        edgeId: createdEdgeId,
        evidenceCount: input.evidence.length,
      };
    }

    // ON CONFLICT DO NOTHING: an ACTIVE edge already exists for this triple.
    // Attach the new evidence to it (Amendment A2 semantics).
    const [existingEdge] = await tx
      .select({ id: edges.id })
      .from(edges)
      .where(
        and(
          eq(edges.causeNodeId, input.causeNodeId),
          eq(edges.effectNodeId, input.effectNodeId),
          eq(edges.relationType, input.relationType),
          eq(edges.status, 'ACTIVE'),
        ),
      );

    if (!existingEdge) {
      throw new Error(
        'insertVerifiedEdge: ON CONFLICT skipped the insert but no ACTIVE edge was found',
      );
    }

    await insertEvidenceSpans(tx, existingEdge.id, input);
    return {
      outcome: 'EXISTING',
      edgeId: existingEdge.id,
      newEvidenceCount: input.evidence.length,
    };
  });
}

/**
 * Insert a batch of edges from a single extraction run.
 *
 * Inputs are sorted by `causeNodeId + effectNodeId` (lexicographic) so that
 * concurrent batches acquire locks in a consistent order and cannot deadlock.
 * Each edge gets its own transaction: one rejected proposal must not roll back
 * its siblings.
 *
 * @param db - Drizzle database handle
 */
export async function insertVerifiedEdgeBatch(
  db: Database,
  inputs: EdgeInsertInput[],
): Promise<BatchEdgeResult> {
  const ordered = [...inputs].sort((a, b) => {
    const keyA = `${a.causeNodeId}${a.effectNodeId}`;
    const keyB = `${b.causeNodeId}${b.effectNodeId}`;
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  const accepted: BatchEdgeResult['accepted'] = [];
  const rejected: BatchEdgeResult['rejected'] = [];

  for (const input of ordered) {
    const result = await insertVerifiedEdge(db, input);
    if (result.outcome === 'REJECTED') {
      rejected.push({ input, result });
    } else {
      accepted.push({ input, result });
    }
  }

  return { accepted, rejected };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function toPartialDate(row: {
  dateStartYear: number | null;
  dateStartMonth: number | null;
  dateStartDay: number | null;
  dateStartPrecision: PartialDate['precision'];
}): PartialDate {
  return {
    year: row.dateStartYear,
    month: row.dateStartMonth,
    day: row.dateStartDay,
    precision: row.dateStartPrecision,
  };
}

/**
 * Fetch both nodes' STORED dates and compare them. Amendment A6 requires the
 * stored dates be used, never dates restated by the LLM.
 */
async function checkChronologyFromStoredDates(
  tx: Transaction,
  causeNodeId: string,
  effectNodeId: string,
) {
  const rows = await tx
    .select({
      id: nodes.id,
      dateStartYear: nodes.dateStartYear,
      dateStartMonth: nodes.dateStartMonth,
      dateStartDay: nodes.dateStartDay,
      dateStartPrecision: nodes.dateStartPrecision,
    })
    .from(nodes)
    .where(inArray(nodes.id, [causeNodeId, effectNodeId]));

  const cause = rows.find((row) => row.id === causeNodeId);
  const effect = rows.find((row) => row.id === effectNodeId);

  if (!cause || !effect) {
    throw new Error(
      `insertVerifiedEdge: node not found (cause=${causeNodeId}, effect=${effectNodeId})`,
    );
  }

  return checkChronology(toPartialDate(cause), toPartialDate(effect));
}

async function insertEvidenceSpans(
  tx: Transaction,
  edgeId: string,
  input: EdgeInsertInput,
): Promise<void> {
  if (input.evidence.length === 0) return;

  await tx.insert(evidenceSpans).values(
    input.evidence.map((span) => ({
      edgeId,
      extractionRunId: span.extractionRunId,
      sourceDocumentId: span.sourceDocumentId,
      quoteText: span.quoteText,
      normalizedQuote: span.normalizedQuote,
      sectionTitle: span.sectionTitle,
      charOffsetStart: span.charOffsetStart,
      charOffsetEnd: span.charOffsetEnd,
      verificationStatus: 'VERIFIED' as const,
      verificationMethod: 'exact_normalized_match',
      verifiedAt: new Date(),
    })),
  );
}

/**
 * Run `fn` in a SERIALIZABLE transaction, retrying serialization failures and
 * deadlocks with jittered backoff. Non-retryable errors propagate unchanged.
 *
 * Exported for testing the retry classification.
 */
export async function withSerializableRetry<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
  maxRetries: number = MAX_SERIALIZABLE_RETRIES,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await db.transaction(fn, { isolationLevel: 'serializable' });
    } catch (error) {
      if (isSerializationFailure(error) && attempt < maxRetries) {
        const jitter = Math.random() * 150 + 50; // 50-200ms
        await sleep(jitter);
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error('withSerializableRetry: retry loop exhausted unexpectedly');
}

/** True for PostgreSQL serialization failures (40001) and deadlocks (40P01). */
export function isSerializationFailure(error: unknown): boolean {
  const code = extractPgErrorCode(error);
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

/**
 * Walk the error and its `cause` chain looking for a PostgreSQL SQLSTATE.
 * Drizzle wraps driver errors, so the code lives on a nested cause.
 */
function extractPgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    if (typeof current === 'object' && current !== null && 'cause' in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Re-export for callers that only need the client type through this module.
export type { DbClient };
