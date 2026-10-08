'use client';

/**
 * React Flow canvas (M9, Part 3.1).
 *
 * Converts the Zustand graph into React Flow nodes/edges. Positions come from
 * ELK (`computeLayout`) and are recomputed when the node/edge *set* changes or
 * the user clicks "Re-layout" — not on every drag, so manual positioning
 * survives until the next layout. Node/edge *data* is synced from the store on
 * every change so state badges update without a re-layout.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { computeLayout } from '@/lib/frontend/layout';
import {
  toHistoryEdgeData,
  toHistoryNodeData,
  useGraphStore,
} from '@/lib/frontend/store';
import HistoryEdge, { type HistoryEdgeType } from './HistoryEdge';
import HistoryNode, { type HistoryNodeType } from './HistoryNode';
import GraphControls from './GraphControls';

const nodeTypes = { history: HistoryNode } as unknown as NodeTypes;
const edgeTypes = { history: HistoryEdge } as unknown as EdgeTypes;

export default function GraphCanvas() {
  const storeNodes = useGraphStore((store) => store.nodes);
  const storeEdges = useGraphStore((store) => store.edges);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<HistoryNodeType>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<HistoryEdgeType>([]);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const instanceRef = useRef<ReactFlowInstance<HistoryNodeType, HistoryEdgeType> | null>(
    null,
  );

  const nodeSignature = useMemo(
    () => storeNodes.map((node) => node.id).sort().join('|'),
    [storeNodes],
  );
  const edgeSignature = useMemo(
    () => storeEdges.map((edge) => edge.id).sort().join('|'),
    [storeEdges],
  );

  // ── Layout: recompute when the set of nodes/edges changes or on demand. ──
  useEffect(() => {
    let cancelled = false;
    const { nodes, edges } = useGraphStore.getState();
    void computeLayout(nodes, edges).then((positioned) => {
      if (cancelled) return;
      setRfNodes(
        positioned.map((node) => ({
          id: node.id,
          type: 'history' as const,
          position: { x: node.x, y: node.y },
          data: toHistoryNodeData(node),
        })),
      );
      setRfEdges(
        edges.map((edge) => ({
          id: edge.id,
          type: 'history' as const,
          source: edge.source,
          target: edge.target,
          data: toHistoryEdgeData(edge),
        })),
      );
      window.requestAnimationFrame(() => {
        void instanceRef.current?.fitView({ padding: 0.2 });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [nodeSignature, edgeSignature, layoutNonce, setRfNodes, setRfEdges]);

  // ── Data sync: update badge/label data without touching positions. ──
  useEffect(() => {
    setRfNodes((current) =>
      current.map((node) => {
        const storeNode = storeNodes.find((candidate) => candidate.id === node.id);
        return storeNode ? { ...node, data: toHistoryNodeData(storeNode) } : node;
      }),
    );
  }, [storeNodes, setRfNodes]);

  useEffect(() => {
    setRfEdges((current) =>
      current.map((edge) => {
        const storeEdge = storeEdges.find((candidate) => candidate.id === edge.id);
        return storeEdge ? { ...edge, data: toHistoryEdgeData(storeEdge) } : edge;
      }),
    );
  }, [storeEdges, setRfEdges]);

  const onNodeClick = useCallback((_event: unknown, node: { id: string }) => {
    useGraphStore.getState().selectNode(node.id);
  }, []);

  const onEdgeClick = useCallback((_event: unknown, edge: { id: string }) => {
    useGraphStore.getState().selectEdge(edge.id);
  }, []);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      onInit={(instance) => {
        instanceRef.current = instance;
      }}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      minZoom={0.2}
      maxZoom={2}
      defaultEdgeOptions={{ type: 'history' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls />
      <GraphControls onRelayout={() => setLayoutNonce((value) => value + 1)} />
    </ReactFlow>
  );
}
