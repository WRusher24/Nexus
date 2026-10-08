/**
 * Orchestrator I/O types (Milestone 6).
 *
 * `runExtraction` is a plain async function: give it a focal node and a
 * direction, get an outcome. It knows nothing about queues, workers, HTTP,
 * quotas, or node state transitions — those are M7/M8 concerns.
 */

import type { Resolver } from '@/lib/wikipedia/qidResolver';
import type { SourceDocumentService } from '@/lib/wikipedia/sourceDocuments';
import type { WikidataClient } from '@/lib/wikipedia/wikidataClient';
import type { WikipediaClient } from '@/lib/wikipedia/wikipediaClient';
import type { Direction } from '@/lib/wikipedia/types';
import type { LlmProvider } from './provider';

export interface ExtractionConfig {
  provider: LlmProvider;
  sourceDocumentService: SourceDocumentService;
  resolver: Resolver;
  wikipedia: WikipediaClient;
  wikidata: WikidataClient;
}

export interface RunExtractionInput {
  focalNodeId: string;
  direction: Direction;
}

export type RunExtractionResult =
  | {
      outcome: 'COMPLETED';
      extractionRunId: string;
      finalState: 'EXPANDED' | 'SPARSE';
      edgesProposed: number;
      edgesAccepted: number;
      edgesRejected: number;
      /** Actual (provider-estimated) cost in USD, reconciled against budget. */
      estimatedCostUsd: number;
    }
  | {
      outcome: 'ABORTED_BUDGET';
      reason: string;
    }
  | {
      outcome: 'ABORTED_NO_SOURCE';
      reason: string;
    }
  | {
      outcome: 'FAILED';
      extractionRunId: string | null;
      stage: 'FETCH' | 'LLM' | 'VALIDATION' | 'PERSISTENCE';
      error: string;
      retryable: boolean;
    };
