/**
 * Extraction orchestrator (Milestone 6).
 *
 * `runExtraction` is the first function that converts an untrusted Wikipedia
 * article into verified graph edges end to end:
 *
 *   load focal node -> fetch + chunk source -> build prompt -> reserve budget
 *   -> create ExtractionRun (BEFORE the LLM call, A9) -> call provider ->
 *   validate -> persist accepted edges via insertVerifiedEdge + RejectedProposal
 *   -> reconcile budget -> return.
 *
 * It deliberately does NOT touch ExpansionRequest, Node.upstreamState /
 * downstreamState, or user quotas. Those belong to M7.
 */

import { eq } from 'drizzle-orm';
import { extractionRuns, nodes, rejectedProposals } from '../db/schema';
import { insertVerifiedEdge } from '../graph/insertVerifiedEdge';
import type { Database, EdgeInsertInput, NodeIdentity } from '../graph/types';
import { upsertNode } from '../graph/upsertNode';
import { normalize } from '../quote/normalize';
import { chunkArticle } from '../wikipedia/chunker';
import { sha256 } from '../wikipedia/parser';
import { reserveBudget, reconcileBudget, type BudgetReservation } from './budget';
import { buildPrompt, PROMPT_VERSION } from './prompt';
import { computeCostUsd, LlmError } from './provider';
import {
  EXTRACTION_SCHEMA_VERSION,
  ExtractionOutputSchema,
  type ExtractionOutput,
  type ProposedEdge,
} from './schema';
import {
  validateExtractionOutput,
  type AcceptedEdge,
  type RejectedProposalRecord,
  type RejectionReason,
  type SentChunkRange,
} from './validate';
import type { ExtractionConfig, RunExtractionInput, RunExtractionResult } from './types';
import type { PartialDate } from '../dates/intervals';

type NodeRow = typeof nodes.$inferSelect;

