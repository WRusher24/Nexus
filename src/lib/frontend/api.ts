/**
 * Typed API client for the M8 HTTP surface (M9, Part 1.3).
 *
 * A thin `fetch` wrapper that:
 *   - always sends the session cookie (`credentials: 'include'`),
 *   - parses the typed `{ error, message, detail }` body on non-2xx and throws
 *     an `ApiError`,
 *   - returns typed JSON for each endpoint.
 *
 * The UI layer catches `ApiError` and shows a user-friendly message; it never
 * sees a raw `Response`.
 */

import type {
  CreateRootNodeResponse,
  DisambiguationCandidate,
  EdgeDetailResponse,
  ExpansionDirection,
  ExpansionResponse,
  ExpansionStatusResponse,
  FeedbackResponse,
  NodeNeighborhoodResponse,
  QuotaResponse,
  SearchResponse,
  TraversalResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  detail?: unknown;
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error body (e.g. a proxy 502). Fall back to the status text.
  }
  return new ApiError(
    response.status,
    body.error ?? 'HTTP_ERROR',
    body.message ?? response.statusText ?? 'Request failed',
    body.detail,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers,
  });

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export const api = {
  search: (query: string, limit = 5): Promise<SearchResponse> =>
    request<SearchResponse>(
      `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  createRootNode: (
    candidate: DisambiguationCandidate,
  ): Promise<CreateRootNodeResponse> =>
    request<CreateRootNodeResponse>('/api/root-nodes', {
      method: 'POST',
      body: jsonBody(candidate),
    }),

  getNode: (nodeId: string, limit = 10): Promise<NodeNeighborhoodResponse> =>
    request<NodeNeighborhoodResponse>(`/api/nodes/${nodeId}?limit=${limit}`),

  getAncestors: (nodeId: string, depth = 2): Promise<TraversalResponse> =>
    request<TraversalResponse>(`/api/nodes/${nodeId}/ancestors?depth=${depth}`),

  getDescendants: (nodeId: string, depth = 2): Promise<TraversalResponse> =>
    request<TraversalResponse>(
      `/api/nodes/${nodeId}/descendants?depth=${depth}`,
    ),

  requestExpansion: (
    nodeId: string,
    direction: ExpansionDirection,
  ): Promise<ExpansionResponse> =>
    request<ExpansionResponse>('/api/expansions', {
      method: 'POST',
      body: jsonBody({ nodeId, direction }),
    }),

  getExpansionStatus: (requestId: string): Promise<ExpansionStatusResponse> =>
    request<ExpansionStatusResponse>(`/api/expansions/${requestId}`),

  getEdge: (edgeId: string): Promise<EdgeDetailResponse> =>
    request<EdgeDetailResponse>(`/api/edges/${edgeId}`),

  submitFeedback: (
    edgeId: string,
    type: 'INCORRECT' | 'MISSING' | 'DUPLICATE' | 'SPAM',
    note?: string,
  ): Promise<FeedbackResponse> =>
    request<FeedbackResponse>(`/api/edges/${edgeId}/feedback`, {
      method: 'POST',
      body: jsonBody(note === undefined ? { type } : { type, note }),
    }),

  getQuota: (): Promise<QuotaResponse> => request<QuotaResponse>('/api/quota'),
};
