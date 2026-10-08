/**
 * Shared types for section-aware article chunking.
 *
 * Offsets are UTF-16 code-unit indices into `rawText`, matching the offsets
 * recorded on SourceDocument.sectionIndex and EvidenceSpan.
 */

/**
 * A section descriptor as stored in SourceDocument.sectionIndex.
 * Offsets are into the sourceDocument.rawText.
 */
export interface SectionInfo {
  title: string;
  startOffset: number;
  endOffset: number;
}

export type Direction = 'UPSTREAM' | 'DOWNSTREAM';

/**
 * Canonical entity type used by the Wikipedia/Wikidata layer. Mirrors the
 * `node_type` database enum and the `NodeType` union in `graph/types.ts`.
 *
 * It is redeclared here (rather than imported from graph) so this module stays
 * a leaf with no dependency on the graph write path.
 */
export type EntityType =
  | 'EVENT'
  | 'PROCESS'
  | 'POLICY'
  | 'ACTOR'
  | 'IDEOLOGY'
  | 'INSTITUTION'
  | 'TECHNOLOGY'
  | 'PLACE';

/** Confidence tier produced by the QID resolver. */
export type ResolverConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/**
 * A chunk is a contiguous slice of the article's rawText that will be sent
 * to the LLM. Offsets are into the original rawText so quote verification
 * can work against the sent chunks.
 */
export interface Chunk {
  sectionTitle: string;
  text: string;
  startOffset: number;
  endOffset: number;
  /** Lower = higher priority. 1 = lead, 10 = direction-relevant, 20 = history/overview, 50 = other. */
  priority: number;
}
