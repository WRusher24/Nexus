'use client';

/**
 * Side panel (M9, Part 4.1).
 *
 * Shows details for the selected node or edge. For an edge it lazily fetches
 * `GET /api/edges/{id}` (with evidence spans) and renders an `EvidenceCard` per
 * span plus `FeedbackButtons`.
 */

import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/frontend/api';
import { useGraphStore } from '@/lib/frontend/store';
import {
  formatDate,
  formatRelationType,
  nodeTypeBadgeClass,
  type EdgeDetailResponse,
} from '@/lib/frontend/types';
import EvidenceCard from './EvidenceCard';
import FeedbackButtons from './FeedbackButtons';
import NodeStateBadge from '../graph/NodeStateBadge';

const EXPANSION_DONE = new Set(['EXPANDED', 'SPARSE']);

function ImportanceBar({ rank }: { rank: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`Importance ${rank}/10`}>
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          className={`h-2 w-1.5 rounded-sm ${
            index < rank ? 'bg-blue-500' : 'bg-gray-200'
          }`}
        />
      ))}
      <span className="ml-1 text-xs text-gray-500">{rank}/10</span>
    </span>
  );
}

export default function SidePanel() {
  const selectedNodeId = useGraphStore((store) => store.selectedNodeId);
  const selectedEdgeId = useGraphStore((store) => store.selectedEdgeId);
  const nodes = useGraphStore((store) => store.nodes);
  const edges = useGraphStore((store) => store.edges);
  const selectNode = useGraphStore((store) => store.selectNode);
  const selectEdge = useGraphStore((store) => store.selectEdge);
  const expandHandler = useGraphStore((store) => store.expandHandler);

  const [edgeDetail, setEdgeDetail] = useState<EdgeDetailResponse | null>(null);
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [edgeError, setEdgeError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedEdgeId) {
      setEdgeDetail(null);
      setEdgeError(null);
      return;
    }
    let cancelled = false;
    setEdgeLoading(true);
    setEdgeError(null);
    void api
      .getEdge(selectedEdgeId)
      .then((detail) => {
        if (cancelled) return;
        setEdgeDetail(detail);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setEdgeError(
          error instanceof ApiError ? error.message : 'Could not load evidence.',
        );
      })
      .finally(() => {
        if (!cancelled) setEdgeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEdgeId]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const connectedEdges = useMemo(() => {
    if (!selectedNodeId) return [];
    return edges.filter(
      (edge) => edge.source === selectedNodeId || edge.target === selectedNodeId,
    );
  }, [edges, selectedNodeId]);

  if (!selectedNodeId && !selectedEdgeId) return null;

  return (
    <aside
      data-testid="side-panel"
      className="absolute right-0 top-0 z-20 flex h-full w-80 flex-col border-l border-gray-200 bg-white shadow-lg"
    >
      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-800">
          {selectedNode ? 'Node details' : 'Connection details'}
        </h2>
        <button
          type="button"
          aria-label="Close panel"
          className="rounded p-1 text-gray-500 hover:bg-gray-100"
          onClick={() => {
            selectNode(null);
            selectEdge(null);
          }}
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {selectedNode ? (
          <>
            <div>
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${nodeTypeBadgeClass(
                  selectedNode.nodeType,
                )}`}
              >
                {selectedNode.nodeType}
              </span>
              <h3 className="mt-1 text-lg font-bold text-gray-900">
                {selectedNode.label}
              </h3>
              {formatDate(
                selectedNode.dateStartYear,
                selectedNode.dateStartPrecision,
              ) ? (
                <p className="text-xs text-gray-500">
                  {formatDate(
                    selectedNode.dateStartYear,
                    selectedNode.dateStartPrecision,
                  )}
                </p>
              ) : null}
            </div>

            {selectedNode.brief ? (
              <p className="text-gray-700">{selectedNode.brief}</p>
            ) : null}

            {selectedNode.wikidataQid ? (
              <a
                href={`https://www.wikidata.org/wiki/${selectedNode.wikidataQid}`}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-xs text-blue-600 hover:underline"
              >
                {selectedNode.wikidataQid} on Wikidata ↗
              </a>
            ) : null}

            <section className="space-y-2 border-t border-gray-100 pt-3">
              {(['UPSTREAM', 'DOWNSTREAM'] as const).map((direction) => {
                const state =
                  direction === 'UPSTREAM'
                    ? selectedNode.upstreamState
                    : selectedNode.downstreamState;
                const done = EXPANSION_DONE.has(state);
                return (
                  <div
                    key={direction}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="flex items-center gap-2 text-xs text-gray-600">
                      <NodeStateBadge state={state} showLabel />
                      {direction === 'UPSTREAM' ? 'Causes' : 'Effects'}
                    </span>
                    {!done ? (
                      <button
                        type="button"
                        className="rounded border border-gray-200 px-2 py-0.5 text-xs hover:bg-gray-50"
                        onClick={() => expandHandler?.(selectedNode.id, direction)}
                      >
                        Expand
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </section>

            {connectedEdges.length > 0 ? (
              <section className="border-t border-gray-100 pt-3">
                <h4 className="mb-1 text-xs font-semibold uppercase text-gray-500">
                  Connections
                </h4>
                <ul className="space-y-1">
                  {connectedEdges.map((edge) => {
                    const otherId =
                      edge.source === selectedNode.id ? edge.target : edge.source;
                    const other = nodes.find((node) => node.id === otherId);
                    const outgoing = edge.source === selectedNode.id;
                    return (
                      <li key={edge.id}>
                        <button
                          type="button"
                          className="w-full rounded px-1 py-1 text-left text-xs hover:bg-gray-50"
                          onClick={() => selectEdge(edge.id)}
                        >
                          <span className="text-gray-400">
                            {outgoing ? '→ ' : '← '}
                          </span>
                          <span className="text-gray-700">
                            {formatRelationType(edge.relationType)}
                          </span>{' '}
                          <span className="font-medium text-gray-900">
                            {other?.label ?? 'Unknown'}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}

        {selectedEdgeId ? (
          <>
            {edgeLoading ? (
              <p className="text-xs text-gray-500">Loading evidence…</p>
            ) : null}
            {edgeError ? (
              <p className="text-xs text-red-600">{edgeError}</p>
            ) : null}
            {edgeDetail ? (
              <>
                <div>
                  <p className="text-xs text-gray-500">
                    {edgeDetail.edge.causeLabel ?? 'Unknown'} →{' '}
                    {edgeDetail.edge.effectLabel ?? 'Unknown'}
                  </p>
                  <h3 className="mt-1 text-base font-bold text-gray-900">
                    {formatRelationType(edgeDetail.edge.relationType)}
                  </h3>
                </div>

                <div className="space-y-1 text-xs text-gray-600">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-500">Importance</span>
                    <ImportanceBar rank={edgeDetail.edge.importanceRank} />
                  </div>
                  <div>
                    <span className="font-medium text-gray-500">Chronology: </span>
                    {edgeDetail.edge.chronologyStatus}
                  </div>
                  <div>
                    <span className="font-medium text-gray-500">Status: </span>
                    {edgeDetail.edge.status}
                  </div>
                </div>

                {edgeDetail.edge.contested ? (
                  <p className="flex items-center gap-1 rounded bg-orange-50 p-2 text-xs text-orange-800">
                    ⚠️ Historians debate this connection
                  </p>
                ) : null}

                <section className="space-y-2 border-t border-gray-100 pt-3">
                  <h4 className="text-xs font-semibold uppercase text-gray-500">
                    Evidence
                  </h4>
                  {edgeDetail.evidence.length === 0 ? (
                    <p className="text-xs text-gray-500">
                      No evidence spans recorded.
                    </p>
                  ) : (
                    edgeDetail.evidence.map((span) => (
                      <EvidenceCard key={span.id} evidence={span} />
                    ))
                  )}
                </section>

                <section className="border-t border-gray-100 pt-3">
                  <FeedbackButtons edgeId={edgeDetail.edge.id} />
                </section>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}
