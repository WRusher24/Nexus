'use client';

/**
 * Custom React Flow node — the "audit brief" card (M9, Part 3.2).
 *
 * Ultra-concise: type badge + label + date + one-line brief, with an expansion
 * control per direction. Clicking the body opens the side panel; clicking a
 * control asks the container (via the store's `expandHandler`) to expand.
 */

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useGraphStore } from '@/lib/frontend/store';
import {
  formatDate,
  nodeTypeBadgeClass,
  type HistoryNodeData,
} from '@/lib/frontend/types';
import NodeStateBadge from './NodeStateBadge';

export type HistoryNodeType = Node<HistoryNodeData, 'history'>;

const DONE_STATES = new Set(['EXPANDED', 'SPARSE']);
const BUSY_STATES = new Set(['LOADING', 'QUEUED']);

interface ExpandControlProps {
  nodeId: string;
  direction: 'UPSTREAM' | 'DOWNSTREAM';
  state: string;
}

function ExpandControl({ nodeId, direction, state }: ExpandControlProps) {
  const expandHandler = useGraphStore((store) => store.expandHandler);
  const done = DONE_STATES.has(state);
  const busy = BUSY_STATES.has(state);
  const disabled = done || busy;
  const isUpstream = direction === 'UPSTREAM';
  const testId = `expand-${direction.toLowerCase()}`;

  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      title={
        done
          ? `Already expanded ${isUpstream ? 'upstream' : 'downstream'}`
          : busy
            ? 'Already expanding...'
            : `Expand ${isUpstream ? 'upstream (causes)' : 'downstream (effects)'}`
      }
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        expandHandler?.(nodeId, direction);
      }}
      className={`nodrag flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
        disabled
          ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
          : 'border-gray-300 bg-white text-gray-700 hover:border-blue-400 hover:text-blue-700'
      }`}
    >
      {busy ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
      ) : (
        <span aria-hidden="true">{isUpstream ? '⬆' : '⬇'}</span>
      )}
      <span>{isUpstream ? 'Causes' : 'Effects'}</span>
      <NodeStateBadge state={state} />
    </button>
  );
}

export default function HistoryNode({ data, selected }: NodeProps<HistoryNodeType>) {
  const selectNode = useGraphStore((store) => store.selectNode);
  const dateLabel = formatDate(data.dateStartYear, data.dateStartPrecision);

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="history-node"
      onClick={() => selectNode(data.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') selectNode(data.id);
      }}
      className={`relative w-[220px] rounded-lg border bg-white shadow-sm transition ${
        selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200'
      }`}
    >
      <Handle
        type="target"
        id="upstream"
        position={Position.Left}
        isConnectable={false}
        className="!h-2 !w-2 !border-0 !bg-gray-300"
      />
      <Handle
        type="source"
        id="downstream"
        position={Position.Right}
        isConnectable={false}
        className="!h-2 !w-2 !border-0 !bg-gray-300"
      />

      <div className="flex items-center justify-between gap-1 px-3 pt-2">
        <span
          className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${nodeTypeBadgeClass(
            data.nodeType,
          )}`}
        >
          {data.nodeType}
        </span>
        {data.isRoot ? (
          <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-gray-600">
            Root
          </span>
        ) : null}
      </div>

      <p className="line-clamp-2 px-3 pt-1 text-sm font-semibold text-gray-900">
        {data.label}
      </p>

      {dateLabel ? (
        <p className="px-3 pt-0.5 text-xs text-gray-500">{dateLabel}</p>
      ) : null}

      {data.brief ? (
        <p className="truncate px-3 pb-1 text-xs text-gray-600">{data.brief}</p>
      ) : null}

      <div className="mt-1 flex items-center justify-between gap-1 border-t border-gray-100 px-2 py-1.5">
        <ExpandControl
          nodeId={data.id}
          direction="UPSTREAM"
          state={data.upstreamState}
        />
        <ExpandControl
          nodeId={data.id}
          direction="DOWNSTREAM"
          state={data.downstreamState}
        />
      </div>
    </div>
  );
}
