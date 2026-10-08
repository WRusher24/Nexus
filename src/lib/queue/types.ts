/**
 * Public types for the M7 expansion queue (Part 1/4 of the milestone brief).
 *
 * The two state unions live here (rather than in `transition.ts`) so that the
 * public API surface, the state machine, and the worker can all share one
 * definition without a runtime import cycle. `transition.ts` re-exports them
 * for callers that expect to find them there.
 */

import type { Direction } from '../wikipedia/types';

export type { Direction };

/** Lifecycle of an `expansionRequests` row. */
export type ExpansionRequestStatus =
  | 'PENDING'
  | 'LOCKED'
  | 'FETCHING'
  | 'EXTRACTING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'FAILED';

/** Lifecycle of a node's per-direction expansion (`upstreamState`/`downstreamState`). */
export type NodeExpansionState =
  | 'UNEXPANDED'
  | 'QUEUED'
  | 'LOADING'
  | 'EXPANDED'
  | 'SPARSE'
  | 'FAILED';

/** Statuses that count as "in flight" for the partial unique index. */
export const IN_FLIGHT_STATUSES: readonly ExpansionRequestStatus[] = [
  'PENDING',
  'LOCKED',
  'FETCHING',
  'EXTRACTING',
  'VALIDATING',
];

// ─────────────────────────────────────────────────────────────────────────────
// requestExpansion (Part 4)
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestExpansionInput {
  nodeId: string;
  direction: Direction;
  userId: string;
}

export type RequestExpansionResult =
  | {
      outcome: 'CACHE_HIT';
      state: 'EXPANDED' | 'SPARSE';
      extractionRunId: string | null;
    }
  | {
      outcome: 'IN_PROGRESS';
      requestId: string;
    }
  | {
      outcome: 'QUEUED';
      requestId: string;
    }
  | {
      outcome: 'REJECTED';
      reason:
        | 'NODE_NOT_FOUND'
        | 'DEPTH_LIMIT_REACHED'
        | 'QUOTA_EXCEEDED'
        | 'INVALID_INPUT';
      detail: string;
    };
