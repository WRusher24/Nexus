import { sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../lib/db/schema';

type Db = NodePgDatabase<typeof schema>;

export type RelationType = (typeof schema.relationTypeEnum.enumValues)[number];
export type EdgeStatus = (typeof schema.edgeStatusEnum.enumValues)[number];
export type ChronologyStatus =
  (typeof schema.chronologyStatusEnum.enumValues)[number];
export type VerificationStatus =
  (typeof schema.verificationStatusEnum.enumValues)[number];

export interface InsertEdgeInput {
  causeNodeId: string;
  effectNodeId: string;
  extractionRunId: string;
  relationType?: RelationType;
  status?: EdgeStatus;
  chronologyStatus?: ChronologyStatus;
  importanceRank?: number;
}

export interface InsertEdgeWithEvidenceInput extends InsertEdgeInput {
  sourceDocumentId: string;
  evidenceStatus?: VerificationStatus;
  quoteText?: string;
}

/**
 * The raw insert for an Edge row.
 *
 * We deliberately use raw SQL rather than `db.insert(edges)`: AGENTS.md (and
 * the ESLint rule) bans direct Drizzle inserts into the Edge table outside
 * `insertVerifiedEdge()`. That production function does not exist until M4, so
 * these test helpers simulate it. The DB-level constraints under test (the
 * deferred P3 trigger, partial unique index, CHECKs) are unaffected by whether
 * the row arrives via Drizzle or raw SQL.
 */
export function edgeInsertSql(input: InsertEdgeInput): SQL {
  return sql`
    INSERT INTO "edges"
      ("causeNodeId", "effectNodeId", "relationType", "status", "chronologyStatus", "importanceRank", "firstExtractionRunId")
    VALUES (
      ${input.causeNodeId}::uuid,
      ${input.effectNodeId}::uuid,
      ${input.relationType ?? 'CAUSED'}::relation_type,
      ${input.status ?? 'ACTIVE'}::edge_status,
      ${input.chronologyStatus ?? 'UNVERIFIED'}::chronology_status,
      ${input.importanceRank ?? 5},
      ${input.extractionRunId}::uuid
    )
    RETURNING "id"
  `;
}

/**
 * Insert an ACTIVE edge and a VERIFIED evidence span in a single transaction,
 * mirroring what `insertVerifiedEdge()` will do in M4. Inserting both inside one
 * transaction is what lets the deferred P3 constraint trigger pass at COMMIT.
 *
 * Returns the new edge id.
 */
export async function insertEdgeWithEvidence(
  db: Db,
  input: InsertEdgeWithEvidenceInput,
): Promise<string> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(edgeInsertSql(input));
    const edgeId = result.rows[0]?.id;
    if (!edgeId) {
      throw new Error('insertEdgeWithEvidence: edge insert returned no row');
    }

    const quoteText = input.quoteText ?? 'A test quote.';
    await tx.insert(schema.evidenceSpans).values({
      edgeId,
      extractionRunId: input.extractionRunId,
      sourceDocumentId: input.sourceDocumentId,
      quoteText,
      normalizedQuote: quoteText.toLowerCase(),
      verificationStatus: input.evidenceStatus ?? 'VERIFIED',
      verifiedAt: new Date(),
    });

    return edgeId;
  });
}
