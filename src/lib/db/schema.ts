import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────────────────────────────────────
// Enums
//
// Table names are camelCase plural (e.g. "evidenceSpans") and columns are
// camelCase (e.g. "causeNodeId") so that the hand-written custom SQL migration
// (CHECK constraints, partial indexes, deferred trigger) can reference them
// exactly as specified in the M2 task brief.
// ─────────────────────────────────────────────────────────────────────────────

export const nodeTypeEnum = pgEnum('node_type', [
  'EVENT',
  'PROCESS',
  'POLICY',
  'ACTOR',
  'IDEOLOGY',
  'INSTITUTION',
  'TECHNOLOGY',
  'PLACE',
]);

export const identitySchemeEnum = pgEnum('identity_scheme', [
  'WIKIDATA',
  'WIKIPEDIA_PAGE',
  'NEXUS_GENERATED',
]);

export const datePrecisionEnum = pgEnum('date_precision', [
  'DAY',
  'MONTH',
  'YEAR',
  'DECADE',
  'CENTURY',
  'MILLENNIUM',
  'UNKNOWN',
]);

export const expansionStateEnum = pgEnum('expansion_state', [
  'UNEXPANDED',
  'QUEUED',
  'LOADING',
  'EXPANDED',
  'SPARSE',
  'FAILED',
]);

export const directionEnum = pgEnum('direction', ['UPSTREAM', 'DOWNSTREAM']);

export const relationTypeEnum = pgEnum('relation_type', [
  'CAUSED',
  'CONTRIBUTED_TO',
  'ENABLED',
  'TRIGGERED',
  'PREVENTED',
  'INFLUENCED',
]);

export const edgeStatusEnum = pgEnum('edge_status', ['ACTIVE', 'SUPERSEDED']);

export const chronologyStatusEnum = pgEnum('chronology_status', [
  'VERIFIED',
  'UNVERIFIED',
  'OVERRIDE',
]);

export const expansionRequestStatusEnum = pgEnum('expansion_request_status', [
  'PENDING',
  'LOCKED',
  'FETCHING',
  'EXTRACTING',
  'VALIDATING',
  'COMPLETED',
  'FAILED',
]);

export const extractionStatusEnum = pgEnum('extraction_status', [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'VERIFIED',
  'OFFSET_SHIFTED',
  'NOT_FOUND',
  'REJECTED',
]);

export const feedbackTypeEnum = pgEnum('feedback_type', [
  'INCORRECT',
  'MISSING',
  'DUPLICATE',
  'SPAM',
]);

// ─────────────────────────────────────────────────────────────────────────────
// JSONB payload shapes (documentation only; columns are typed via $type)
// ─────────────────────────────────────────────────────────────────────────────

/** Entry in SourceDocument.sectionIndex. */
export interface SectionIndexEntry {
  title: string;
  startOffset: number;
  endOffset: number;
}

/** Entry in ExtractionRun.chunksUsed. */
export interface ChunkDescriptor {
  sectionTitle: string;
  startOffset: number;
  endOffset: number;
}

