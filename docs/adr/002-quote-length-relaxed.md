# ADR 002: Relaxed Max Length for Verbatim Quotes

## Status
Accepted

## Context
During Quality Gate benchmarking (M6), LLM extractions repeatedly triggered schema validation errors on `verbatimQuote` because DeepSeek frequently included multi-sentence contextual quotes exceeding the original 300-character limit.

## Decision
Increase `verbatimQuote` maximum length from 300 to 1000 characters in `EXTRACTION_SCHEMA_VERSION` 1.0.1.

## Consequences & Tradeoffs
- **Pros:** Prevents pipeline validation failures on valid, high-context historical quotes.
- **Cons:** Longer quotes are slightly harder to highlight nicely in UI views and carry a higher risk of minor whitespace/formatting drift during exact verification.
- **Monitoring Plan:** Monitor UI display performance and quote verification rates in production. If quote stitching or UI overflowing becomes an issue, adjust the chunking or prompt guidance.