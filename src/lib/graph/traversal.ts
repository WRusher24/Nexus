/**
 * Read-side graph traversal.
 *
 * All queries are read-only and hit only ACTIVE edges. Recursive CTEs are raw
 * SQL because Drizzle's query builder does not model them; results are mapped
 * to the typed traversal interfaces.
 */

import { sql } from 'drizzle-orm';
import type {
  AncestorTraversalResult,
  DbClient,
  NodeNeighborhood,
  TraversalEdge,
  TraversalNode,
} from './types';

const DEFAULT_NEIGHBORHOOD_LIMIT = 10;
const DEFAULT_TRAVERSAL_DEPTH = 4;
const MAX_ROOT_SEARCH_DEPTH = 10;

/**
 * Columns selected for a node anywhere in this module.
 *
 * Extends `Record<string, unknown>` so the shape satisfies Drizzle's
 * `execute<T>` constraint (which requires an index signature).
 */
interface NodeColumns extends Record<string, unknown> {
  nodeId: string;
  nodeWikidataQid: string | null;
  nodeLabel: string;
  nodeNodeType: string;
  nodeBrief: string | null;
  nodeDateStartYear: number | null;
  nodeDateStartPrecision: string;
  nodeUpstreamState: string;
  nodeDownstreamState: string;
}

/** Columns selected for an edge anywhere in this module. */
interface EdgeColumns extends Record<string, unknown> {
  edgeId: string;
  edgeCauseNodeId: string;
  edgeEffectNodeId: string;
  edgeRelationType: string;
  edgeImportanceRank: number;
  edgeContested: boolean;
  edgeChronologyStatus: string;
}

type JoinedRow = NodeColumns & EdgeColumns;

const EDGE_COLUMNS = sql`
  e.id AS "edgeId",
  e."causeNodeId" AS "edgeCauseNodeId",
  e."effectNodeId" AS "edgeEffectNodeId",
  e."relationType" AS "edgeRelationType",
  e."importanceRank" AS "edgeImportanceRank",
  e.contested AS "edgeContested",
  e."chronologyStatus" AS "edgeChronologyStatus"
`;

const NODE_COLUMNS = sql`
  n.id AS "nodeId",
  n."wikidataQid" AS "nodeWikidataQid",
  n.label AS "nodeLabel",
  n."nodeType" AS "nodeNodeType",
  n.brief AS "nodeBrief",
  n."dateStartYear" AS "nodeDateStartYear",
  n."dateStartPrecision" AS "nodeDateStartPrecision",
  n."upstreamState" AS "nodeUpstreamState",
  n."downstreamState" AS "nodeDownstreamState"
`;

function toNode(row: NodeColumns): TraversalNode {
  return {
    id: row.nodeId,
    wikidataQid: row.nodeWikidataQid,
    label: row.nodeLabel,
    nodeType: row.nodeNodeType,
    brief: row.nodeBrief,
    dateStartYear: row.nodeDateStartYear,
    dateStartPrecision: row.nodeDateStartPrecision,
    upstreamState: row.nodeUpstreamState,
    downstreamState: row.nodeDownstreamState,
  };
}

function toEdge(row: EdgeColumns): TraversalEdge {
  return {
    id: row.edgeId,
    causeNodeId: row.edgeCauseNodeId,
    effectNodeId: row.edgeEffectNodeId,
    relationType: row.edgeRelationType,
    importanceRank: row.edgeImportanceRank,
    contested: row.edgeContested,
    chronologyStatus: row.edgeChronologyStatus,
  };
}

/**
 * Fetch a node with its top-N causes and top-N effects (one hop). Only ACTIVE
 * edges are included; both lists are ordered by importanceRank ascending (most
 * important first), then creation time for a stable tie-break.
 *
 * Returns null if the node does not exist.
 */
export async function getNodeNeighborhood(
  db: DbClient,
  nodeId: string,
  limit: number = DEFAULT_NEIGHBORHOOD_LIMIT,
): Promise<NodeNeighborhood | null> {
  const nodeResult = await db.execute<NodeColumns>(sql`
    SELECT ${NODE_COLUMNS}
    FROM "nodes" n
    WHERE n.id = ${nodeId}::uuid
  `);
  const nodeRow = nodeResult.rows[0];
  if (!nodeRow) return null;

  const causesResult = await db.execute<JoinedRow>(sql`
    SELECT ${EDGE_COLUMNS}, ${NODE_COLUMNS}
    FROM "edges" e
    JOIN "nodes" n ON n.id = e."causeNodeId"
    WHERE e."effectNodeId" = ${nodeId}::uuid
      AND e."status" = 'ACTIVE'
    ORDER BY e."importanceRank" ASC, e."createdAt" ASC
    LIMIT ${limit}
  `);

  const effectsResult = await db.execute<JoinedRow>(sql`
    SELECT ${EDGE_COLUMNS}, ${NODE_COLUMNS}
    FROM "edges" e
    JOIN "nodes" n ON n.id = e."effectNodeId"
    WHERE e."causeNodeId" = ${nodeId}::uuid
      AND e."status" = 'ACTIVE'
    ORDER BY e."importanceRank" ASC, e."createdAt" ASC
    LIMIT ${limit}
  `);

  return {
    node: toNode(nodeRow),
    causes: causesResult.rows.map((row) => ({ edge: toEdge(row), node: toNode(row) })),
    effects: effectsResult.rows.map((row) => ({ edge: toEdge(row), node: toNode(row) })),
  };
}

