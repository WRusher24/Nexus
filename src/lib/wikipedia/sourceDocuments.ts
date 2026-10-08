/**
 * Source document caching (Milestone 5, Amendment A11).
 *
 * A SourceDocument is an immutable, revision-pinned snapshot of a Wikipedia
 * article. The cache key is (wikipediaPageId, revisionId): multiple revisions
 * of the same page coexist in the database, and existing rows are never
 * updated. New content always produces a new row (invariant P4).
 */

import { and, desc, eq } from 'drizzle-orm';
import { sourceDocuments } from '../db/schema';
import type { SectionIndexEntry } from '../db/schema';
import type { Database } from '../graph/types';
import type { WikipediaClient } from './wikipediaClient';

export interface CachedSourceDocument {
  id: string;
  wikipediaPageId: number;
  wikipediaTitle: string;
  revisionId: number;
  rawText: string;
  contentHash: string;
  sectionIndex: SectionIndexEntry[];
  languageCode: string;
}

export interface SourceDocumentService {
  fetchAndStore(pageId: number): Promise<CachedSourceDocument>;
  getByRevision(
    pageId: number,
    revisionId: number,
  ): Promise<CachedSourceDocument | null>;
  getLatest(pageId: number): Promise<CachedSourceDocument | null>;
}

export interface SourceDocumentServiceOptions {
  db: Database;
  wikipedia: WikipediaClient;
}

type SourceDocumentRow = typeof sourceDocuments.$inferSelect;

function mapRow(row: SourceDocumentRow): CachedSourceDocument {
  return {
    id: row.id,
    wikipediaPageId: row.wikipediaPageId,
    wikipediaTitle: row.wikipediaTitle,
    revisionId: row.revisionId,
    rawText: row.rawText,
    contentHash: row.contentHash,
    sectionIndex: row.sectionIndex,
    languageCode: row.languageCode,
  };
}

export function createSourceDocumentService(
  options: SourceDocumentServiceOptions,
): SourceDocumentService {
  const { db, wikipedia } = options;

  async function getByRevision(
    pageId: number,
    revisionId: number,
  ): Promise<CachedSourceDocument | null> {
    const [row] = await db
      .select()
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.wikipediaPageId, pageId),
          eq(sourceDocuments.revisionId, revisionId),
        ),
      )
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async function getLatest(pageId: number): Promise<CachedSourceDocument | null> {
    const [row] = await db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.wikipediaPageId, pageId))
      .orderBy(desc(sourceDocuments.fetchedAt), desc(sourceDocuments.revisionId))
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async function fetchAndStore(pageId: number): Promise<CachedSourceDocument> {
    const article = await wikipedia.fetchArticleByPageId(pageId);

    const existing = await getByRevision(pageId, article.revisionId);
    if (existing) return existing;

    const inserted = await db
      .insert(sourceDocuments)
      .values({
        wikipediaPageId: article.pageId,
        wikipediaTitle: article.title,
        revisionId: article.revisionId,
        rawText: article.plainText,
        contentHash: article.contentHash,
        sectionIndex: article.sections,
        languageCode: article.languageCode,
      })
      .onConflictDoNothing({
        target: [sourceDocuments.wikipediaPageId, sourceDocuments.revisionId],
      })
      .returning();

    const row = inserted[0];
    if (row) return mapRow(row);

    // Lost a race: a concurrent insert won. Re-read.
    const raced = await getByRevision(pageId, article.revisionId);
    if (raced) return raced;
    throw new Error(
      'fetchAndStore: insert was skipped by a conflict but no existing row was found',
    );
  }

  return { fetchAndStore, getByRevision, getLatest };
}
