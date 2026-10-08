'use client';

/**
 * Home page (M9, Parts 2.3 & 5).
 *
 * Container + state machine:
 *   1. unauthenticated → sign-in screen
 *   2. authenticated, no root → search + disambiguation
 *   3. root selected → graph canvas + side panel + quota
 *
 * It also owns the expansion flow (the one place that talks to both the
 * expansion endpoint and the SSE stream) and registers it on the store so the
 * custom node handles and the side panel can trigger it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { ApiError, api } from '@/lib/frontend/api';
import { subscribeToExpansion, type SseSubscription } from '@/lib/frontend/sse';
import {
  toEdgeData,
  toNodeData,
  useGraphStore,
  type EdgeData,
  type NodeData,
} from '@/lib/frontend/store';
import type {
  DisambiguationCandidate,
  ExpansionDirection,
  NodeNeighborhoodResponse,
} from '@/lib/frontend/types';
import GraphCanvas from '@/components/graph/GraphCanvas';
import QuotaDisplay from '@/components/panel/QuotaDisplay';
import SidePanel from '@/components/panel/SidePanel';
import SearchBar from '@/components/search/SearchBar';
import SignInButton from '@/components/auth/SignInButton';

function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function neighborhoodToGraph(nb: NodeNeighborhoodResponse): {
  nodes: NodeData[];
  edges: EdgeData[];
} {
  const nodes: NodeData[] = [toNodeData(nb.node)];
  const edges: EdgeData[] = [];
  for (const { edge, node } of [...nb.causes, ...nb.effects]) {
    nodes.push(toNodeData(node));
    edges.push(toEdgeData(edge));
  }
  return { nodes, edges };
}

export default function HomePage() {
  const { status } = useSession();
  const rootNodeId = useGraphStore((store) => store.rootNodeId);
  const error = useGraphStore((store) => store.error);
  const isLoading = useGraphStore((store) => store.isLoading);
  const setError = useGraphStore((store) => store.setError);
  const setLoading = useGraphStore((store) => store.setLoading);
  const setExpandHandler = useGraphStore((store) => store.setExpandHandler);

  const subscriptionsRef = useRef<SseSubscription[]>([]);
  const [booting, setBooting] = useState(false);

  const refreshQuota = useCallback(async () => {
    try {
      const result = await api.getQuota();
      useGraphStore.getState().setQuota({
        remainingToday: result.remainingToday,
        dailyLimit: result.dailyLimit,
      });
    } catch {
      // Quota display is best-effort; the expansion endpoint enforces limits.
    }
  }, []);

  const refreshNeighborhood = useCallback(async (nodeId: string) => {
    const nb = await api.getNode(nodeId);
    const { nodes, edges } = neighborhoodToGraph(nb);
    useGraphStore.getState().addNodesAndEdges(nodes, edges);
  }, []);

  const handleExpand = useCallback(
    async (nodeId: string, direction: ExpansionDirection) => {
      const store = useGraphStore.getState();
      const node = store.nodes.find((candidate) => candidate.id === nodeId);
      const current =
        direction === 'UPSTREAM' ? node?.upstreamState : node?.downstreamState;
      if (
        current === 'EXPANDED' ||
        current === 'SPARSE' ||
        current === 'LOADING' ||
        current === 'QUEUED'
      ) {
        return;
      }

      store.setError(null);
      store.setExpansionState(nodeId, direction, 'LOADING');

      try {
        const result = await api.requestExpansion(nodeId, direction);

        if (result.outcome === 'CACHE_HIT') {
          await refreshNeighborhood(nodeId);
          useGraphStore
            .getState()
            .setExpansionState(nodeId, direction, result.state);
          await refreshQuota();
          return;
        }

        const subscription = subscribeToExpansion(result.requestId, {
          onStatus: () => {
            // The node already shows LOADING; intermediate phases are noise.
          },
          onComplete: ({ finalState }) => {
            void (async () => {
              try {
                await refreshNeighborhood(nodeId);
                const final =
                  finalState === 'SPARSE'
                    ? 'SPARSE'
                    : finalState === 'FAILED'
                      ? 'FAILED'
                      : 'EXPANDED';
                useGraphStore
                  .getState()
                  .setExpansionState(nodeId, direction, final);
                await refreshQuota();
              } catch (err) {
                useGraphStore
                  .getState()
                  .setExpansionState(nodeId, direction, 'FAILED');
                useGraphStore.getState().setError(readableError(err));
              }
            })();
          },
          onError: (message) => {
            useGraphStore
              .getState()
              .setExpansionState(nodeId, direction, 'FAILED');
            useGraphStore.getState().setError(message);
          },
        });

        subscriptionsRef.current.push(subscription);
      } catch (err) {
        useGraphStore.getState().setExpansionState(nodeId, direction, 'FAILED');
        useGraphStore.getState().setError(readableError(err));
      }
    },
    [refreshNeighborhood, refreshQuota],
  );

  useEffect(() => {
    setExpandHandler(handleExpand);
    return () => setExpandHandler(null);
  }, [handleExpand, setExpandHandler]);

  useEffect(() => {
    const subscriptions = subscriptionsRef.current;
    return () => {
      for (const subscription of subscriptions) subscription.close();
      subscriptions.length = 0;
    };
  }, []);

  const handlePick = useCallback(
    async (candidate: DisambiguationCandidate) => {
      setLoading(true);
      setError(null);
      setBooting(true);
      try {
        const created = await api.createRootNode(candidate);
        const nb = await api.getNode(created.nodeId);
        const { nodes, edges } = neighborhoodToGraph(nb);
        const store = useGraphStore.getState();
        const root = nodes.find((node) => node.id === created.nodeId) ?? nodes[0];
        if (root) store.setRootNode(root);
        store.addNodesAndEdges(nodes, edges);
        await refreshQuota();
      } catch (err) {
        setError(readableError(err));
      } finally {
        setLoading(false);
        setBooting(false);
      }
    },
    [refreshQuota, setError, setLoading],
  );

  // ── 1. Loading session ──
  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">Loading…</p>
      </main>
    );
  }

  // ── 2. Unauthenticated ──
  if (status === 'unauthenticated') {
    return (
      <main
        data-testid="sign-in-screen"
        className="flex min-h-screen items-center justify-center bg-gray-50 p-6"
      >
        <div className="w-full max-w-md space-y-4 rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900">Nexus</h1>
          <p className="text-sm text-gray-600">
            Learn history through the causal graph. Sign in to begin.
          </p>
          <SignInButton />
        </div>
      </main>
    );
  }

  // ── 3. Authenticated, no root → search ──
  if (!rootNodeId) {
    return (
      <main className="flex min-h-screen flex-col items-center bg-gray-50 p-6">
        <header className="mb-8 mt-16 text-center">
          <h1 className="text-3xl font-bold text-gray-900">Nexus</h1>
          <p className="mt-2 text-sm text-gray-600">
            Search for a historical event, person, or process to begin.
          </p>
        </header>
        <SearchBar onPick={handlePick} />
        {booting ? (
          <p className="mt-4 text-sm text-gray-500">Building graph…</p>
        ) : null}
        {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
      </main>
    );
  }

  // ── 4. Graph view ──
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-gray-50">
      <div className="absolute left-4 top-4 z-30 w-80">
        <SearchBar compact onPick={handlePick} />
      </div>

      <div className="absolute right-4 top-4 z-30">
        <QuotaDisplay />
      </div>

      <GraphCanvas />

      {isLoading ? (
        <div className="absolute inset-x-0 top-0 z-40 flex justify-center">
          <span className="rounded-b-md bg-blue-600 px-3 py-1 text-xs text-white">
            Working…
          </span>
        </div>
      ) : null}

      {error ? (
        <div
          data-testid="error-toast"
          className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow"
        >
          {error}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </div>
      ) : null}

      <SidePanel />
    </main>
  );
}
