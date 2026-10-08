'use client';

/**
 * Colored dot + label reflecting a node's expansion state for one direction
 * (M9, Part 2.2). Green = expanded, blue = sparse, yellow = loading/queued,
 * red = failed, gray = unexpanded.
 */

import { expansionStateColor, expansionStateLabel } from '@/lib/frontend/types';

interface NodeStateBadgeProps {
  state: string;
  /** Show the text label next to the dot (side panel); default is dot only. */
  showLabel?: boolean;
  className?: string;
}

export default function NodeStateBadge({
  state,
  showLabel = false,
  className = '',
}: NodeStateBadgeProps) {
  const label = expansionStateLabel(state);
  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      title={label}
      data-testid="expansion-state-badge"
      data-state={state}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${expansionStateColor(state)}`}
        aria-hidden="true"
      />
      {showLabel ? (
        <span className="text-xs text-gray-600">{label}</span>
      ) : null}
    </span>
  );
}
