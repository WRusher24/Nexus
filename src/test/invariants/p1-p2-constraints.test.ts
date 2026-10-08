import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../../lib/db/schema';
import {
  captureError,
  closeTestDb,
  getPgErrorCode,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../helpers/db';
import { insertNode } from '../helpers/fixtures';

const CHECK_VIOLATION = '23514';

describe('P1/P2: date consistency constraints', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it('rejects DAY precision without a day (chk_date_start_consistency)', async () => {
    const error = await captureError(() =>
      insertNode(testDb.db, {
        identityScheme: 'WIKIDATA',
        wikidataQid: 'Q1',
        dateStartYear: 1900,
        dateStartMonth: 6,
        dateStartDay: null,
        dateStartPrecision: 'DAY',
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('rejects MONTH precision without a month (chk_date_start_consistency)', async () => {
    const error = await captureError(() =>
      insertNode(testDb.db, {
        identityScheme: 'WIKIDATA',
        wikidataQid: 'Q1',
        dateStartYear: 1900,
        dateStartMonth: null,
        dateStartPrecision: 'MONTH',
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('rejects YEAR precision without a year (chk_date_start_consistency)', async () => {
    const error = await captureError(() =>
      insertNode(testDb.db, {
        identityScheme: 'WIKIDATA',
        wikidataQid: 'Q1',
        dateStartYear: null,
        dateStartPrecision: 'YEAR',
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('accepts UNKNOWN precision with all date fields null', async () => {
    const id = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q1',
      dateStartPrecision: 'UNKNOWN',
      dateStartYear: null,
      dateStartMonth: null,
      dateStartDay: null,
    });

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id));
    expect(row?.dateStartPrecision).toBe('UNKNOWN');
    expect(row?.dateStartYear).toBeNull();
  });

  it('accepts YEAR precision with a negative year (BCE)', async () => {
    const id = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q1',
      dateStartYear: -44,
      dateStartPrecision: 'YEAR',
    });

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id));
    expect(row?.dateStartYear).toBe(-44);
  });

  it('rejects DAY end precision without an end day (chk_date_end_consistency)', async () => {
    const error = await captureError(() =>
      insertNode(testDb.db, {
        identityScheme: 'WIKIDATA',
        wikidataQid: 'Q1',
        dateEndYear: 1900,
        dateEndMonth: 6,
        dateEndDay: null,
        dateEndPrecision: 'DAY',
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});
