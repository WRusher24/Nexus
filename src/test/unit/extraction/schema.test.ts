import { describe, expect, it } from 'vitest';
import { ExtractionOutputSchema } from '../../../lib/extraction/schema';

type Json = Record<string, unknown>;

function dateField(over: Json = {}): Json {
  return { year: null, month: null, day: null, precision: 'UNKNOWN', ...over };
}

function relatedEntity(over: Json = {}): Json {
  return {
    name: 'Related Entity',
    entityType: 'EVENT',
    dateStart: dateField(),
    dateEnd: dateField(),
    disambiguationHint: { description: 'a hint', approximateDateRange: '1914' },
    ...over,
  };
}

function edge(over: Json = {}): Json {
  return {
    relatedEntity: relatedEntity(),
    relationType: 'CAUSED',
    importanceRank: 5,
    contested: false,
    evidence: { verbatimQuote: 'a'.repeat(12), sectionTitle: 'Causes' },
    ...over,
  };
}

function baseOutput(over: Json = {}): Json {
  return {
    focalEntity: {
      name: 'Focal Entity',
      entityType: 'EVENT',
      dateStart: dateField(),
      dateEnd: dateField(),
    },
    direction: 'UPSTREAM',
    edges: [],
    metadata: { sparsenessReason: '', feedbackLoopsDecomposed: false },
    ...over,
  };
}

describe('ExtractionOutputSchema', () => {
  it('1. a minimal output with zero edges parses', () => {
    expect(ExtractionOutputSchema.safeParse(baseOutput()).success).toBe(true);
  });

  it('2. a rich output with three edges parses', () => {
    const output = baseOutput({ edges: [edge(), edge(), edge()] });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(true);
  });

  it('3. thirteen edges exceed the maximum of 12', () => {
    const output = baseOutput({ edges: Array.from({ length: 13 }, () => edge()) });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('4. a missing direction fails', () => {
    const output = baseOutput();
    delete output.direction;
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('5. an unknown entity type fails', () => {
    const output = baseOutput({
      edges: [edge({ relatedEntity: relatedEntity({ entityType: 'ERA' }) })],
    });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('6. an unknown relation type fails', () => {
    const output = baseOutput({ edges: [edge({ relationType: 'BECAUSE' })] });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('7. a quote of length 9 fails the minimum of 10', () => {
    const output = baseOutput({
      edges: [edge({ evidence: { verbatimQuote: 'a'.repeat(9), sectionTitle: 'Causes' } })],
    });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('8. a quote of length 1001 fails the maximum of 1000 (ADR 002)', () => {
    const output = baseOutput({
      edges: [edge({ evidence: { verbatimQuote: 'a'.repeat(1001), sectionTitle: 'Causes' } })],
    });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('9. importanceRank 0 fails', () => {
    const output = baseOutput({ edges: [edge({ importanceRank: 0 })] });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('10. importanceRank 11 fails', () => {
    const output = baseOutput({ edges: [edge({ importanceRank: 11 })] });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('11. an extra unknown field fails (strict mode)', () => {
    const output = baseOutput({ unexpected: true });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('12. a date with month 13 fails', () => {
    const output = baseOutput({
      edges: [
        edge({
          relatedEntity: relatedEntity({
            dateStart: dateField({ year: 1914, month: 13, day: 1, precision: 'DAY' }),
          }),
        }),
      ],
    });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(false);
  });

  it('13. an UNKNOWN date with all nulls passes', () => {
    const output = baseOutput({
      edges: [
        edge({
          relatedEntity: relatedEntity({
            dateStart: dateField({ year: null, month: null, day: null, precision: 'UNKNOWN' }),
          }),
        }),
      ],
    });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(true);
  });

  it('14. a YEAR-precision date with year 1914 passes', () => {
    const output = baseOutput({
      edges: [
        edge({
          relatedEntity: relatedEntity({
            dateStart: dateField({ year: 1914, month: null, day: null, precision: 'YEAR' }),
          }),
        }),
      ],
    });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(true);
  });

  it('15. a null sparsenessReason passes', () => {
    const output = baseOutput({
      metadata: { sparsenessReason: null, feedbackLoopsDecomposed: true },
    });
    expect(ExtractionOutputSchema.safeParse(output).success).toBe(true);
  });
});
