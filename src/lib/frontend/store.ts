'use client';

/**
 * Zustand graph store (M9, Part 1.2).
 *
 * The single source of truth for the graph the user is exploring. Components
 * subscribe with selectors so that, e.g., dragging a node does not re-render
 * the side panel. Keeping React Flow's controlled arrays derived from this
 * store avoids the two-sources-of-truth bugs that a context + local state mix
 * produces on large graphs.
 */

import { create } from 'zustand';
import type {
  ExpansionDirection,
  HistoryEdgeData,
  HistoryNodeData,
} from './types';

/** Callback the container registers to run the expansion flow. */
export type ExpandRequestHandler = (
  nodeId: string,
  direction: ExpansionDirection,
) => void;

export interface NodeData {
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
}

export interface EdgeData {
  id: string;
  source: string;
  target: string;
  relationType: string;
  importanceRank: number;
  contested: boolean;
  chronologyStatus: string;
  label: string;
}

export interface GraphState {
  // ── Graph data ──
  nodes: NodeData[];
  edges: EdgeData[];
  rootNodeId: string | null;

  // ── Selection ──
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // ── Expansion tracking ──
  expansionStates: Record<string, string>; // key: `${nodeId}:${direction}`

  // ── Quota ──
  quota: { remainingToday: number; dailyLimit: number } | null;

  // ── UI state ──
  isSidePanelOpen: boolean;
  isLoading: boolean;
  error: string | null;

  // ── Expansion plumbing ──
  /** Registered by the graph container; custom nodes call it on handle click. */
  expandHandler: ExpandRequestHandler | null;
  setExpandHandler: (handler: ExpandRequestHandler | null) => void;

  // ── Actions ──
  setRootNode: (node: NodeData) => void;
  addNodesAndEdges: (nodes: NodeData[], edges: EdgeData[]) => void;
  updateNode: (nodeId: string, patch: Partial<NodeData>) => void;
  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  setExpansionState: (nodeId: string, direction: string, state: string) => void;
  setQuota: (quota: GraphState['quota']) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  nodes: [] as NodeData[],
  edges: [] as EdgeData[],
  rootNodeId: null as string | null,
  selectedNodeId: null as string | null,
  selectedEdgeId: null as string | null,
  expansionStates: {} as Record<string, string>,
  quota: null as GraphState['quota'],
  isSidePanelOpen: false,
  isLoading: false,
  error: null as string | null,
  expandHandler: null as ExpandRequestHandler | null,
};

/** Merge a batch of nodes by id: new rows replace existing ones. */
function mergeNodes(existing: NodeData[], incoming: NodeData[]): NodeData[] {
  const byId = new Map<string, NodeData>();
  for (const node of existing) byId.set(node.id, node);
  for (const node of incoming) byId.set(node.id, node);
  return [...byId.values()];
}

/** Merge a batch of edges by id. */
function mergeEdges(existing: EdgeData[], incoming: EdgeData[]): EdgeData[] {
  const byId = new Map<string, EdgeData>();
  for (const edge of existing) byId.set(edge.id, edge);
  for (const edge of incoming) byId.set(edge.id, edge);
  return [...byId.values()];
}

export const useGraphStore = create<GraphState>((set) => ({
  ...INITIAL_STATE,

  setRootNode: (node) =>
    set({
      nodes: [node],
      edges: [],
      rootNodeId: node.id,
      expansionStates: {},
      selectedNodeId: null,
      selectedEdgeId: null,
      isSidePanelOpen: false,
      error: null,
    }),

  addNodesAndEdges: (nodes, edges) =>
    set((state) => ({
      nodes: mergeNodes(state.nodes, nodes),
      edges: mergeEdges(state.edges, edges),
    })),

  updateNode: (nodeId, patch) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, ...patch } : node,
      ),
    })),

  selectNode: (nodeId) =>
    set({
      selectedNodeId: nodeId,
      selectedEdgeId: null,
      isSidePanelOpen: nodeId !== null,
    }),

  selectEdge: (edgeId) =>
    set({
      selectedEdgeId: edgeId,
      selectedNodeId: null,
      isSidePanelOpen: edgeId !== null,
    }),

  setExpansionState: (nodeId, direction, state) =>
    set((prev) => {
      const key = `${nodeId}:${direction}`;
      return {
        expansionStates: { ...prev.expansionStates, [key]: state },
        nodes: prev.nodes.map((node) => {
          if (node.id !== nodeId) return node;
          if (direction === 'UPSTREAM') return { ...node, upstreamState: state };
          if (direction === 'DOWNSTREAM') return { ...node, downstreamState: state };
          return node;
        }),
      };
    }),

  setQuota: (quota) => set({ quota }),

  setError: (error) => set({ error }),

  setLoading: (loading) => set({ isLoading: loading }),

  setExpandHandler: (handler) => set({ expandHandler: handler }),

  reset: () => set({ ...INITIAL_STATE }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Mapping helpers shared by the canvas and the client
// ─────────────────────────────────────────────────────────────────────────────

/** Build store NodeData from an API traversal node. */
export function toNodeData(
  node: Omit<HistoryNodeData, 'isRoot'> & { isRoot?: boolean },
): NodeData {
  return {
    id: node.id,
    label: node.label,
    nodeType: node.nodeType,
    brief: node.brief,
    wikidataQid: node.wikidataQid,
    dateStartYear: node.dateStartYear,
    dateStartPrecision: node.dateStartPrecision,
    upstreamState: node.upstreamState,
    downstreamState: node.downstreamState,
    isRoot: node.isRoot ?? false,
  };
}

/** Build store EdgeData from an API traversal edge. */
export function toEdgeData(edge: {
  id: string;
  causeNodeId: string;
  effectNodeId: string;
  relationType: string;
  importanceRank: number;
  contested: boolean;
  chronologyStatus: string;
}): EdgeData {
  return {
    id: edge.id,
    source: edge.causeNodeId,
    target: edge.effectNodeId,
    relationType: edge.relationType,
    importanceRank: edge.importanceRank,
    contested: edge.contested,
    chronologyStatus: edge.chronologyStatus,
    label: edge.relationType,
  };
}

/** React Flow node data for a store node (strips store-only fields). */
export function toHistoryNodeData(node: NodeData): HistoryNodeData {
  return {
    id: node.id,
    label: node.label,
    nodeType: node.nodeType,
    brief: node.brief,
    wikidataQid: node.wikidataQid,
    dateStartYear: node.dateStartYear,
    dateStartPrecision: node.dateStartPrecision,
    upstreamState: node.upstreamState,
    downstreamState: node.downstreamState,
    isRoot: node.isRoot,
  };
}

/** React Flow edge data for a store edge. */
export function toHistoryEdgeData(edge: EdgeData): HistoryEdgeData {
  return {
    id: edge.id,
    label: edge.label,
    relationType: edge.relationType,
    importanceRank: edge.importanceRank,
    contested: edge.contested,
    chronologyStatus: edge.chronologyStatus,
  };
}
