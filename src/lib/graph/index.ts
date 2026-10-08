/**
 * Graph module public surface (Milestone 4).
 *
 * Write paths:  upsertNode, insertVerifiedEdge, insertVerifiedEdgeBatch, mergeNodes
 * Read paths:   checkForCycle, getNodeNeighborhood, getAncestors, getDescendants,
 *               distanceToNearestRoot
 */

export { upsertNode } from './upsertNode';
export {
  insertVerifiedEdge,
  insertVerifiedEdgeBatch,
  withSerializableRetry,
  isSerializationFailure,
} from './insertVerifiedEdge';
export { checkForCycle, hasActiveCycle } from './cycleCheck';
export { mergeNodes } from './mergeNodes';
export {
  getNodeNeighborhood,
  getAncestors,
  getDescendants,
  distanceToNearestRoot,
} from './traversal';

export type {
  Database,
  Transaction,
  DbClient,
  IdentityScheme,
  NodeIdentity,
  NodeType,
  UpsertNodeInput,
  UpsertNodeResult,
  RelationType,
  EvidenceInput,
  EdgeInsertInput,
  EdgeInsertResult,
  EdgeRejectionReason,
  BatchEdgeResult,
  CycleCheckResult,
  MergeNodesInput,
  MergeNodesResult,
  TraversalNode,
  TraversalEdge,
  NodeNeighborhood,
  AncestorTraversalResult,
} from './types';
