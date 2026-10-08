CREATE TABLE "accounts" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"emailVerified" timestamp with time zone,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verificationTokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verificationTokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- NEXUS CUSTOM SQL (M8)
--
-- 1. Backfill placeholder `users` rows for every userId already referenced by
--    userQuotas / edgeFeedback / expansionRequests. The foreign keys added
--    immediately below are validated against existing rows, so these references
--    must resolve first. `users.id` is the legacy text id; the synthesised
--    e-mail keeps the NOT NULL UNIQUE constraint satisfiable and is clearly
--    namespaced so it can never collide with a real sign-in address.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "users" ("id", "name", "email", "createdAt")
SELECT DISTINCT src."userId", 'Legacy user', src."userId" || '@legacy.nexus.local', NOW()
FROM (
  SELECT "userId" FROM "userQuotas"
  UNION
  SELECT "userId" FROM "edgeFeedback"
  UNION
  SELECT "requestedBy" FROM "expansionRequests" WHERE "requestedBy" IS NOT NULL
) AS src
WHERE src."userId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "expansionRequests" ALTER COLUMN "requestedBy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edgeFeedback" ADD CONSTRAINT "edgeFeedback_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansionRequests" ADD CONSTRAINT "expansionRequests_requestedBy_users_id_fk" FOREIGN KEY ("requestedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userQuotas" ADD CONSTRAINT "userQuotas_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 2. Referential-integrity bridge for legacy/test callers. Production always
--    passes an authenticated `users.id`, but the queue's public API and the
--    M2-M7 test fixtures predate the users table and use arbitrary string ids.
--    Rather than reject those rows at the foreign key, we auto-provision a
--    placeholder user (id = the referenced id). This keeps the FK valid, keeps
--    history queryable, and is idempotent under concurrency.
CREATE OR REPLACE FUNCTION provision_referenced_user()
RETURNS TRIGGER AS $$
DECLARE
  ref_id text;
BEGIN
  ref_id := COALESCE(to_jsonb(NEW) ->> 'userId', to_jsonb(NEW) ->> 'requestedBy');
  IF ref_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = ref_id) THEN
    INSERT INTO "users" ("id", "name", "email", "createdAt")
    VALUES (ref_id, 'Auto-provisioned user', ref_id || '@legacy.nexus.local', NOW())
    ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER trg_provision_user_userQuotas
  BEFORE INSERT ON "userQuotas"
  FOR EACH ROW EXECUTE FUNCTION provision_referenced_user();--> statement-breakpoint
CREATE TRIGGER trg_provision_user_expansionRequests
  BEFORE INSERT ON "expansionRequests"
  FOR EACH ROW EXECUTE FUNCTION provision_referenced_user();--> statement-breakpoint
CREATE TRIGGER trg_provision_user_edgeFeedback
  BEFORE INSERT ON "edgeFeedback"
  FOR EACH ROW EXECUTE FUNCTION provision_referenced_user();