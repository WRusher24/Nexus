CREATE TYPE "public"."chronology_status" AS ENUM('VERIFIED', 'UNVERIFIED', 'OVERRIDE');--> statement-breakpoint
CREATE TYPE "public"."date_precision" AS ENUM('DAY', 'MONTH', 'YEAR', 'DECADE', 'CENTURY', 'MILLENNIUM', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('UPSTREAM', 'DOWNSTREAM');--> statement-breakpoint
CREATE TYPE "public"."edge_status" AS ENUM('ACTIVE', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."expansion_request_status" AS ENUM('PENDING', 'LOCKED', 'FETCHING', 'EXTRACTING', 'VALIDATING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."expansion_state" AS ENUM('UNEXPANDED', 'QUEUED', 'LOADING', 'EXPANDED', 'SPARSE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."feedback_type" AS ENUM('INCORRECT', 'MISSING', 'DUPLICATE', 'SPAM');--> statement-breakpoint
CREATE TYPE "public"."identity_scheme" AS ENUM('WIKIDATA', 'WIKIPEDIA_PAGE', 'NEXUS_GENERATED');--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('EVENT', 'PROCESS', 'POLICY', 'ACTOR', 'IDEOLOGY', 'INSTITUTION', 'TECHNOLOGY', 'PLACE');--> statement-breakpoint
CREATE TYPE "public"."relation_type" AS ENUM('CAUSED', 'CONTRIBUTED_TO', 'ENABLED', 'TRIGGERED', 'PREVENTED', 'INFLUENCED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('VERIFIED', 'OFFSET_SHIFTED', 'NOT_FOUND', 'REJECTED');--> statement-breakpoint
CREATE TABLE "edgeFeedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edgeId" uuid NOT NULL,
	"userId" text NOT NULL,
	"type" "feedback_type" NOT NULL,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"causeNodeId" uuid NOT NULL,
	"effectNodeId" uuid NOT NULL,
	"relationType" "relation_type" NOT NULL,
	"status" "edge_status" DEFAULT 'ACTIVE' NOT NULL,
	"chronologyStatus" "chronology_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"importanceRank" integer DEFAULT 5 NOT NULL,
	"contested" boolean DEFAULT false NOT NULL,
	"firstExtractionRunId" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidenceSpans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edgeId" uuid NOT NULL,
	"extractionRunId" uuid NOT NULL,
	"sourceDocumentId" uuid NOT NULL,
	"quoteText" text NOT NULL,
	"normalizedQuote" text NOT NULL,
	"sectionTitle" text,
	"charOffsetStart" integer,
	"charOffsetEnd" integer,
	"verificationStatus" "verification_status" NOT NULL,
	"verificationMethod" text DEFAULT 'exact_normalized_match' NOT NULL,
	"verifiedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expansionRequests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodeId" uuid NOT NULL,
	"direction" "direction" NOT NULL,
	"requestedBy" text NOT NULL,
	"status" "expansion_request_status" DEFAULT 'PENDING' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"lockedBy" text,
	"lockedAt" timestamp with time zone,
	"leaseExpiresAt" timestamp with time zone,
	"retryAfter" timestamp with time zone,
	"extractionRunId" uuid,
	"lastError" text,
	"failedAt" timestamp with time zone,
	"depthFromRoot" integer DEFAULT 0 NOT NULL,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractionRuns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"focalNodeId" uuid NOT NULL,
	"direction" "direction" NOT NULL,
	"sourceDocumentId" uuid NOT NULL,
	"modelId" text NOT NULL,
	"promptVersion" text NOT NULL,
	"schemaVersion" text NOT NULL,
	"chunksUsed" jsonb NOT NULL,
	"rawPrompt" text NOT NULL,
	"rawResponse" text NOT NULL,
	"rawResponseHash" text NOT NULL,
	"status" "extraction_status" DEFAULT 'PENDING' NOT NULL,
	"edgesProposed" integer DEFAULT 0 NOT NULL,
	"edgesAccepted" integer DEFAULT 0 NOT NULL,
	"edgesRejected" integer DEFAULT 0 NOT NULL,
	"rejectionReasons" jsonb,
	"sparsenessReason" text,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"estimatedCostUsd" real DEFAULT 0 NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "globalBudget" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"dailyBudgetUsd" real DEFAULT 50 NOT NULL,
	"monthlyBudgetUsd" real DEFAULT 500 NOT NULL,
	"spentTodayUsd" real DEFAULT 0 NOT NULL,
	"spentThisMonthUsd" real DEFAULT 0 NOT NULL,
	"currentDay" date DEFAULT CURRENT_DATE NOT NULL,
	"currentMonth" date DEFAULT CURRENT_DATE NOT NULL,
	"isPaused" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identityScheme" "identity_scheme" NOT NULL,
	"wikidataQid" text,
	"wikipediaPageId" integer,
	"nexusGeneratedId" text,
	"label" text NOT NULL,
	"brief" text,
	"nodeType" "node_type" NOT NULL,
	"dateStartYear" integer,
	"dateStartMonth" integer,
	"dateStartDay" integer,
	"dateStartPrecision" date_precision DEFAULT 'UNKNOWN' NOT NULL,
	"dateEndYear" integer,
	"dateEndMonth" integer,
	"dateEndDay" integer,
	"dateEndPrecision" date_precision DEFAULT 'UNKNOWN' NOT NULL,
	"isRoot" boolean DEFAULT false NOT NULL,
	"upstreamState" "expansion_state" DEFAULT 'UNEXPANDED' NOT NULL,
	"downstreamState" "expansion_state" DEFAULT 'UNEXPANDED' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_wikidataQid_unique" UNIQUE("wikidataQid"),
	CONSTRAINT "nodes_nexusGeneratedId_unique" UNIQUE("nexusGeneratedId")
);
--> statement-breakpoint
CREATE TABLE "qidReconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodeId" uuid NOT NULL,
	"previousScheme" "identity_scheme" NOT NULL,
	"previousId" text NOT NULL,
	"resolvedQid" text NOT NULL,
	"mergedIntoNodeId" uuid,
	"reconciledAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejectedProposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extractionRunId" uuid NOT NULL,
	"proposalData" jsonb NOT NULL,
	"rejectionReason" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sourceDocuments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wikipediaPageId" integer NOT NULL,
	"wikipediaTitle" text NOT NULL,
	"revisionId" integer NOT NULL,
	"fetchedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"rawText" text NOT NULL,
	"contentHash" text NOT NULL,
	"sectionIndex" jsonb NOT NULL,
	"languageCode" text DEFAULT 'en' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_source_page_revision" UNIQUE("wikipediaPageId","revisionId")
);
--> statement-breakpoint
CREATE TABLE "userQuotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" text NOT NULL,
	"expansionsToday" integer DEFAULT 0 NOT NULL,
	"expansionsThisMonth" integer DEFAULT 0 NOT NULL,
	"dailyLimit" integer DEFAULT 20 NOT NULL,
	"monthlyLimit" integer DEFAULT 200 NOT NULL,
	"estimatedCostToday" real DEFAULT 0 NOT NULL,
	"estimatedCostThisMonth" real DEFAULT 0 NOT NULL,
	"currentDay" date DEFAULT CURRENT_DATE NOT NULL,
	"currentMonth" date DEFAULT CURRENT_DATE NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "userQuotas_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
ALTER TABLE "edgeFeedback" ADD CONSTRAINT "edgeFeedback_edgeId_edges_id_fk" FOREIGN KEY ("edgeId") REFERENCES "public"."edges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_causeNodeId_nodes_id_fk" FOREIGN KEY ("causeNodeId") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_effectNodeId_nodes_id_fk" FOREIGN KEY ("effectNodeId") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_firstExtractionRunId_extractionRuns_id_fk" FOREIGN KEY ("firstExtractionRunId") REFERENCES "public"."extractionRuns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidenceSpans" ADD CONSTRAINT "evidenceSpans_edgeId_edges_id_fk" FOREIGN KEY ("edgeId") REFERENCES "public"."edges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidenceSpans" ADD CONSTRAINT "evidenceSpans_extractionRunId_extractionRuns_id_fk" FOREIGN KEY ("extractionRunId") REFERENCES "public"."extractionRuns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidenceSpans" ADD CONSTRAINT "evidenceSpans_sourceDocumentId_sourceDocuments_id_fk" FOREIGN KEY ("sourceDocumentId") REFERENCES "public"."sourceDocuments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansionRequests" ADD CONSTRAINT "expansionRequests_nodeId_nodes_id_fk" FOREIGN KEY ("nodeId") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansionRequests" ADD CONSTRAINT "expansionRequests_extractionRunId_extractionRuns_id_fk" FOREIGN KEY ("extractionRunId") REFERENCES "public"."extractionRuns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractionRuns" ADD CONSTRAINT "extractionRuns_focalNodeId_nodes_id_fk" FOREIGN KEY ("focalNodeId") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractionRuns" ADD CONSTRAINT "extractionRuns_sourceDocumentId_sourceDocuments_id_fk" FOREIGN KEY ("sourceDocumentId") REFERENCES "public"."sourceDocuments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejectedProposals" ADD CONSTRAINT "rejectedProposals_extractionRunId_extractionRuns_id_fk" FOREIGN KEY ("extractionRunId") REFERENCES "public"."extractionRuns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_edgeFeedback_edgeId" ON "edgeFeedback" USING btree ("edgeId");--> statement-breakpoint
CREATE INDEX "idx_edgeFeedback_userId" ON "edgeFeedback" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_edges_causeNodeId" ON "edges" USING btree ("causeNodeId");--> statement-breakpoint
CREATE INDEX "idx_edges_effectNodeId" ON "edges" USING btree ("effectNodeId");--> statement-breakpoint
CREATE INDEX "idx_edges_status" ON "edges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_edges_importanceRank" ON "edges" USING btree ("importanceRank");--> statement-breakpoint
CREATE INDEX "idx_evidenceSpans_edgeId" ON "evidenceSpans" USING btree ("edgeId");--> statement-breakpoint
CREATE INDEX "idx_evidenceSpans_extractionRunId" ON "evidenceSpans" USING btree ("extractionRunId");--> statement-breakpoint
CREATE INDEX "idx_evidenceSpans_verificationStatus" ON "evidenceSpans" USING btree ("verificationStatus");--> statement-breakpoint
CREATE INDEX "idx_expansionRequests_statusLease" ON "expansionRequests" USING btree ("status","leaseExpiresAt");--> statement-breakpoint
CREATE INDEX "idx_expansionRequests_requestedBy" ON "expansionRequests" USING btree ("requestedBy");--> statement-breakpoint
CREATE INDEX "idx_expansionRequests_nodeDirection" ON "expansionRequests" USING btree ("nodeId","direction");--> statement-breakpoint
CREATE INDEX "idx_extractionRuns_focalDirection" ON "extractionRuns" USING btree ("focalNodeId","direction");--> statement-breakpoint
CREATE INDEX "idx_extractionRuns_status" ON "extractionRuns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_extractionRuns_modelPrompt" ON "extractionRuns" USING btree ("modelId","promptVersion");--> statement-breakpoint
CREATE INDEX "idx_nodes_wikipediaPageId" ON "nodes" USING btree ("wikipediaPageId");--> statement-breakpoint
CREATE INDEX "idx_nodes_nodeType" ON "nodes" USING btree ("nodeType");--> statement-breakpoint
CREATE INDEX "idx_nodes_dateStartYear" ON "nodes" USING btree ("dateStartYear");--> statement-breakpoint
CREATE INDEX "idx_nodes_upstreamState" ON "nodes" USING btree ("upstreamState");--> statement-breakpoint
CREATE INDEX "idx_nodes_downstreamState" ON "nodes" USING btree ("downstreamState");--> statement-breakpoint
CREATE INDEX "idx_qidReconciliations_nodeId" ON "qidReconciliations" USING btree ("nodeId");--> statement-breakpoint
CREATE INDEX "idx_qidReconciliations_resolvedQid" ON "qidReconciliations" USING btree ("resolvedQid");--> statement-breakpoint
CREATE INDEX "idx_rejectedProposals_extractionRunId" ON "rejectedProposals" USING btree ("extractionRunId");--> statement-breakpoint
CREATE INDEX "idx_sourceDocuments_wikipediaPageId" ON "sourceDocuments" USING btree ("wikipediaPageId");--> statement-breakpoint
CREATE INDEX "idx_sourceDocuments_contentHash" ON "sourceDocuments" USING btree ("contentHash");--> statement-breakpoint
CREATE INDEX "idx_userQuotas_userId" ON "userQuotas" USING btree ("userId");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- NEXUS CUSTOM SQL (M2)
--
-- Migration strategy: Option A — the raw SQL that Drizzle cannot express
-- declaratively (CHECK constraints, partial unique indexes, the deferred P3
-- constraint trigger, and the globalBudget seed) is appended to this
-- Drizzle-generated migration rather than living in a second hand-written
-- file. This keeps a single, ordered, self-contained migration and means the
-- drizzle migrator (used by both `db:migrate` and the test helper) applies the
-- custom objects automatically. Each top-level statement is separated by the
-- "statement-breakpoint" marker that drizzle-kit uses to split queries; markers
-- are never placed inside the plpgsql function body (the splitter is purely
-- textual and would otherwise split the function definition).
-- ═══════════════════════════════════════════════════════════════════════════

-- P1: At least one identity field must be set.
ALTER TABLE "nodes" ADD CONSTRAINT chk_node_identity
  CHECK (
    "wikidataQid" IS NOT NULL
    OR "wikipediaPageId" IS NOT NULL
    OR "nexusGeneratedId" IS NOT NULL
  );--> statement-breakpoint

-- P2: No self-referential edges.
ALTER TABLE "edges" ADD CONSTRAINT chk_no_self_edge
  CHECK ("causeNodeId" != "effectNodeId");--> statement-breakpoint

-- Importance rank bounded 1-10.
ALTER TABLE "edges" ADD CONSTRAINT chk_importance_range
  CHECK ("importanceRank" BETWEEN 1 AND 10);--> statement-breakpoint

-- Date start consistency: the granularity implied by precision must be present.
ALTER TABLE "nodes" ADD CONSTRAINT chk_date_start_consistency
  CHECK (
    CASE "dateStartPrecision"
      WHEN 'DAY' THEN "dateStartYear" IS NOT NULL AND "dateStartMonth" IS NOT NULL AND "dateStartDay" IS NOT NULL
      WHEN 'MONTH' THEN "dateStartYear" IS NOT NULL AND "dateStartMonth" IS NOT NULL
      WHEN 'YEAR' THEN "dateStartYear" IS NOT NULL
      WHEN 'DECADE' THEN "dateStartYear" IS NOT NULL
      WHEN 'CENTURY' THEN "dateStartYear" IS NOT NULL
      WHEN 'MILLENNIUM' THEN "dateStartYear" IS NOT NULL
      WHEN 'UNKNOWN' THEN TRUE
    END
  );--> statement-breakpoint

-- Date end consistency (mirror of the start constraint).
ALTER TABLE "nodes" ADD CONSTRAINT chk_date_end_consistency
  CHECK (
    CASE "dateEndPrecision"
      WHEN 'DAY' THEN "dateEndYear" IS NOT NULL AND "dateEndMonth" IS NOT NULL AND "dateEndDay" IS NOT NULL
      WHEN 'MONTH' THEN "dateEndYear" IS NOT NULL AND "dateEndMonth" IS NOT NULL
      WHEN 'YEAR' THEN "dateEndYear" IS NOT NULL
      WHEN 'DECADE' THEN "dateEndYear" IS NOT NULL
      WHEN 'CENTURY' THEN "dateEndYear" IS NOT NULL
      WHEN 'MILLENNIUM' THEN "dateEndYear" IS NOT NULL
      WHEN 'UNKNOWN' THEN TRUE
    END
  );--> statement-breakpoint

-- A2: only one ACTIVE edge per (cause, effect, relationType) triple. Multiple
-- SUPERSEDED rows are retained for the audit trail.
CREATE UNIQUE INDEX unique_active_edge_pair
  ON "edges" ("causeNodeId", "effectNodeId", "relationType")
  WHERE "status" = 'ACTIVE';--> statement-breakpoint

-- Only one in-flight expansion per (node, direction) at a time.
CREATE UNIQUE INDEX unique_inflight_expansion
  ON "expansionRequests" ("nodeId", "direction")
  WHERE "status" IN ('PENDING', 'LOCKED', 'FETCHING', 'EXTRACTING', 'VALIDATING');--> statement-breakpoint

-- P3: every ACTIVE edge must have at least one VERIFIED evidence span. The
-- trigger is DEFERRABLE INITIALLY DEFERRED so the edge and its evidence can be
-- written in any order inside a single transaction; the check runs at COMMIT.
CREATE OR REPLACE FUNCTION check_edge_has_evidence()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM "evidenceSpans"
    WHERE "edgeId" = NEW."id"
      AND "verificationStatus" = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'P3 VIOLATION: ACTIVE edge % has no verified evidence span', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_edge_evidence
  AFTER INSERT OR UPDATE ON "edges"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_edge_has_evidence();--> statement-breakpoint

-- P6: seed the global budget singleton.
INSERT INTO "globalBudget" ("id", "dailyBudgetUsd", "monthlyBudgetUsd", "spentTodayUsd", "spentThisMonthUsd", "currentDay", "currentMonth", "isPaused", "updatedAt")
VALUES ('singleton', 50, 500, 0, 0, CURRENT_DATE, CURRENT_DATE, false, NOW())
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- Ordering note: statements above are intentionally sequential. The identity
-- CHECK, partial indexes, and trigger are all created after the base tables so
-- no dependency ordering issues arise.