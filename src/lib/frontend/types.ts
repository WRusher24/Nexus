/**
 * Frontend-specific types and small display helpers (M9).
 *
 * These mirror the JSON shapes returned by the M8 API routes (and the new
 * `GET /api/edges/{id}` route) so the components and the typed API client agree
 * on one definition. They deliberately do NOT import the server-side Drizzle
 * schema: the browser bundle must never pull in `pg`.
 *
 * React Flow v12 constrains node/edge `data` to `Record<string, unknown>`, so
 * the shapes that flow into React Flow are declared as `type` aliases (not
 * `interface`s) — interfaces are not assignable to an index signature.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Search / disambiguation
// ─────────────────────────────────────────────────────────────────────────────

export type ResolverConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface DisambiguationCandidate {
  pageId: number;
  title: string;
  snippet: string;
  wordCount: number;
  resolvedQid: string | null;
  qidConfidence: ResolverConfidence;
}

export interface SearchResponse {
  candidates: DisambiguationCandidate[];
}

export interface CreateRootNodeResponse {
  nodeId: string;
  sourceDocumentId: string;
  qid: string | null;
  outcome: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph traversal
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

export interface NodeNeighborhoodResponse {
  node: TraversalNode & { isRoot: boolean };
  causes: Array<{ edge: TraversalEdge; node: TraversalNode }>;
  effects: Array<{ edge: TraversalEdge; node: TraversalNode }>;
}

export interface TraversalResponse {
  nodes: TraversalNode[];
  edges: TraversalEdge[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Expansion / quota / feedback
// ─────────────────────────────────────────────────────────────────────────────

export type ExpansionDirection = 'UPSTREAM' | 'DOWNSTREAM';

export type ExpansionResponse =
  | {
      outcome: 'CACHE_HIT';
      state: 'EXPANDED' | 'SPARSE';
      extractionRunId: string | null;
    }
  | { outcome: 'IN_PROGRESS'; requestId: string; streamUrl: string }
  | { outcome: 'QUEUED'; requestId: string; streamUrl: string };

export interface ExpansionStatusResponse {
  requestId: string;
  nodeId: string;
  direction: ExpansionDirection;
  status: string;
  attempt: number;
  extractionRunId: string | null;
  lastError: string | null;
}

export interface FeedbackResponse {
  feedbackId: string;
  autoHidden: boolean;
}

export interface QuotaResponse {
  expansionsToday: number;
  expansionsThisMonth: number;
  dailyLimit: number;
  monthlyLimit: number;
  remainingToday: number;
  remainingThisMonth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single edge detail (GET /api/edges/{id}) — the additive M9 route
// ─────────────────────────────────────────────────────────────────────────────

export interface EvidenceSpanDetail {
  id: string;
  quoteText: string;
  sectionTitle: string | null;
  verificationStatus: string;
  charOffsetStart: number | null;
  charOffsetEnd: number | null;
  sourceDocument: {
    id: string;
    wikipediaTitle: string;
    wikipediaPageId: number;
    revisionId: number;
  } | null;
}

export interface EdgeDetailResponse {
  edge: {
    id: string;
    causeNodeId: string;
    effectNodeId: string;
    causeLabel: string | null;
    effectLabel: string | null;
    relationType: string;
    importanceRank: number;
    contested: boolean;
    chronologyStatus: string;
    status: string;
  };
  evidence: EvidenceSpanDetail[];
}

// ─────────────────────────────────────────────────────────────────────────────
// React Flow node/edge data
// ─────────────────────────────────────────────────────────────────────────────

export type HistoryNodeData = {
  id: string;
  label: string;
  nodeType: string;
  brief: string | null;
  wikidataQid: string | null;
  dateStartYear: number | null;
  dateStartPrecision: string;
  upstreamState: string;
  downstreamState: string;
  isRoot: boolean;
};

export type HistoryEdgeData = {
  id: string;
  label: string;
  relationType: string;
  importanceRank: number;
  contested: boolean;
  chronologyStatus: string;
};

export type PositionedNode = HistoryNodeData & { x: number; y: number };

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Tailwind classes for the node-type pill, keyed by `nodeType`. */
export const NODE_TYPE_BADGE: Record<string, string> = {
  EVENT: 'bg-blue-100 text-blue-800',
  PROCESS: 'bg-purple-100 text-purple-800',
  POLICY: 'bg-green-100 text-green-800',
  ACTOR: 'bg-orange-100 text-orange-800',
  IDEOLOGY: 'bg-pink-100 text-pink-800',
  INSTITUTION: 'bg-teal-100 text-teal-800',
  TECHNOLOGY: 'bg-yellow-100 text-yellow-800',
  PLACE: 'bg-gray-100 text-gray-800',
};

