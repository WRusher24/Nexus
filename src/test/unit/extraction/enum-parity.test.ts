import { describe, expect, it } from 'vitest';
import {
  datePrecisionEnum,
  directionEnum,
  nodeTypeEnum,
  relationTypeEnum,
} from '../../../lib/db/schema';
import {
  DatePrecisionEnum,
  DirectionEnum,
  EntityTypeEnum,
  RelationTypeEnum,
} from '../../../lib/extraction/schema';

/**
 * Critical parity guard: the Zod enums used to validate LLM output MUST exactly
 * match the PostgreSQL enums in the database schema. If someone changes one
 * side without the other, this test fails loudly.
 */
describe('enum parity with the database schema', () => {
  it('16. all four Zod enum pairs match their pgEnum values', () => {
    expect(EntityTypeEnum.options).toEqual(nodeTypeEnum.enumValues);
    expect(RelationTypeEnum.options).toEqual(relationTypeEnum.enumValues);
    expect(DatePrecisionEnum.options).toEqual(datePrecisionEnum.enumValues);
    expect(DirectionEnum.options).toEqual(directionEnum.enumValues);
  });
});
