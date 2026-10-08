'use client';

/**
 * Disambiguation candidate list (M9, Part 2.2). One card per search result,
 * with a QID confidence badge; clicking a card creates the root node.
 */

import type { DisambiguationCandidate } from '@/lib/frontend/types';

interface CandidateListProps {
  candidates: DisambiguationCandidate[];
  onPick: (candidate: DisambiguationCandidate) => void;
  busy?: boolean;
}

function confidenceClass(confidence: string): string {
  switch (confidence) {
    case 'HIGH':
      return 'bg-green-100 text-green-800';
    case 'MEDIUM':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

export default function CandidateList({
  candidates,
  onPick,
  busy = false,
}: CandidateListProps) {
  if (candidates.length === 0) {
    return <p className="text-sm text-gray-500">No results found.</p>;
  }

  return (
    <ul className="space-y-2" data-testid="candidate-list">
      {candidates.map((candidate) => (
        <li key={candidate.pageId}>
          <button
            type="button"
            data-testid="candidate-card"
            disabled={busy}
            onClick={() => onPick(candidate)}
            className="w-full rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm transition hover:border-blue-400 hover:shadow disabled:opacity-60"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold text-gray-900">
                {candidate.title}
              </span>
              {candidate.resolvedQid ? (
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${confidenceClass(
                    candidate.qidConfidence,
                  )}`}
                >
                  {candidate.resolvedQid}
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                  no QID
                </span>
              )}
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-gray-600">
              {candidate.snippet}
            </p>
            <p className="mt-1 text-right text-[10px] text-gray-400">
              {candidate.wordCount.toLocaleString()} words
            </p>
          </button>
        </li>
      ))}
    </ul>
  );
}
