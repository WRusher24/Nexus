import { describe, expect, it } from 'vitest';
import {
  createResolver,
  ENTITY_TYPE_TO_P31,
  mapInstanceOfToNodeType,
} from '../../../lib/wikipedia/qidResolver';
import type {
  WikidataClient,
  WikidataEntity,
  WikidataSearchResult,
} from '../../../lib/wikipedia/wikidataClient';

function entity(
  qid: string,
  overrides: Partial<WikidataEntity> = {},
): WikidataEntity {
  return {
    qid,
    label: 'Label',
    description: null,
    aliases: [],
    wikipediaTitle: null,
    claims: {},
    instanceOf: [],
    ...overrides,
  };
}

function searchResultFor(
  e: WikidataEntity,
  text = e.label,
): WikidataSearchResult {
  return {
    qid: e.qid,
    label: e.label,
    description: e.description,
    aliases: e.aliases,
    match: { text, language: 'en', type: 'label' },
  };
}

function fakeWikidata(entities: WikidataEntity[]): WikidataClient {
  return {
    search: async () => entities.map((e) => searchResultFor(e)),
    getEntity: async (qid) => {
      const found = entities.find((e) => e.qid === qid);
      if (!found) throw new Error(`no entity ${qid}`);
      return found;
    },
    resolveRedirect: async (qid) => qid,
    getQidForWikipediaTitle: async () => null,
  };
}

describe('QID resolver', () => {
  it('scores an exact name, type and date match as HIGH', async () => {
    const resolver = createResolver(
      fakeWikidata([
        entity('Q8736', {
          label: 'Treaty of Versailles',
          description: 'peace treaty that ended World War I',
          claims: { P585: [{ time: '+1919-06-28T00:00:00Z', precision: 11, calendarmodel: 'Q1985727' }] },
          instanceOf: ['Q625298'],
        }),
      ]),
    );
    const result = await resolver.resolve('Treaty of Versailles', {
      entityType: 'POLICY',
      expectedYear: 1919,
      description: 'peace treaty ended World War I',
    });
    expect(result.confidence).toBe('HIGH');
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.qid).toBe('Q8736');
  });

  it('scores an alias match with correct type as MEDIUM or better', async () => {
    const resolver = createResolver(
      fakeWikidata([
        entity('Q517', {
          label: 'Napoleon Bonaparte',
          aliases: ['Napoleon'],
          instanceOf: ['Q5'],
        }),
      ]),
    );
    const result = await resolver.resolve('Napoleon', { entityType: 'ACTOR' });
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.qid).toBe('Q517');
  });

  it('downgrades when the name matches but the type disagrees', async () => {
    const resolver = createResolver(
      fakeWikidata([
        entity('Q308', { label: 'Mercury', instanceOf: ['Q3504248'] }),
      ]),
    );
    const result = await resolver.resolve('Mercury', { entityType: 'EVENT' });
    expect(result.confidence).toBe('MEDIUM');
    expect(result.scoreBreakdown.typeMatch).toBe(15);
  });

  it('scores LOW when the name matches but the date is centuries off', async () => {
    const resolver = createResolver(
      fakeWikidata([
        entity('Q1', {
          label: 'Some Other Label',
          claims: { P585: [{ time: '+1500-01-01T00:00:00Z', precision: 11, calendarmodel: 'Q1985727' }] },
          instanceOf: ['Q999'],
        }),
      ]),
    );
    const result = await resolver.resolve('Treaty of Versailles', {
      entityType: 'POLICY',
      expectedYear: 2000,
    });
    expect(result.confidence).toBe('LOW');
    expect(result.scoreBreakdown.dateMatch).toBe(0);
  });

  it('returns NONE and a null qid when nothing matches', async () => {
    const resolver = createResolver(
      fakeWikidata([
        entity('Q2', {
          label: 'Unrelated',
          description: 'wholly unrelated subject matter',
          claims: { P585: [{ time: '+1000-01-01T00:00:00Z', precision: 11, calendarmodel: 'Q1985727' }] },
          instanceOf: ['Q999'],
        }),
      ]),
    );
    const result = await resolver.resolve('Completely Different Thing', {
      entityType: 'EVENT',
      expectedYear: 2000,
      description: 'totally different phrase here',
    });
    expect(result.confidence).toBe('NONE');
    expect(result.qid).toBeNull();
  });

  it('returns the top-scoring candidate', async () => {
    const resolver = createResolver(
      fakeWikidata([
        entity('Q10', { label: 'Treaty of Versailles (1768)', instanceOf: ['Q131569'] }),
        entity('Q11', { label: 'Treaty of Versailles', instanceOf: ['Q625298'] }),
      ]),
    );
    const result = await resolver.resolve('Treaty of Versailles', {
      entityType: 'POLICY',
    });
    expect(result.qid).toBe('Q11');
  });

  it('populates all four score-breakdown components', async () => {
    const resolver = createResolver(
      fakeWikidata([entity('Q8736', { label: 'Treaty of Versailles' })]),
    );
    const result = await resolver.resolve('Treaty of Versailles');
    expect(Object.keys(result.scoreBreakdown).sort()).toEqual([
      'dateMatch',
      'descriptionMatch',
      'nameMatch',
      'typeMatch',
    ]);
    for (const value of Object.values(result.scoreBreakdown)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(25);
    }
  });

  it('sorts candidates by score descending and caps them at five', async () => {
    const entities = [
      entity('Q200', { label: 'Treaty of Versailles' }),
      entity('Q201', { label: 'Treaty of Versailles (1768)' }),
      entity('Q202', { label: 'Treaty of Versailles (1756)' }),
      entity('Q203', { label: 'Treaty of Versailles (1757)' }),
      entity('Q204', { label: 'Little Treaty of Versailles' }),
      entity('Q205', { label: 'Treaty of Paris' }),
    ];
    const resolver = createResolver(fakeWikidata(entities));
    const result = await resolver.resolve('Treaty of Versailles');
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    for (let i = 0; i < result.candidates.length - 1; i += 1) {
      expect(result.candidates[i]?.score).toBeGreaterThanOrEqual(
        result.candidates[i + 1]?.score ?? 0,
      );
    }
  });

  it('still resolves on name alone when no hint is provided', async () => {
    const resolver = createResolver(
      fakeWikidata([entity('Q8736', { label: 'Treaty of Versailles' })]),
    );
    const result = await resolver.resolve('Treaty of Versailles');
    expect(result.qid).toBe('Q8736');
    expect(result.confidence).not.toBe('NONE');
  });

  it('breaks score ties by the alphabetically-first QID', async () => {
    const resolver = createResolver(
      fakeWikidata([
        entity('Q200', { label: 'Same Label' }),
        entity('Q100', { label: 'Same Label' }),
      ]),
    );
    const result = await resolver.resolve('Same Label');
    expect(result.qid).toBe('Q100');
  });
});

describe('node-type mapping', () => {
  it('maps a peace treaty to POLICY', () => {
    expect(mapInstanceOfToNodeType(['Q625298'])).toBe('POLICY');
  });

  it('maps a human to ACTOR and returns null for unknown types', () => {
    expect(mapInstanceOfToNodeType(['Q5'])).toBe('ACTOR');
    expect(mapInstanceOfToNodeType(['Q999999'])).toBeNull();
  });

  it('exposes non-empty P31 mappings for every entity type', () => {
    for (const qids of Object.values(ENTITY_TYPE_TO_P31)) {
      expect(qids.length).toBeGreaterThan(0);
    }
  });
});
