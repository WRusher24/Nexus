'use client';

/**
 * Search bar (M9, Part 2.1). Debounced submit against `GET /api/search`; the
 * candidate list is rendered below it. `compact` fits the bar into the graph
 * view's top-left corner for starting a new search.
 */

import { useRef, useState } from 'react';
import { ApiError, api } from '@/lib/frontend/api';
import type { DisambiguationCandidate } from '@/lib/frontend/types';
import CandidateList from './CandidateList';

interface SearchBarProps {
  onPick: (candidate: DisambiguationCandidate) => void;
  compact?: boolean;
}

const DEBOUNCE_MS = 300;

export default function SearchBar({ onPick, compact = false }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<DisambiguationCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const lastSearchAt = useRef(0);

  const runSearch = async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    const now = Date.now();
    if (now - lastSearchAt.current < DEBOUNCE_MS) return;
    lastSearchAt.current = now;

    setLoading(true);
    setError(null);
    try {
      const result = await api.search(trimmed);
      setCandidates(result.candidates);
      setSearched(true);
    } catch (err) {
      setCandidates([]);
      setSearched(true);
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={compact ? 'w-80' : 'w-full max-w-xl'}>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <input
          data-testid="search-input"
          type="text"
          value={query}
          placeholder="Search a historical topic…"
          onChange={(event) => setQuery(event.target.value)}
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="submit"
          data-testid="search-button"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

      {searched || candidates.length > 0 ? (
        <div className={compact ? 'mt-2 max-h-[60vh] overflow-y-auto' : 'mt-4'}>
          <CandidateList candidates={candidates} onPick={onPick} busy={loading} />
        </div>
      ) : null}
    </div>
  );
}
