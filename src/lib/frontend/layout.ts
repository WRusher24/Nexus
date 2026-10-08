'use client';

/**
 * ELK layout (M9, Part 3.3).
 *
 * Computes node positions with ELK's layered (Sugiyama) algorithm so that the
 * causal graph reads left-to-right: causes on the left, effects on the right.
 * ELK is imported as the bundled build so it runs in the browser without a
 * separate worker file.
 *
 * Pure with respect to store state: callers pass arrays in, get positions out,
 * and merge them into React Flow nodes. Re-run on initial load, after an
 * expansion changes the node/edge set, and on the "Re-layout" control — but
 * NOT on every drag, so manual positioning survives until the next layout.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { EdgeData, NodeData } from './store';
import type { PositionedNode } from './types';

const elk = new ELK();

/** Fixed card width from the visual spec. */
export const NODE_WIDTH = 220;
/** Conservative height estimate used only for layout spacing. */
export const NODE_HEIGHT = 130;

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '30',
  'elk.edgeRouting': 'POLYLINE',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
};

/**
 * Compute positions for all nodes using ELK's layered algorithm. Returns the
 * same nodes with `x`/`y` set. Edges whose endpoints are not present in the
 * node list are ignored (ELK rejects dangling references).
 */
export async function computeLayout(
  nodes: NodeData[],
  edges: EdgeData[],
): Promise<PositionedNode[]> {
  if (nodes.length === 0) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const usableEdges = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: usableEdges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layout = await elk.layout(graph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const child of layout.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }

  return nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    return { ...node, x: position.x, y: position.y };
  });
}