/**
 * Bounded-depth upstream traversal (causes of causes). Returns the ancestor
 * nodes and the traversed edges, deduplicated across multiple paths.
 */
export async function getAncestors(
  db: DbClient,
  nodeId: string,
  maxDepth: number = DEFAULT_TRAVERSAL_DEPTH,
): Promise<AncestorTraversalResult> {
  const rows = await db.execute<JoinedRow>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT e.id AS "edgeId", e."causeNodeId" AS "neighborId", 1 AS depth
      FROM "edges" e
      WHERE e."effectNodeId" = ${nodeId}::uuid
        AND e."status" = 'ACTIVE'
      UNION ALL
      SELECT e.id, e."causeNodeId", a.depth + 1
      FROM "edges" e
      JOIN ancestors a ON e."effectNodeId" = a."neighborId"
      WHERE e."status" = 'ACTIVE'
        AND a.depth < ${maxDepth}
    )
    SELECT DISTINCT ${EDGE_COLUMNS}, ${NODE_COLUMNS}
    FROM ancestors a
    JOIN "nodes" n ON n.id = a."neighborId"
    JOIN "edges" e ON e.id = a."edgeId"
  `);

  return dedupeTraversal(rows.rows);
}

/**
 * Bounded-depth downstream traversal (effects of effects). Mirror of
 * `getAncestors`.
 */
export async function getDescendants(
  db: DbClient,
  nodeId: string,
  maxDepth: number = DEFAULT_TRAVERSAL_DEPTH,
): Promise<AncestorTraversalResult> {
  const rows = await db.execute<JoinedRow>(sql`
    WITH RECURSIVE descendants AS (
      SELECT e.id AS "edgeId", e."effectNodeId" AS "neighborId", 1 AS depth
      FROM "edges" e
      WHERE e."causeNodeId" = ${nodeId}::uuid
        AND e."status" = 'ACTIVE'
      UNION ALL
      SELECT e.id, e."effectNodeId", d.depth + 1
      FROM "edges" e
      JOIN descendants d ON e."causeNodeId" = d."neighborId"
      WHERE e."status" = 'ACTIVE'
        AND d.depth < ${maxDepth}
    )
    SELECT DISTINCT ${EDGE_COLUMNS}, ${NODE_COLUMNS}
    FROM descendants d
    JOIN "nodes" n ON n.id = d."neighborId"
    JOIN "edges" e ON e.id = d."edgeId"
  `);

  return dedupeTraversal(rows.rows);
}

function dedupeTraversal(rows: JoinedRow[]): AncestorTraversalResult {
  const nodesById = new Map<string, TraversalNode>();
  const edgesById = new Map<string, TraversalEdge>();

  for (const row of rows) {
    if (!nodesById.has(row.nodeId)) {
      nodesById.set(row.nodeId, toNode(row));
    }
    if (!edgesById.has(row.edgeId)) {
      edgesById.set(row.edgeId, toEdge(row));
    }
  }

  return { nodes: [...nodesById.values()], edges: [...edgesById.values()] };
}

/**
 * Shortest upstream distance from a node to any root (Node.isRoot = true).
 * Returns 0 if the node itself is a root, or null if no root is reachable
 * within `MAX_ROOT_SEARCH_DEPTH` hops. Used by the expansion depth gate
 * (Amendment A10).
 */
export async function distanceToNearestRoot(
  db: DbClient,
  nodeId: string,
): Promise<number | null> {
  const result = await db.execute<{ minDepth: number | null }>(sql`
    WITH RECURSIVE upstream AS (
      SELECT ${nodeId}::uuid AS "nodeId", 0 AS depth
      UNION ALL
      SELECT e."causeNodeId", u.depth + 1
      FROM "edges" e
      JOIN upstream u ON e."effectNodeId" = u."nodeId"
      WHERE e."status" = 'ACTIVE'
        AND u.depth < ${MAX_ROOT_SEARCH_DEPTH}
    )
    SELECT MIN(u.depth) AS "minDepth"
    FROM upstream u
    JOIN "nodes" n ON u."nodeId" = n."id"
    WHERE n."isRoot" = true
  `);

  const minDepth = result.rows[0]?.minDepth;
  return minDepth == null ? null : Number(minDepth);
}