/** A rejection produced while persisting an edge (late rejection). */
interface LateRejection {
  input: ProposedEdge;
  reason: RejectionReason;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small formatting helpers (exported for tests / the CLI)
// ─────────────────────────────────────────────────────────────────────────────

function formatYear(year: number, precision: string): string {
  if (year < 0) {
    return precision === 'CENTURY' ? `${Math.abs(year) + 1}00 BCE` : `${Math.abs(year)} BCE`;
  }
  switch (precision) {
    case 'CENTURY': {
      const century = Math.floor(year / 100) + 1;
      return `${century}th century`;
    }
    case 'DECADE':
      return `${year}s`;
    case 'MILLENNIUM':
      return `${Math.floor(year / 1000) + 1}th millennium`;
    default:
      return `${year}`;
  }
}

/**
 * Human-readable date phrase used in the prompt (e.g. "1914-1918",
 * "19th century", "unknown").
 */
export function formatBriefDates(node: {
  dateStartYear: number | null;
  dateStartPrecision: string;
  dateEndYear: number | null;
  dateEndPrecision: string;
}): string {
  if (node.dateStartYear === null && node.dateEndYear === null) return 'unknown';

  const start =
    node.dateStartYear === null
      ? 'unknown'
      : formatYear(node.dateStartYear, node.dateStartPrecision);
  const end =
    node.dateEndYear === null
      ? null
      : formatYear(node.dateEndYear, node.dateEndPrecision);

  if (end && end !== start) return `${start}-${end}`;
  return start;
}

function partialFromNode(row: NodeRow): PartialDate {
  return {
    year: row.dateStartYear,
    month: row.dateStartMonth,
    day: row.dateStartDay,
    precision: row.dateStartPrecision,
  };
}

function rawPromptOf(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt}\n---\n${userPrompt}`;
}

/**
 * Run a single extraction for a focal node and direction.
 */
export async function runExtraction(
  db: Database,
  config: ExtractionConfig,
  input: RunExtractionInput,
): Promise<RunExtractionResult> {
  // ── Step 1: load the focal node and resolve a Wikipedia page id. ──
  const [focal] = await db
    .select()
    .from(nodes)
    .where(eq(nodes.id, input.focalNodeId))
    .limit(1);

  if (!focal) {
    return {
      outcome: 'FAILED',
      extractionRunId: null,
      stage: 'FETCH',
      error: `focal node ${input.focalNodeId} does not exist`,
      retryable: false,
    };
  }

  let pageId = focal.wikipediaPageId;
  if (pageId === null && focal.wikidataQid) {
    try {
      const entity = await config.wikidata.getEntity(focal.wikidataQid);
      if (entity.wikipediaTitle) {
        const article = await config.wikipedia.fetchArticleByTitle(entity.wikipediaTitle);
        if (article) pageId = article.pageId;
      }
    } catch {
      // Fall through to ABORTED_NO_SOURCE.
    }
  }

  if (pageId === null) {
    return {
      outcome: 'ABORTED_NO_SOURCE',
      reason: `no Wikipedia source resolvable for node "${focal.label}"`,
    };
  }

  // ── Step 2: fetch (or reuse) the pinned SourceDocument. ──
  let sourceDocument;
  try {
    sourceDocument = await config.sourceDocumentService.fetchAndStore(pageId);
  } catch (error) {
    return {
      outcome: 'FAILED',
      extractionRunId: null,
      stage: 'FETCH',
      error: `failed to fetch source document for page ${pageId}: ${String(error)}`,
      retryable: true,
    };
  }

  // ── Step 3: chunk the article. ──
  const chunks = chunkArticle(
    sourceDocument.rawText,
    sourceDocument.sectionIndex,
    input.direction,
  );
  if (chunks.length === 0) {
    return {
      outcome: 'FAILED',
      extractionRunId: null,
      stage: 'FETCH',
      error: `chunker returned no chunks for page ${pageId}`,
      retryable: false,
    };
  }

  const sentChunks: SentChunkRange[] = chunks.map((chunk) => ({
    sectionTitle: chunk.sectionTitle,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
  }));

  // ── Step 4: build the (deterministic, context-free) prompt. ──
  const promptOutput = buildPrompt({
    focalEntity: {
      name: focal.label,
      nodeType: focal.nodeType,
      qid: focal.wikidataQid,
      briefDates: formatBriefDates(focal),
    },
    direction: input.direction,
    chunks: chunks.map((chunk) => ({
      sectionTitle: chunk.sectionTitle,
      text: chunk.text,
    })),
  });

  // ── Step 5: estimate cost from the input token count (+20% buffer). ──
  const rawPrompt = rawPromptOf(promptOutput.systemPrompt, promptOutput.userPrompt);
  const inputTokensEstimate = Math.ceil(
    (promptOutput.systemPrompt.length + promptOutput.userPrompt.length) / 4,
  );
  const estimatedCostUsd =
    computeCostUsd(config.provider.defaultModel, inputTokensEstimate, 0) * 1.2;

  // ── Step 6: reserve budget atomically (aborts if over budget/paused). ──
  const reservation = await reserveBudget(db, estimatedCostUsd);
  if (!reservation) {
    return {
      outcome: 'ABORTED_BUDGET',
      reason: `budget reservation of $${estimatedCostUsd.toFixed(6)} was rejected (over cap or paused)`,
    };
  }

  // ── Step 7: create the ExtractionRun BEFORE the LLM call (A9). ──
  const [run] = await db
    .insert(extractionRuns)
    .values({
      focalNodeId: focal.id,
      direction: input.direction,
      sourceDocumentId: sourceDocument.id,
      modelId: config.provider.defaultModel,
      promptVersion: PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      chunksUsed: chunks.map((chunk) => ({
        sectionTitle: chunk.sectionTitle,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      })),
      rawPrompt,
      rawResponse: '',
      rawResponseHash: '',
      status: 'PENDING',
      estimatedCostUsd,
    })
    .returning({ id: extractionRuns.id });

  if (!run) {
    await reconcileBudget(db, reservation, 0);
    return {
      outcome: 'FAILED',
      extractionRunId: null,
      stage: 'PERSISTENCE',
      error: 'failed to create ExtractionRun row',
      retryable: true,
    };
  }
  const runId = run.id;

  await db
    .update(extractionRuns)
    .set({ status: 'RUNNING', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(extractionRuns.id, runId));

  // ── Step 8: call the provider. ──
  let llmResult;
  try {
    llmResult = await config.provider.generate({
      systemPrompt: promptOutput.systemPrompt,
      userPrompt: promptOutput.userPrompt,
      schema: ExtractionOutputSchema,
      maxOutputTokens: 4000,
      temperature: 0,
    });
  } catch (error) {
    const llmError =
      error instanceof LlmError
        ? error
        : new LlmError('PROVIDER_ERROR', String(error), false);

    await db
      .update(extractionRuns)
      .set({
        status: 'FAILED',
        completedAt: new Date(),
        updatedAt: new Date(),
        rejectionReasons: [
          { edgeDescription: 'extraction', reason: `${llmError.code}: ${llmError.detail}` },
        ],
      })
      .where(eq(extractionRuns.id, runId));

    // The LLM call failed: no cost was incurred, refund the reservation.
    await reconcileBudget(db, reservation, 0);

    return {
      outcome: 'FAILED',
      extractionRunId: runId,
      stage: 'LLM',
      error: llmError.message,
      retryable: llmError.retryable,
    };
  }

  await db
    .update(extractionRuns)
    .set({
      modelId: llmResult.modelId,
      rawResponse: llmResult.rawResponse,
      rawResponseHash: sha256(llmResult.rawResponse),
      inputTokens: llmResult.usage.inputTokens,
      outputTokens: llmResult.usage.outputTokens,
      estimatedCostUsd: llmResult.estimatedCostUsd,
      updatedAt: new Date(),
    })
    .where(eq(extractionRuns.id, runId));

  // ── Step 9-10: run the validation pipeline. ──
  const normalizedSource = normalize(sourceDocument.rawText);

  let validation;
  try {
    validation = await validateExtractionOutput(llmResult.parsed, {
      focalNodeId: focal.id,
      focalEntityName: focal.label,
      focalQid: focal.wikidataQid,
      focalDates: {
        start: partialFromNode(focal),
        end: {
          year: focal.dateEndYear,
          month: focal.dateEndMonth,
          day: focal.dateEndDay,
          precision: focal.dateEndPrecision,
        },
      },
      direction: input.direction,
      sourceDocumentId: sourceDocument.id,
      sourceRawText: sourceDocument.rawText,
      normalizedSource,
      sentChunks,
      resolver: config.resolver,
      db,
    });
  } catch (error) {
    await db
      .update(extractionRuns)
      .set({
        status: 'FAILED',
        completedAt: new Date(),
        updatedAt: new Date(),
        rejectionReasons: [
          { edgeDescription: 'validation', reason: String(error) },
        ],
      })
      .where(eq(extractionRuns.id, runId));
    // The LLM call succeeded: the cost is real and must be charged.
    await reconcileBudget(db, reservation, llmResult.estimatedCostUsd);
    return {
      outcome: 'FAILED',
      extractionRunId: runId,
      stage: 'VALIDATION',
      error: String(error),
      retryable: false,
    };
  }

  // ── Step 11: persist accepted edges, rejected proposals, run counts. ──
  try {
    return await persistExtraction(
      db,
      focal,
      input,
      sourceDocument.id,
      runId,
      llmResult.parsed,
      validation.accepted,
      validation.rejected,
      validation.sparsenessReason,
      reservation,
      llmResult.estimatedCostUsd,
    );
  } catch (error) {
    await db
      .update(extractionRuns)
      .set({
        status: 'FAILED',
        completedAt: new Date(),
        updatedAt: new Date(),
        rejectionReasons: [
          { edgeDescription: 'persistence', reason: String(error) },
        ],
      })
      .where(eq(extractionRuns.id, runId));
    await reconcileBudget(db, reservation, llmResult.estimatedCostUsd);
    return {
      outcome: 'FAILED',
      extractionRunId: runId,
      stage: 'PERSISTENCE',
      error: String(error),
      retryable: true,
    };
  }
}

function toIdentity(accepted: AcceptedEdge): NodeIdentity {
  const { qid, wikipediaPageId, nexusGeneratedId } = accepted.resolvedRelatedEntity;
  if (qid) return { wikidataQid: qid };
  if (nexusGeneratedId) return { nexusGeneratedId };
  return { wikipediaPageId: wikipediaPageId ?? undefined };
}

async function persistExtraction(
  db: Database,
  focal: NodeRow,
  input: RunExtractionInput,
  sourceDocumentId: string,
  runId: string,
  parsed: ExtractionOutput,
  accepted: AcceptedEdge[],
  rejected: RejectedProposalRecord[],
  sparsenessReason: string | null,
  reservation: BudgetReservation,
  actualCostUsd: number,
): Promise<RunExtractionResult> {
  const lateRejections: LateRejection[] = [];
  let acceptedCount = 0;

  for (const entry of accepted) {
    const related = entry.input.relatedEntity;

    const upsert = await upsertNode(db, {
      identity: toIdentity(entry),
      label: related.name,
      nodeType: related.entityType,
      ...(related.brief !== undefined ? { brief: related.brief } : {}),
      dateStartYear: related.dateStart.year,
      dateStartMonth: related.dateStart.month,
      dateStartDay: related.dateStart.day,
      dateStartPrecision: related.dateStart.precision,
      dateEndYear: related.dateEnd.year,
      dateEndMonth: related.dateEnd.month,
      dateEndDay: related.dateEnd.day,
      dateEndPrecision: related.dateEnd.precision,
    });

    const relatedNodeId = upsert.nodeId;
    const causeNodeId = input.direction === 'UPSTREAM' ? relatedNodeId : focal.id;
    const effectNodeId = input.direction === 'UPSTREAM' ? focal.id : relatedNodeId;

    const edgeInput: EdgeInsertInput = {
      causeNodeId,
      effectNodeId,
      relationType: entry.input.relationType,
      importanceRank: entry.input.importanceRank,
      contested: entry.input.contested,
      extractionRunId: runId,
      evidence: [
        {
          quoteText: entry.evidence.quoteText,
          normalizedQuote: entry.evidence.normalizedQuote,
          sectionTitle: entry.evidence.sectionTitle,
          charOffsetStart: entry.evidence.charOffsetStart,
          charOffsetEnd: entry.evidence.charOffsetEnd,
          sourceDocumentId,
          extractionRunId: runId,
        },
      ],
    };

    const result = await insertVerifiedEdge(db, edgeInput);
    if (result.outcome === 'REJECTED') {
      lateRejections.push({
        input: entry.input,
        reason: result.reason,
        detail: result.detail,
      });
    } else {
      acceptedCount += 1;
    }
  }

  const allRejected = [...rejected, ...lateRejections];
  const rejectedCount = allRejected.length;

  if (allRejected.length > 0) {
    await db.insert(rejectedProposals).values(
      allRejected.map((rejection) => ({
        extractionRunId: runId,
        proposalData: {
          proposal: rejection.input,
          detail: rejection.detail,
        },
        rejectionReason: rejection.reason,
      })),
    );
  }

  const status: 'COMPLETED' | 'PARTIAL' =
    acceptedCount > 0 && rejectedCount > 0 ? 'PARTIAL' : 'COMPLETED';
  const finalState = acceptedCount > 0 ? 'EXPANDED' : 'SPARSE';
  const finalSparsenessReason =
    acceptedCount === 0
      ? (sparsenessReason ?? 'No proposed edge passed validation')
      : null;

  await db
    .update(extractionRuns)
    .set({
      status,
      edgesProposed: parsed.edges.length,
      edgesAccepted: acceptedCount,
      edgesRejected: rejectedCount,
      rejectionReasons: allRejected.map((rejection) => ({
        edgeDescription: `${rejection.input.relatedEntity.name} - ${rejection.input.relationType}`,
        reason: rejection.reason,
      })),
      sparsenessReason: finalSparsenessReason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(extractionRuns.id, runId));

  await reconcileBudget(db, reservation, actualCostUsd);

  return {
    outcome: 'COMPLETED',
    extractionRunId: runId,
    finalState,
    edgesProposed: parsed.edges.length,
    edgesAccepted: acceptedCount,
    edgesRejected: rejectedCount,
    estimatedCostUsd: actualCostUsd,
  };
}
