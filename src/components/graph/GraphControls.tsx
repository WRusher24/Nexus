'use client';

/**
 * Graph controls (M9, Part 3.1): zoom in/out, fit to view, and force a fresh
 * ELK layout. Rendered as a React Flow `Panel` so it floats over the canvas.
 */

import { Panel, useReactFlow } from '@xyflow/react';

interface GraphControlsProps {
  onRelayout: () => void;
}

const BUTTON_CLASS =
  'flex h-8 w-8 items-center justify-center rounded border border-gray-200 bg-white text-sm text-gray-700 shadow-sm hover:bg-gray-50';

export default function GraphControls({ onRelayout }: GraphControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <Panel position="bottom-right" className="!m-2 flex gap-1">
      <button
        type="button"
        className={BUTTON_CLASS}
        title="Zoom in"
        onClick={() => void zoomIn()}
      >
        +
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        title="Zoom out"
        onClick={() => void zoomOut()}
      >
        −
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        title="Fit to view"
        onClick={() => void fitView({ padding: 0.2 })}
      >
        ⤢
      </button>
      <button
        type="button"
        data-testid="relayout-button"
        className={`${BUTTON_CLASS} w-auto px-2 text-xs`}
        title="Re-run layout"
        onClick={onRelayout}
      >
        Re-layout
      </button>
    </Panel>
  );
}
