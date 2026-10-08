/**
 * Zod schemas for the LLM extraction output contract (blueprint Deliverable C,
 * with Amendment A1 applied: no ROOT_TOPIC, no DEPTH, no depth-penalty block).
 *
 * These schemas define TYPES ONLY. Validation/orchestration of the extraction
 * pipeline (quote verification, chronology, insertion) is a later milestone.
 *
 * The enums below MUST exactly match the Drizzle pgEnums in
 * `src/lib/db/schema.ts`. `enum-parity.test.ts` asserts equality and will fail
 * loudly if one side changes without the other.
 */

import { z } from 'zod';

/**
 * Schema version. Bump when the shape changes. The current version is also
 * recorded on every ExtractionRun.
 */
export const EXTRACTION_SCHEMA_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// Enums (must match schema.ts pgEnums)
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `nodeTypeEnum`. */
export const EntityTypeEnum = z.enum([
  'EVENT',
  'PROCESS',
  'POLICY',
  'ACTOR',
  'IDEOLOGY',
  'INSTITUTION',
  'TECHNOLOGY',
  'PLACE',
]);

/** Mirrors `relationTypeEnum`. */
export const RelationTypeEnum = z.enum([
  'CAUSED',
  'CONTRIBUTED_TO',
  'ENABLED',
  'TRIGGERED',
  'PREVENTED',
  'INFLUENCED',
]);

/** Mirrors `datePrecisionEnum`. */
export const DatePrecisionEnum = z.enum([
  'DAY',
  'MONTH',
  'YEAR',
  'DECADE',
  'CENTURY',
  'MILLENNIUM',
  'UNKNOWN',
]);

/** Mirrors `directionEnum`. */
export const DirectionEnum = z.enum(['UPSTREAM', 'DOWNSTREAM']);

// ─────────────────────────────────────────────────────────────────────────────
// Object schemas
// ─────────────────────────────────────────────────────────────────────────────

export const DateFieldSchema = z
  .object({
    year: z.number().int().nullable(),
    month: z.number().int().min(1).max(12).nullable(),
    day: z.number().int().min(1).max(31).nullable(),
    precision: DatePrecisionEnum,
  })
  .strict();

export const DisambiguationHintSchema = z
  .object({
    description: z.string().max(100),
    approximateDateRange: z.string().max(30),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    verbatimQuote: z.string().min(10).max(1000),
    sectionTitle: z.string(),
  })
  .strict();

export const RelatedEntitySchema = z
  .object({
    name: z.string().min(1).max(200),
    entityType: EntityTypeEnum,
    dateStart: DateFieldSchema,
    dateEnd: DateFieldSchema,
    brief: z.string().max(200).optional(),
    disambiguationHint: DisambiguationHintSchema,
  })
  .strict();

export const EdgeSchema = z
  .object({
    relatedEntity: RelatedEntitySchema,
    relationType: RelationTypeEnum,
    importanceRank: z.number().int().min(1).max(10),
    contested: z.boolean(),
    evidence: EvidenceSchema,
  })
  .strict();

export const FocalEntitySchema = z
  .object({
    name: z.string().min(1).max(200),
    entityType: EntityTypeEnum,
    dateStart: DateFieldSchema,
    dateEnd: DateFieldSchema,
    brief: z.string().max(200).optional(),
  })
  .strict();

export const MetadataSchema = z
  .object({
    sparsenessReason: z.string().max(200).nullable(),
    feedbackLoopsDecomposed: z.boolean(),
  })
  .strict();

export const ExtractionOutputSchema = z
  .object({
    focalEntity: FocalEntitySchema,
    direction: DirectionEnum,
    edges: z.array(EdgeSchema).max(12),
    metadata: MetadataSchema,
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types
// ─────────────────────────────────────────────────────────────────────────────

export type DateField = z.infer<typeof DateFieldSchema>;
export type DisambiguationHint = z.infer<typeof DisambiguationHintSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type RelatedEntity = z.infer<typeof RelatedEntitySchema>;
export type ProposedEdge = z.infer<typeof EdgeSchema>;
export type FocalEntity = z.infer<typeof FocalEntitySchema>;
export type ExtractionMetadata = z.infer<typeof MetadataSchema>;
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;
