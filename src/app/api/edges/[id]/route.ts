/**
 * GET /api/edges/{id} (M9, additive).
 *
 * Returns a single edge with its evidence spans and pinned source documents.
 * M8's `GET /api/nodes/{id}` intentionally omits evidence to keep that payload
 * small; the side panel fetches this richer view only when an edge is selected.
 * Additive: no M8 route is modified.
 */

import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { requireUser } from '@/lib/auth/session';
import {
  edges,
  evidenceSpans,
  nodes,
  sourceDocuments,
} from '@/lib/db/schema';
import { badRequest, internalError, notFound } from '@/lib/http/errors';
import { getDb } from '@/lib/http/db';
import { jsonOk } from '@/lib/http/responses';
import { isUuid } from '@/lib/http/validation';

export const runtime = 'nodejs';

export interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const { id } = await context.params;
  if (!isUuid(id)) return badRequest('Invalid edge id');

  try {
    const db = await getDb();
    const causeNodes = alias(nodes, 'causeNodes');
    const effectNodes = alias(nodes, 'effectNodes');

    const [edgeRow] = await db
      .select({
        id: edges.id,
        causeNodeId: edges.causeNodeId,
        effectNodeId: edges.effectNodeId,
        causeLabel: causeNodes.label,
        effectLabel: effectNodes.label,
        relationType: edges.relationType,
        importanceRank: edges.importanceRank,
        contested: edges.contested,
        chronologyStatus: edges.chronologyStatus,
        status: edges.status,
      })
      .from(edges)
      .innerJoin(causeNodes, eq(causeNodes.id, edges.causeNodeId))
      .innerJoin(effectNodes, eq(effectNodes.id, edges.effectNodeId))
      .where(eq(edges.id, id))
      .limit(1);

    if (!edgeRow) return notFound('Edge not found');

    const evidenceRows = await db
      .select({
        id: evidenceSpans.id,
        quoteText: evidenceSpans.quoteText,
        sectionTitle: evidenceSpans.sectionTitle,
        verificationStatus: evidenceSpans.verificationStatus,
        charOffsetStart: evidenceSpans.charOffsetStart,
        charOffsetEnd: evidenceSpans.charOffsetEnd,
        sourceDocumentId: sourceDocuments.id,
        wikipediaTitle: sourceDocuments.wikipediaTitle,
        wikipediaPageId: sourceDocuments.wikipediaPageId,
        revisionId: sourceDocuments.revisionId,
      })
      .from(evidenceSpans)
      .leftJoin(
        sourceDocuments,
        eq(sourceDocuments.id, evidenceSpans.sourceDocumentId),
      )
      .where(eq(evidenceSpans.edgeId, id));

    return jsonOk({
      edge: edgeRow,
      evidence: evidenceRows.map((row) => ({
        id: row.id,
        quoteText: row.quoteText,
        sectionTitle: row.sectionTitle,
        verificationStatus: row.verificationStatus,
        charOffsetStart: row.charOffsetStart,
        charOffsetEnd: row.charOffsetEnd,
        sourceDocument:
          row.sourceDocumentId && row.wikipediaTitle !== null
            ? {
                id: row.sourceDocumentId,
                wikipediaTitle: row.wikipediaTitle,
                wikipediaPageId: row.wikipediaPageId ?? 0,
                revisionId: row.revisionId ?? 0,
              }
            : null,
      })),
    });
  } catch (error) {
    return internalError(error);
  }
}
