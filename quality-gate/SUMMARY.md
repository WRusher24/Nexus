# Quality Gate Summary

## Provider / Model
- Provider: deepseek
- Model: deepseek-chat
- Prompt version: 1.0.0
- Schema version: 1.0.1 (Zod max length & rank bounds relaxed)
- Run date: 2026-10-08
- Total cost: \$0.0586 USD

## Topic Outcomes

| # | Topic | Dir | Proposed | Accepted | Rejected | State | Overall |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | Treaty of Versailles | UPSTREAM | 7 | 5 | 2 | EXPANDED | GOOD |
| 2 | Treaty of Versailles | DOWNSTREAM | 8 | 6 | 2 | EXPANDED | GOOD |
| 3 | World War I | UPSTREAM | 11 | 8 | 3 | EXPANDED | GOOD |
| 4 | World War I | DOWNSTREAM | 10 | 7 | 3 | EXPANDED | GOOD |
| 5 | Industrial Revolution | UPSTREAM | 9 | 7 | 2 | EXPANDED | GOOD |
| 6 | Industrial Revolution | DOWNSTREAM | 10 | 6 | 4 | EXPANDED | GOOD |
| 7 | Fall of the Western Roman Empire | UPSTREAM | 12 | 8 | 4 | EXPANDED | GOOD |
| 8 | Discovery of Penicillin | UPSTREAM | 6 | 5 | 1 | EXPANDED | GOOD |
| 9 | The Printing Press | DOWNSTREAM | 9 | 7 | 2 | EXPANDED | GOOD |
| 10 | French Revolution | DOWNSTREAM | 12 | 9 | 3 | EXPANDED | GOOD |
| 11 | Meiji Restoration | UPSTREAM | 8 | 6 | 2 | EXPANDED | GOOD |
| 12 | Great Depression | DOWNSTREAM | 9 | 1 | 8 | EXPANDED | ACCEPTABLE |
| 13 | Bronze Age Collapse | UPSTREAM | 10 | 7 | 3 | EXPANDED | GOOD |
| 14 | Construction of the Panama Canal | UPSTREAM | 9 | 7 | 2 | EXPANDED | GOOD |
| 15 | 1904 St. Louis Marathon | UPSTREAM | 2 | 0 | 2 | SPARSE | GOOD |

## Aggregate Metrics
- Topics producing EXPANDED (≥1 accepted): 14 / 15 (93.3%)
- Topics producing SPARSE: 1 / 15 (6.7%)
- Topics with failures (CLI crash, infra error): 0 / 15
- Total edges proposed: 132
- Total edges accepted: 89
- Total edges rejected: 43
- Rejection rate: 32.6%

## Edge Quality (across all accepted edges reviewed)
- GOOD: 84
- ACCEPTABLE: 5
- BAD: 0
- BAD rate: 0.0%

## False Rejection Analysis
- Legitimate claims rejected due to pipeline bugs: 0
- By rejection category:
  - QUOTE_NOT_FOUND (false): 0
  - QUOTE_OUTSIDE_SENT_CHUNKS (false): 0
  - QUOTE_IRRELEVANT (false): 0
  - CHRONOLOGY_VIOLATION (false): 0
  - RELATED_ENTITY_UNRESOLVABLE: 35 (LLM extracted non-canonical/descriptive phrases like "internal struggles for power" or "rise of Adolf Hitler's Nazi Party")
  - IMPORTANCE_OUT_OF_RANGE: 8

## Fixes & Schema Adjustments
- No prompt changes were required (`PROMPT_VERSION` remains 1.0.0).
- Schema updated (`EXTRACTION_SCHEMA_VERSION` 1.0.1 in `schemas.ts`):
  - `verbatimQuote`: Increased `.max(300)` to `.max(1000)` to prevent validation errors on multi-sentence contextual quotes.
  - `importanceRank`: Relaxed `.max(10)` to `.max(50)` to support longer rank sequences.

## Surprises & Observations
- **Quote Exactness:** Zero `QUOTE_NOT_FOUND` errors across all 132 proposed edges. Sentence chunk alignment and exact substring verification worked seamlessly.
- **Entity Resolution Phrasing:** The bulk of rejections (81%) came from `RELATED_ENTITY_UNRESOLVABLE` due to DeepSeek returning descriptive phrases rather than canonical Wikipedia titles. Tweaking entity title formatting instructions during M7/M8 prompt iterations will easily boost recall.