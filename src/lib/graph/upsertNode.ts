/**
 * Canonical node upsert (invariant P1).
 *
 * Every historical entity must resolve to exactly one row. This module is the
 * single application write path for `nodes`: it collapses duplicate
 * submissions onto the same row by identity, and never overwrites richer
 * display/temporal metadata with poorer values.
 */

import { eq } from 'drizzle-orm';
import { nodes, nodeTypeEnum } from '../db/schema';
import type { DatePrecision } from '../dates/intervals';
import type {
  Database,
  IdentityScheme,
  NodeIdentity,
  UpsertNodeInput,
  UpsertNodeResult,
} from './types';

const QID_PATTERN = /^Q\d+$/;

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validate the date granularity rule mirrored by `chk_date_start_consistency`
 * / `chk_date_end_consistency`: the fields implied by the precision must be
 * present. Done in application code so callers get a clear error rather than a
 * SQLSTATE.
 */
function validateDateComponent(
  role: 'dateStart' | 'dateEnd',
  precision: DatePrecision,
  year: number | null | undefined,
  month: number | null | undefined,
  day: number | null | undefined,
): void {
  const fail = (message: string): never => {
    throw new Error(`Invalid ${role}: ${message}`);
  };

  switch (precision) {
    case 'UNKNOWN':
      return;
    case 'DAY':
      if (year == null || month == null || day == null) {
        fail('precision DAY requires year, month, and day');
      }
      return;
    case 'MONTH':
      if (year == null || month == null) {
        fail('precision MONTH requires year and month');
      }
      return;
    case 'YEAR':
    case 'DECADE':
    case 'CENTURY':
    case 'MILLENNIUM':
      if (year == null) {
        fail(`precision ${precision} requires year`);
      }
      return;
    default: {
      const exhaustive: never = precision;
      return exhaustive;
    }
  }
}

function resolveScheme(identity: NodeIdentity): IdentityScheme {
  if (isNonEmpty(identity.wikidataQid)) return 'WIKIDATA';
  if (identity.wikipediaPageId != null) return 'WIKIPEDIA_PAGE';
  if (isNonEmpty(identity.nexusGeneratedId)) return 'NEXUS_GENERATED';
  // Unreachable: validated before this is called.
  throw new Error('P1 VIOLATION: no identity provided');
}

/**
 * Insert a node or return the existing one if a canonical match exists.
 *
 * Identity resolution order: wikidataQid, then wikipediaPageId, then
 * nexusGeneratedId. On a match, only fills in missing metadata (label/brief)
 * and upgrades an UNKNOWN date to a known precision; it never downgrades or
 * overwrites. nodeType and identity fields are immutable once written.
 *
 * Concurrency: QID and nexusGeneratedId are unique, so an INSERT ... ON
 * CONFLICT DO NOTHING followed by a SELECT resolves races. wikipediaPageId is
 * intentionally not unique, so it uses SELECT-then-INSERT.
 *
 * READ COMMITTED is sufficient: the unique constraints prevent duplicate
 * canonical rows even under concurrent upserts.
 *
 * @param db - Drizzle database handle
 */