export function nodeTypeBadgeClass(nodeType: string): string {
  return NODE_TYPE_BADGE[nodeType] ?? 'bg-gray-100 text-gray-800';
}

/** Tailwind color for an expansion-state dot. */
export function expansionStateColor(state: string): string {
  switch (state) {
    case 'EXPANDED':
      return 'bg-green-500';
    case 'SPARSE':
      return 'bg-blue-500';
    case 'LOADING':
    case 'QUEUED':
      return 'bg-yellow-500';
    case 'FAILED':
      return 'bg-red-500';
    default:
      return 'bg-gray-300';
  }
}

/** Human label for an expansion state. */
export function expansionStateLabel(state: string): string {
  switch (state) {
    case 'EXPANDED':
      return 'Expanded';
    case 'SPARSE':
      return 'Sparse';
    case 'LOADING':
      return 'Loading';
    case 'QUEUED':
      return 'Queued';
    case 'FAILED':
      return 'Failed';
    default:
      return 'Unexpanded';
  }
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Format a signed year per the date convention (negative = BCE) and the
 * recorded precision. Mirrors the acceptance criteria examples:
 *   DAY → "28 Jun 1919" (day/month supplied separately) | YEAR → "1919"
 *   DECADE → "1910s" | CENTURY → "20th century"
 */
export function formatDate(
  year: number | null,
  precision: string,
  month?: number | null,
  day?: number | null,
): string {
  if (year === null || precision === 'UNKNOWN') return '';

  const era = year < 0 ? 'BCE' : '';
  const absYear = Math.abs(year);

  switch (precision) {
    case 'DAY': {
      if (month && day) {
        const monthName = MONTHS[month - 1] ?? '';
        return `${day} ${monthName} ${absYear}${era ? ` ${era}` : ''}`.trim();
      }
      return formatDate(year, 'YEAR');
    }
    case 'MONTH': {
      if (month) {
        const monthName = MONTHS[month - 1] ?? '';
        return `${monthName} ${absYear}${era ? ` ${era}` : ''}`.trim();
      }
      return formatDate(year, 'YEAR');
    }
    case 'YEAR':
      return `${absYear}${era ? ` ${era}` : ''}`;
    case 'DECADE': {
      const decade = Math.floor(absYear / 10) * 10;
      return `${decade}s${era ? ` ${era}` : ''}`;
    }
    case 'CENTURY': {
      const century = Math.floor((absYear - 1) / 100) + 1;
      const suffix = ordinalSuffix(century);
      return `${century}${suffix} century${era ? ` ${era}` : ''}`;
    }
    case 'MILLENNIUM': {
      const millennium = Math.floor((absYear - 1) / 1000) + 1;
      const suffix = ordinalSuffix(millennium);
      return `${millennium}${suffix} millennium${era ? ` ${era}` : ''}`;
    }
    default:
      return '';
  }
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/** Format a relation type enum into a readable phrase. */
export function formatRelationType(relationType: string): string {
  switch (relationType) {
    case 'CAUSED':
      return 'caused';
    case 'CONTRIBUTED_TO':
      return 'contributed to';
    case 'ENABLED':
      return 'enabled';
    case 'TRIGGERED':
      return 'triggered';
    case 'PREVENTED':
      return 'prevented';
    case 'INFLUENCED':
      return 'influenced';
    default:
      return relationType.toLowerCase().replace(/_/g, ' ');
  }
}
