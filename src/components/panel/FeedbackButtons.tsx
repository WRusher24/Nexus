'use client';

/**
 * Feedback buttons (M9, Part 4.3).
 *
 * The M8 feedback enum only models negative signals
 * (INCORRECT / MISSING / DUPLICATE / SPAM) — there is no "CORRECT" type and
 * M8 routes must not be modified. So 👎 records INCORRECT server-side (which
 * feeds the auto-hide rule) and 👍 is a local-only acknowledgement. Both
 * disable after one submission.
 */

import { useState } from 'react';
import { ApiError, api } from '@/lib/frontend/api';

interface FeedbackButtonsProps {
  edgeId: string;
}

type SubmitState = 'idle' | 'submitting' | 'done';

export default function FeedbackButtons({ edgeId }: FeedbackButtonsProps) {
  const [state, setState] = useState<SubmitState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (correct: boolean) => {
    if (state !== 'idle') return;
    if (correct) {
      setState('done');
      setMessage('Thanks for confirming this connection.');
      return;
    }
    setState('submitting');
    try {
      const result = await api.submitFeedback(edgeId, 'INCORRECT');
      setState('done');
      setMessage(
        result.autoHidden
          ? 'This edge has been hidden based on community feedback.'
          : 'Thanks for your feedback.',
      );
    } catch (error) {
      setState('idle');
      setMessage(
        error instanceof ApiError ? error.message : 'Could not submit feedback.',
      );
    }
  };

  return (
    <div data-testid="feedback-buttons" className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="feedback-up"
          disabled={state !== 'idle'}
          onClick={() => void onSubmit(true)}
          className="rounded border border-gray-200 bg-white px-2 py-1 text-sm shadow-sm hover:bg-green-50 disabled:opacity-50"
          title="This connection is correct"
        >
          👍
        </button>
        <button
          type="button"
          data-testid="feedback-down"
          disabled={state !== 'idle'}
          onClick={() => void onSubmit(false)}
          className="rounded border border-gray-200 bg-white px-2 py-1 text-sm shadow-sm hover:bg-red-50 disabled:opacity-50"
          title="This connection is incorrect"
        >
          👎
        </button>
        <span className="text-xs text-gray-500">
          {state === 'submitting' ? 'Submitting…' : 'Was this connection helpful?'}
        </span>
      </div>
      {message ? <p className="text-xs text-gray-600">{message}</p> : null}
    </div>
  );
}
