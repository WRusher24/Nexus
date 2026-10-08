/**
 * Expansion queue public surface (M7).
 *
 * `requestExpansion` is the caller-facing API; everything else supports the
 * worker process (claim, heartbeat, reaper, processExpansion) or exposes the
 * state machine and its auditing helpers.
 */

export {
  transition,
  setNodeState,
  REQUEST_TO_NODE_STATE,
  LEGAL_TRANSITIONS,
  type TransitionInput,
  type TransitionPatch,
  type TransitionResult,
  type ExpansionRequestStatus,
  type NodeExpansionState,
} from './transition';

export {
  checkDepth,
  MAX_DEPTH_FROM_ROOT,
  DEPTH_ORPHAN,
  type DepthCheckResult,
} from './depth';

export {
  ensureUserQuota,
  reserveUserQuota,
  refundUserQuota,
  getUserQuota,
  type QuotaReservation,
  type QuotaReserveFailureReason,
  type EnsureUserQuotaOptions,
} from './quota';

export {
  requestExpansion,
} from './requestExpansion';

export {
  claimNextRequest,
  DEFAULT_CLAIM_LEASE_SECONDS,
  type ClaimedRequest,
  type ClaimOptions,
} from './claim';

export {
  startHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_LEASE_SECONDS,
  type HeartbeatHandle,
  type HeartbeatOptions,
} from './heartbeat';

export {
  runReaper,
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  type ReaperResult,
} from './reaper';

export {
  processExpansion,
  releaseLeaseAfterError,
  type ProcessExpansionInput,
  type ProcessExpansionResult,
} from './processExpansion';

export {
  QueueError,
  isUniqueViolation,
  type QueueErrorCode,
} from './errors';

export {
  IN_FLIGHT_STATUSES,
  type Direction,
  type RequestExpansionInput,
  type RequestExpansionResult,
} from './types';
