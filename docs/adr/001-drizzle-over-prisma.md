# ADR 001: Drizzle ORM over Prisma

## Status: Accepted

## Context

Nexus requires `pg_advisory_xact_lock`, partial unique indexes,
CHECK constraints, deferred constraint triggers, recursive CTEs,
`ON CONFLICT DO NOTHING RETURNING`, `SELECT FOR UPDATE SKIP LOCKED`,
and per-transaction isolation levels. 6 of 8 require raw SQL
in Prisma.

## Decision

Use Drizzle ORM, which provides first-class or natural support
for these PostgreSQL features.

## Consequences

- Builder agents have less training data on Drizzle; mitigated
  by patterns in AGENTS.md.
- Migration files are owned SQL; custom constraints are natural.
- Relation queries are slightly more verbose than Prisma's
  `include`.
