/**
 * Application-level types for the graph write/read paths (Milestone 4).
 *
 * These are NOT Drizzle row types. They are the interfaces callers use when
 * mutating or traversing the graph. Keeping them separate from the schema
 * means the invariant-enforcing functions can evolve their inputs without a
 * migration.
 *
 * The Drizzle client aliases live here too so every graph function agrees on
 * one definition of "a database" and "a transaction".
 */

import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type {
  NodePgDatabase,
  NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from '../db/schema';
import type { DatePrecision } from '../dates/intervals';

// ─────────────────────────────────────────────────────────────────────────────
// Drizzle client aliases
// ─────────────────────────────────────────────────────────────────────────────

/** A root Drizzle database handle (pool-backed). */
export type Database = NodePgDatabase<typeof schema>;

/** The transaction handle Drizzle passes to `db.transaction(cb)`. */
export type Transaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Either a root handle or an open transaction. Read helpers accept this so the
 * same function can be used standalone or inside a larger transaction.
 */
export type DbClient = Database | Transaction;

// ─────────────────────────────────────────────────────────────────────────────
// Node upsert
// ─────────────────────────────────────────────────────────────────────────────

export type IdentityScheme = 'WIKIDATA' | 'WIKIPEDIA_PAGE' | 'NEXUS_GENERATED';

export interface NodeIdentity {
  /** Exactly one of these must be provided. */
  wikidataQid?: string;
  wikipediaPageId?: number;
  nexusGeneratedId?: string;
}

export type NodeType =
  | 'EVENT'
  | 'PROCESS'
  | 'POLICY'
  | 'ACTOR'
  | 'IDEOLOGY'
  | 'INSTITUTION'
  | 'TECHNOLOGY'
  | 'PLACE';

export interface UpsertNodeInput {
  identity: NodeIdentity;
  label: string;
  nodeType: NodeType;
  brief?: string;
  dateStartYear?: number | null;
  dateStartMonth?: number | null;
  dateStartDay?: number | null;
  dateStartPrecision?: DatePrecision;
  dateEndYear?: number | null;
  dateEndMonth?: number | null;
  dateEndDay?: number | null;
  dateEndPrecision?: DatePrecision;
  isRoot?: boolean;
}

export type UpsertNodeResult =
  | { outcome: 'CREATED'; nodeId: string }
  | { outcome: 'EXISTING'; nodeId: string; updated: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Edge insert
// ─────────────────────────────────────────────────────────────────────────────

export type RelationType =
  | 'CAUSED'
  | 'CONTRIBUTED_TO'
  | 'ENABLED'
  | 'TRIGGERED'
  | 'PREVENTED'
  | 'INFLUENCED';

export interface EvidenceInput {
  quoteText: string;
  normalizedQuote: string;
  sectionTitle: string | null;
  charOffsetStart: number;
  charOffsetEnd: number;
  sourceDocumentId: string;
  extractionRunId: string;
}

export interface EdgeInsertInput {
  causeNodeId: string;
  effectNodeId: string;
  relationType: RelationType;
  importanceRank: number;
  contested: boolean;
  extractionRunId: string;
  evidence: EvidenceInput[];
}

export type EdgeInsertResult =
  | { outcome: 'CREATED'; edgeId: string; evidenceCount: number }
  | { outcome: 'EXISTING'; edgeId: string; newEvidenceCount: number }
  | { outcome: 'REJECTED'; reason: EdgeRejectionReason; detail: string };

export type EdgeRejectionReason =
  | 'CYCLE_DETECTED'
  | 'CHRONOLOGY_VIOLATION'
  | 'SELF_EDGE'
  | 'NO_EVIDENCE'
  | 'IMPORTANCE_OUT_OF_RANGE';

// ─────────────────────────────────────────────────────────────────────────────
// Batch edge insert
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchEdgeResult {
  accepted: Array<{
    input: EdgeInsertInput;
    result: EdgeInsertResult & { outcome: 'CREATED' | 'EXISTING' };
  }>;
  rejected: Array<{
    input: EdgeInsertInput;
    result: EdgeInsertResult & { outcome: 'REJECTED' };
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle check
// ─────────────────────────────────────────────────────────────────────────────

export interface CycleCheckResult {
  wouldCreateCycle: boolean;
  /** If a cycle is detected, the path of node IDs forming the cycle. */
  cyclePath?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeNodesInput {
  /** The node to keep (target). */
  keepNodeId: string;
  /** The node to merge away (source). All edges are repointed. */
  removeNodeId: string;
  /** Reason for the merge, logged in qidReconciliations. */
  reason: string;
}

export type MergeNodesResult =
  | { outcome: 'MERGED'; edgesRepointed: number; duplicateEdgesRemoved: number }
  | { outcome: 'FAILED'; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Traversal
// ─────────────────────────────────────────────────────────────────────────────

export interface TraversalNode {
  id: string;
  wikidataQid: string | null;
  label: string;
  nodeType: string;
  brief: string | null;
  dateStartYear: number | null;
  dateStartPrecision: string;
  upstreamState: string;
  downstreamState: string;
}

export interface TraversalEdge {
  id: string;
  causeNodeId: string;
  effectNodeId: string;
  relationType: string;
  importanceRank: number;
  contested: boolean;
  chronologyStatus: string;
}

export interface NodeNeighborhood {
  node: TraversalNode;
  causes: Array<{ edge: TraversalEdge; node: TraversalNode }>;
  effects: Array<{ edge: TraversalEdge; node: TraversalNode }>;
}

export interface AncestorTraversalResult {
  nodes: TraversalNode[];
  edges: TraversalEdge[];
}