/** Entry in ExtractionRun.rejectionReasons. */
export interface RejectionReason {
  edgeDescription: string;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth.js tables (M8)
//
// Canonical Auth.js v5 + @auth/drizzle-adapter Postgres shapes. Column names are
// exactly what the adapter expects; table names are customised to Nexus
// conventions (the adapter is passed the table objects explicitly, so the
// physical names are irrelevant to it). Sessions are database-backed (not JWT)
// so they can be revoked by deleting a row.
//
// `users.id` is a text primary key defaulting to `gen_random_uuid()::text`; the
// legacy `userId`/`requestedBy` text columns on userQuotas / expansionRequests /
// edgeFeedback now reference it.
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('emailVerified', { withTimezone: true, mode: 'date' }),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const accounts = pgTable(
  'accounts',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable('sessions', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verificationTokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// ─────────────────────────────────────────────────────────────────────────────
// nodes — canonical entities (invariant P1)
// ─────────────────────────────────────────────────────────────────────────────

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Canonical identity (P1). At least one of the three must be set; the
    // chk_node_identity CHECK constraint (custom SQL) enforces this.
    identityScheme: identitySchemeEnum('identityScheme').notNull(),
    wikidataQid: text('wikidataQid').unique(),
    wikipediaPageId: integer('wikipediaPageId'),
    // Deterministic hash fallback for entities with no Wikipedia page.
    nexusGeneratedId: text('nexusGeneratedId').unique(),

    // Display
    label: text('label').notNull(),
    brief: text('brief'),
    nodeType: nodeTypeEnum('nodeType').notNull(),

    // Temporal data. Signed years: negative = BCE. Convention only, no era field.
    dateStartYear: integer('dateStartYear'),
    dateStartMonth: integer('dateStartMonth'),
    dateStartDay: integer('dateStartDay'),
    dateStartPrecision: datePrecisionEnum('dateStartPrecision')
      .notNull()
      .default('UNKNOWN'),
    dateEndYear: integer('dateEndYear'),
    dateEndMonth: integer('dateEndMonth'),
    dateEndDay: integer('dateEndDay'),
    dateEndPrecision: datePrecisionEnum('dateEndPrecision')
      .notNull()
      .default('UNKNOWN'),

    // Drift prevention (A1/A10): set true when created via the search flow.
    isRoot: boolean('isRoot').notNull().default(false),

    // Expansion state, tracked per direction.
    upstreamState: expansionStateEnum('upstreamState')
      .notNull()
      .default('UNEXPANDED'),
    downstreamState: expansionStateEnum('downstreamState')
      .notNull()
      .default('UNEXPANDED'),

    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // wikidataQid and nexusGeneratedId uniqueness come from the column-level
    // `.unique()` (an implicit unique index).
    index('idx_nodes_wikipediaPageId').on(t.wikipediaPageId),
    index('idx_nodes_nodeType').on(t.nodeType),
    index('idx_nodes_dateStartYear').on(t.dateStartYear),
    index('idx_nodes_upstreamState').on(t.upstreamState),
    index('idx_nodes_downstreamState').on(t.downstreamState),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// edges — causal links (invariants P2/P3)
// ─────────────────────────────────────────────────────────────────────────────

export const edges = pgTable(
  'edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    causeNodeId: uuid('causeNodeId')
      .notNull()
      .references(() => nodes.id),
    effectNodeId: uuid('effectNodeId')
      .notNull()
      .references(() => nodes.id),
    relationType: relationTypeEnum('relationType').notNull(),
    status: edgeStatusEnum('status').notNull().default('ACTIVE'),
    chronologyStatus: chronologyStatusEnum('chronologyStatus')
      .notNull()
      .default('UNVERIFIED'),
    importanceRank: integer('importanceRank').notNull().default(5),
    contested: boolean('contested').notNull().default(false),
    firstExtractionRunId: uuid('firstExtractionRunId')
      .notNull()
      .references(() => extractionRuns.id),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // NOTE: uniqueness of ACTIVE edges is a partial unique index defined in
    // custom SQL (`unique_active_edge_pair`). Defining it here would conflict.
    index('idx_edges_causeNodeId').on(t.causeNodeId),
    index('idx_edges_effectNodeId').on(t.effectNodeId),
    index('idx_edges_status').on(t.status),
    index('idx_edges_importanceRank').on(t.importanceRank),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// sourceDocuments — pinned Wikipedia snapshots (A11: keyed by page + revision)
// ─────────────────────────────────────────────────────────────────────────────

export const sourceDocuments = pgTable(
  'sourceDocuments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    wikipediaPageId: integer('wikipediaPageId').notNull(),
    wikipediaTitle: text('wikipediaTitle').notNull(),
    revisionId: integer('revisionId').notNull(),
    fetchedAt: timestamp('fetchedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    rawText: text('rawText').notNull(),
    contentHash: text('contentHash').notNull(),
    sectionIndex: jsonb('sectionIndex').$type<SectionIndexEntry[]>().notNull(),
    languageCode: text('languageCode').notNull().default('en'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('unique_source_page_revision').on(t.wikipediaPageId, t.revisionId),
    index('idx_sourceDocuments_wikipediaPageId').on(t.wikipediaPageId),
    index('idx_sourceDocuments_contentHash').on(t.contentHash),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// extractionRuns — append-only LLM extraction records (P4)
// ─────────────────────────────────────────────────────────────────────────────

export const extractionRuns = pgTable(
  'extractionRuns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    focalNodeId: uuid('focalNodeId')
      .notNull()
      .references(() => nodes.id),
    direction: directionEnum('direction').notNull(),
    sourceDocumentId: uuid('sourceDocumentId')
      .notNull()
      .references(() => sourceDocuments.id),
    modelId: text('modelId').notNull(),
    promptVersion: text('promptVersion').notNull(),
    schemaVersion: text('schemaVersion').notNull(),
    chunksUsed: jsonb('chunksUsed').$type<ChunkDescriptor[]>().notNull(),
    rawPrompt: text('rawPrompt').notNull(),
    rawResponse: text('rawResponse').notNull(),
    rawResponseHash: text('rawResponseHash').notNull(),
    status: extractionStatusEnum('status').notNull().default('PENDING'),
    edgesProposed: integer('edgesProposed').notNull().default(0),
    edgesAccepted: integer('edgesAccepted').notNull().default(0),
    edgesRejected: integer('edgesRejected').notNull().default(0),
    rejectionReasons: jsonb('rejectionReasons').$type<RejectionReason[]>(),
    sparsenessReason: text('sparsenessReason'),
    inputTokens: integer('inputTokens').notNull().default(0),
    outputTokens: integer('outputTokens').notNull().default(0),
    estimatedCostUsd: real('estimatedCostUsd').notNull().default(0),
    startedAt: timestamp('startedAt', { withTimezone: true }),
    completedAt: timestamp('completedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_extractionRuns_focalDirection').on(t.focalNodeId, t.direction),
    index('idx_extractionRuns_status').on(t.status),
    index('idx_extractionRuns_modelPrompt').on(t.modelId, t.promptVersion),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// evidenceSpans — verbatim quotes supporting edges (P3)
// ─────────────────────────────────────────────────────────────────────────────

export const evidenceSpans = pgTable(
  'evidenceSpans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    edgeId: uuid('edgeId')
      .notNull()
      .references(() => edges.id),
    extractionRunId: uuid('extractionRunId')
      .notNull()
      .references(() => extractionRuns.id),
    sourceDocumentId: uuid('sourceDocumentId')
      .notNull()
      .references(() => sourceDocuments.id),
    quoteText: text('quoteText').notNull(),
    normalizedQuote: text('normalizedQuote').notNull(),
    sectionTitle: text('sectionTitle'),
    charOffsetStart: integer('charOffsetStart'),
    charOffsetEnd: integer('charOffsetEnd'),
    verificationStatus: verificationStatusEnum('verificationStatus').notNull(),
    verificationMethod: text('verificationMethod')
      .notNull()
      .default('exact_normalized_match'),
    verifiedAt: timestamp('verifiedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_evidenceSpans_edgeId').on(t.edgeId),
    index('idx_evidenceSpans_extractionRunId').on(t.extractionRunId),
    index('idx_evidenceSpans_verificationStatus').on(t.verificationStatus),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// expansionRequests — job queue + state machine
// ─────────────────────────────────────────────────────────────────────────────

export const expansionRequests = pgTable(
  'expansionRequests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('nodeId')
      .notNull()
      .references(() => nodes.id),
    direction: directionEnum('direction').notNull(),
    // Nullable so an ExpansionRequest's history survives deletion of its user
    // (ON DELETE SET NULL). New rows always carry the authenticated user id.
    requestedBy: text('requestedBy').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: expansionRequestStatusEnum('status').notNull().default('PENDING'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('maxAttempts').notNull().default(3),
    lockedBy: text('lockedBy'),
    lockedAt: timestamp('lockedAt', { withTimezone: true }),
    leaseExpiresAt: timestamp('leaseExpiresAt', { withTimezone: true }),
    retryAfter: timestamp('retryAfter', { withTimezone: true }),
    extractionRunId: uuid('extractionRunId').references(() => extractionRuns.id),
    lastError: text('lastError'),
    failedAt: timestamp('failedAt', { withTimezone: true }),
    // Computed server-side (A10); never client-supplied.
    depthFromRoot: integer('depthFromRoot').notNull().default(0),
    completedAt: timestamp('completedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_expansionRequests_statusLease').on(t.status, t.leaseExpiresAt),
    index('idx_expansionRequests_requestedBy').on(t.requestedBy),
    index('idx_expansionRequests_nodeDirection').on(t.nodeId, t.direction),
    // NOTE: the in-flight uniqueness rule is a partial unique index defined in
    // custom SQL (`unique_inflight_expansion`).
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// rejectedProposals — audit trail for edges that failed validation (A4)
// ─────────────────────────────────────────────────────────────────────────────

export const rejectedProposals = pgTable(
  'rejectedProposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    extractionRunId: uuid('extractionRunId')
      .notNull()
      .references(() => extractionRuns.id),
    proposalData: jsonb('proposalData')
      .$type<Record<string, unknown>>()
      .notNull(),
    // QUOTE_NOT_FOUND | CHRONOLOGY_VIOLATION | CYCLE_DETECTED |
    // QUOTE_IRRELEVANT | SCHEMA_INVALID
    rejectionReason: text('rejectionReason').notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_rejectedProposals_extractionRunId').on(t.extractionRunId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// userQuotas — per-user quota ledger (P6)
//
// NOTE: the brief's general rule says every table has createdAt and updatedAt,
// but the per-table column list for userQuotas omits createdAt. The per-table
// list wins (it is the more specific specification).
// ─────────────────────────────────────────────────────────────────────────────

export const userQuotas = pgTable(
  'userQuotas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('userId')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    expansionsToday: integer('expansionsToday').notNull().default(0),
    expansionsThisMonth: integer('expansionsThisMonth').notNull().default(0),
    dailyLimit: integer('dailyLimit').notNull().default(20),
    monthlyLimit: integer('monthlyLimit').notNull().default(200),
    estimatedCostToday: real('estimatedCostToday').notNull().default(0),
    estimatedCostThisMonth: real('estimatedCostThisMonth').notNull().default(0),
    currentDay: date('currentDay').notNull().default(sql`CURRENT_DATE`),
    currentMonth: date('currentMonth').notNull().default(sql`CURRENT_DATE`),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_userQuotas_userId').on(t.userId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// globalBudget — singleton global budget ledger (P6)
//
// NOTE: no createdAt, matching the per-table column list (see userQuotas note).
// ─────────────────────────────────────────────────────────────────────────────

export const globalBudget = pgTable('globalBudget', {
  id: text('id').primaryKey().default('singleton'),
  dailyBudgetUsd: real('dailyBudgetUsd').notNull().default(50),
  monthlyBudgetUsd: real('monthlyBudgetUsd').notNull().default(500),
  spentTodayUsd: real('spentTodayUsd').notNull().default(0),
  spentThisMonthUsd: real('spentThisMonthUsd').notNull().default(0),
  currentDay: date('currentDay').notNull().default(sql`CURRENT_DATE`),
  currentMonth: date('currentMonth').notNull().default(sql`CURRENT_DATE`),
  isPaused: boolean('isPaused').notNull().default(false),
  updatedAt: timestamp('updatedAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// edgeFeedback — user reports on edges
//
// NOTE: only createdAt, matching the per-table column list.
// ─────────────────────────────────────────────────────────────────────────────

export const edgeFeedback = pgTable(
  'edgeFeedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    edgeId: uuid('edgeId')
      .notNull()
      .references(() => edges.id),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: feedbackTypeEnum('type').notNull(),
    note: text('note'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_edgeFeedback_edgeId').on(t.edgeId),
    index('idx_edgeFeedback_userId').on(t.userId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// qidReconciliations — log of late QID resolution / merges
//
// NOTE: only reconciledAt, matching the per-table column list.
// ─────────────────────────────────────────────────────────────────────────────

export const qidReconciliations = pgTable(
  'qidReconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Deliberately no FK: the node may be deleted or merged away.
    nodeId: uuid('nodeId').notNull(),
    previousScheme: identitySchemeEnum('previousScheme').notNull(),
    previousId: text('previousId').notNull(),
    resolvedQid: text('resolvedQid').notNull(),
    mergedIntoNodeId: uuid('mergedIntoNodeId'),
    reconciledAt: timestamp('reconciledAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_qidReconciliations_nodeId').on(t.nodeId),
    index('idx_qidReconciliations_resolvedQid').on(t.resolvedQid),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Relations (for Drizzle relational queries)
// ─────────────────────────────────────────────────────────────────────────────

export const nodesRelations = relations(nodes, ({ many }) => ({
  causeEdges: many(edges, { relationName: 'cause' }),
  effectEdges: many(edges, { relationName: 'effect' }),
  expansionRequests: many(expansionRequests),
  focalExtractionRuns: many(extractionRuns),
}));

export const edgesRelations = relations(edges, ({ one, many }) => ({
  causeNode: one(nodes, {
    fields: [edges.causeNodeId],
    references: [nodes.id],
    relationName: 'cause',
  }),
  effectNode: one(nodes, {
    fields: [edges.effectNodeId],
    references: [nodes.id],
    relationName: 'effect',
  }),
  firstExtractionRun: one(extractionRuns, {
    fields: [edges.firstExtractionRunId],
    references: [extractionRuns.id],
  }),
  evidenceSpans: many(evidenceSpans),
  feedback: many(edgeFeedback),
}));

export const sourceDocumentsRelations = relations(
  sourceDocuments,
  ({ many }) => ({
    extractionRuns: many(extractionRuns),
    evidenceSpans: many(evidenceSpans),
  }),
);

export const extractionRunsRelations = relations(
  extractionRuns,
  ({ one, many }) => ({
    focalNode: one(nodes, {
      fields: [extractionRuns.focalNodeId],
      references: [nodes.id],
    }),
    sourceDocument: one(sourceDocuments, {
      fields: [extractionRuns.sourceDocumentId],
      references: [sourceDocuments.id],
    }),
    evidenceSpans: many(evidenceSpans),
    rejectedProposals: many(rejectedProposals),
    firstEdges: many(edges),
    expansionRequest: one(expansionRequests),
  }),
);

export const evidenceSpansRelations = relations(evidenceSpans, ({ one }) => ({
  edge: one(edges, {
    fields: [evidenceSpans.edgeId],
    references: [edges.id],
  }),
  extractionRun: one(extractionRuns, {
    fields: [evidenceSpans.extractionRunId],
    references: [extractionRuns.id],
  }),
  sourceDocument: one(sourceDocuments, {
    fields: [evidenceSpans.sourceDocumentId],
    references: [sourceDocuments.id],
  }),
}));

export const expansionRequestsRelations = relations(
  expansionRequests,
  ({ one }) => ({
    node: one(nodes, {
      fields: [expansionRequests.nodeId],
      references: [nodes.id],
    }),
    extractionRun: one(extractionRuns, {
      fields: [expansionRequests.extractionRunId],
      references: [extractionRuns.id],
    }),
  }),
);

export const rejectedProposalsRelations = relations(
  rejectedProposals,
  ({ one }) => ({
    extractionRun: one(extractionRuns, {
      fields: [rejectedProposals.extractionRunId],
      references: [extractionRuns.id],
    }),
  }),
);

export const edgeFeedbackRelations = relations(edgeFeedback, ({ one }) => ({
  edge: one(edges, {
    fields: [edgeFeedback.edgeId],
    references: [edges.id],
  }),
}));
