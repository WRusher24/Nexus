'use client';

/**
 * Custom React Flow edge (M9, Part 3.4).
 *
 * A labeled edge: relation type on a white pill at the midpoint, arrow head at
 * the target, line thickness by importance rank, and an orange dashed style for
 * contested connections. Clicking selects the edge for the side panel.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import { useGraphStore } from '@/lib/frontend/store';
import { formatRelationType, type HistoryEdgeData } from '@/lib/frontend/types';

export type HistoryEdgeType = Edge<HistoryEdgeData, 'history'>;

function strokeWidth(importanceRank: number): number {
  if (importanceRank <= 3) return 2;
  if (importanceRank <= 6) return 1.5;
  return 1;
}

export default function HistoryEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<HistoryEdgeType>) {
  const selectEdge = useGraphStore((store) => store.selectEdge);
  const contested = data?.contested ?? false;
  const importanceRank = data?.importanceRank ?? 5;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: contested ? '#fb923c' : selected ? '#2563eb' : '#9ca3af',
          strokeWidth: strokeWidth(importanceRank),
          strokeDasharray: contested ? '6 3' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          data-testid="edge-label"
          onClick={(event) => {
            event.stopPropagation();
            selectEdge(id);
          }}
          className="nodrag nopan absolute cursor-pointer rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[10px] text-gray-600 shadow-sm hover:border-blue-400 hover:text-blue-700"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          {formatRelationType(data?.relationType ?? '')}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