export async function upsertNode(
  db: Database,
  input: UpsertNodeInput,
): Promise<UpsertNodeResult> {
  const { identity } = input;

  const identityCount =
    (isNonEmpty(identity.wikidataQid) ? 1 : 0) +
    (identity.wikipediaPageId != null ? 1 : 0) +
    (isNonEmpty(identity.nexusGeneratedId) ? 1 : 0);
  if (identityCount === 0) {
    throw new Error('P1 VIOLATION: no identity provided');
  }

  if (!nodeTypeEnum.enumValues.includes(input.nodeType)) {
    throw new Error(`Invalid nodeType: ${input.nodeType}`);
  }

  if (isNonEmpty(identity.wikidataQid) && !QID_PATTERN.test(identity.wikidataQid)) {
    throw new Error(
      `Invalid wikidataQid "${identity.wikidataQid}": must match ^Q\\d+$`,
    );
  }

  const dateStartPrecision: DatePrecision = input.dateStartPrecision ?? 'UNKNOWN';
  const dateEndPrecision: DatePrecision = input.dateEndPrecision ?? 'UNKNOWN';
  validateDateComponent(
    'dateStart',
    dateStartPrecision,
    input.dateStartYear,
    input.dateStartMonth,
    input.dateStartDay,
  );
  validateDateComponent(
    'dateEnd',
    dateEndPrecision,
    input.dateEndYear,
    input.dateEndMonth,
    input.dateEndDay,
  );

  const scheme = resolveScheme(identity);

  const findExisting = async () => {
    if (isNonEmpty(identity.wikidataQid)) {
      const [row] = await db
        .select()
        .from(nodes)
        .where(eq(nodes.wikidataQid, identity.wikidataQid));
      return row;
    }
    if (identity.wikipediaPageId != null) {
      const [row] = await db
        .select()
        .from(nodes)
        .where(eq(nodes.wikipediaPageId, identity.wikipediaPageId));
      return row;
    }
    if (isNonEmpty(identity.nexusGeneratedId)) {
      const [row] = await db
        .select()
        .from(nodes)
        .where(eq(nodes.nexusGeneratedId, identity.nexusGeneratedId));
      return row;
    }
    return undefined;
  };

  const existing = await findExisting();
  if (existing) {
    return applyMetadataUpdate(db, existing, input);
  }

  const insertValues: typeof nodes.$inferInsert = {
    identityScheme: scheme,
    wikidataQid: identity.wikidataQid ?? null,
    wikipediaPageId: identity.wikipediaPageId ?? null,
    nexusGeneratedId: identity.nexusGeneratedId ?? null,
    label: input.label,
    brief: input.brief ?? null,
    nodeType: input.nodeType,
    dateStartYear: input.dateStartYear ?? null,
    dateStartMonth: input.dateStartMonth ?? null,
    dateStartDay: input.dateStartDay ?? null,
    dateStartPrecision,
    dateEndYear: input.dateEndYear ?? null,
    dateEndMonth: input.dateEndMonth ?? null,
    dateEndDay: input.dateEndDay ?? null,
    dateEndPrecision,
    isRoot: input.isRoot ?? false,
  };

  // Unique identity columns get ON CONFLICT resolution. wikipediaPageId is not
  // unique, so a plain insert is correct (and a raced duplicate page id is
  // tolerated by the schema, by design).
  if (isNonEmpty(identity.wikidataQid)) {
    const inserted = await db
      .insert(nodes)
      .values(insertValues)
      .onConflictDoNothing({ target: nodes.wikidataQid })
      .returning({ id: nodes.id });
    const created = inserted[0];
    if (created) return { outcome: 'CREATED', nodeId: created.id };
  } else if (isNonEmpty(identity.nexusGeneratedId)) {
    const inserted = await db
      .insert(nodes)
      .values(insertValues)
      .onConflictDoNothing({ target: nodes.nexusGeneratedId })
      .returning({ id: nodes.id });
    const created = inserted[0];
    if (created) return { outcome: 'CREATED', nodeId: created.id };
  } else {
    const inserted = await db
      .insert(nodes)
      .values(insertValues)
      .returning({ id: nodes.id });
    const created = inserted[0];
    if (created) return { outcome: 'CREATED', nodeId: created.id };
  }

  // Lost a race: a concurrent insert won. Re-read and treat as EXISTING.
  const raced = await findExisting();
  if (!raced) {
    throw new Error(
      'upsertNode: insert was skipped by a conflict but no existing row was found',
    );
  }
  return applyMetadataUpdate(db, raced, input);
}

type NodeRow = typeof nodes.$inferSelect;

/**
 * Fill in missing display/temporal metadata on an existing node. Returns
 * `updated: false` (and issues no UPDATE) when nothing would change.
 */
async function applyMetadataUpdate(
  db: Database,
  existing: NodeRow,
  input: UpsertNodeInput,
): Promise<UpsertNodeResult> {
  const update: Partial<typeof nodes.$inferInsert> = {};

  // First extraction wins for display metadata: only fill holes.
  if (!isNonEmpty(existing.label) && isNonEmpty(input.label)) {
    update.label = input.label;
  }
  if (!isNonEmpty(existing.brief) && isNonEmpty(input.brief)) {
    update.brief = input.brief;
  }

  const startPrecision: DatePrecision = input.dateStartPrecision ?? 'UNKNOWN';
  if (existing.dateStartPrecision === 'UNKNOWN' && startPrecision !== 'UNKNOWN') {
    update.dateStartYear = input.dateStartYear ?? null;
    update.dateStartMonth = input.dateStartMonth ?? null;
    update.dateStartDay = input.dateStartDay ?? null;
    update.dateStartPrecision = startPrecision;
  }

  const endPrecision: DatePrecision = input.dateEndPrecision ?? 'UNKNOWN';
  if (existing.dateEndPrecision === 'UNKNOWN' && endPrecision !== 'UNKNOWN') {
    update.dateEndYear = input.dateEndYear ?? null;
    update.dateEndMonth = input.dateEndMonth ?? null;
    update.dateEndDay = input.dateEndDay ?? null;
    update.dateEndPrecision = endPrecision;
  }

  if (Object.keys(update).length === 0) {
    return { outcome: 'EXISTING', nodeId: existing.id, updated: false };
  }

  update.updatedAt = new Date();
  await db.update(nodes).set(update).where(eq(nodes.id, existing.id));

  return { outcome: 'EXISTING', nodeId: existing.id, updated: true };
}
