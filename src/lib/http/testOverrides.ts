/**
 * Test-only dependency overrides for API routes (M8).
 *
 * Next.js validates that a `route.ts` module only exports HTTP handlers and a
 * small set of route options, so the test hooks cannot live on the route
 * module itself. They live here instead; routes consult these getters, and
 * tests install fixture-backed services through the setters.
 *
 * Every override is null in production, so the real factories run.
 */

import type { Database } from '../graph/types';
import type { SourceDocumentService } from '../wikipedia/sourceDocuments';
import type { WikidataClient } from '../wikipedia/wikidataClient';
import type { SearchService } from '../wikipedia/search';

export interface RootNodeDeps {
  sourceDocuments: SourceDocumentService;
  wikidata: WikidataClient;
}

let db: Database | null = null;
let searchService: SearchService | null = null;
let rootNodeDeps: RootNodeDeps | null = null;

// ── Database ──
export function __setDbForTests(value: Database): void {
  db = value;
}
export function getDbOverride(): Database | null {
  return db;
}
export function __resetDbForTests(): void {
  db = null;
}

// ── Search service ──
export function __setSearchServiceForTests(value: SearchService | null): void {
  searchService = value;
}
export function getSearchServiceOverride(): SearchService | null {
  return searchService;
}

// ── Root-node dependencies ──
export function __setRootNodeDepsForTests(value: RootNodeDeps | null): void {
  rootNodeDeps = value;
}
export function getRootNodeDepsOverride(): RootNodeDeps | null {
  return rootNodeDeps;
}
