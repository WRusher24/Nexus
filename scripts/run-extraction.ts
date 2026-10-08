/**
 * Human quality-gate CLI for the M6 extraction pipeline.
 *
 * Usage:
 *   pnpm tsx scripts/run-extraction.ts --topic "Treaty of Versailles"
 *   pnpm tsx scripts/run-extraction.ts --topic "World War I" --direction DOWNSTREAM --provider deepseek
 *
 * This script makes LIVE calls to Wikipedia, Wikidata, and the configured LLM
 * provider. It is NOT run by `pnpm run verify`; it is the manual quality gate
 * between M6 and M7.
 *
 * Requires EXTRACTION_PROVIDER and the matching API key env var
 * (OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY) plus DATABASE_URL.
 */

import { eq, inArray } from 'drizzle-orm';
import { config as loadEnv } from 'dotenv';
import { edges, evidenceSpans, extractionRuns, nodes, rejectedProposals } from '../src/lib/db/schema';
import { createRootNode } from '../src/lib/graph/createRootNode';
import type { Database } from '../src/lib/graph/types';
import { runExtraction } from '../src/lib/extraction/orchestrator';
import { getProvider } from '../src/lib/extraction/provider';
import type { RunExtractionResult } from '../src/lib/extraction/types';
import { createResolver } from '../src/lib/wikipedia/qidResolver';
import { RateLimiter } from '../src/lib/wikipedia/rateLimit';
import { createSearchService } from '../src/lib/wikipedia/search';
import { createSourceDocumentService } from '../src/lib/wikipedia/sourceDocuments';
import { createWikidataClient } from '../src/lib/wikipedia/wikidataClient';
import { createWikipediaClient } from '../src/lib/wikipedia/wikipediaClient';
import type { Direction } from '../src/lib/wikipedia/types';

loadEnv({ path: '.env.local' });

/**
 * `src/lib/db/client.ts` reads DATABASE_URL when the module is evaluated and
 * returns a union of the Neon-HTTP and node-postgres Drizzle types, but the
 * graph layer is typed against `NodePgDatabase`. It is therefore imported
 * dynamically inside `main()` (after `.env.local` is loaded) and narrowed once
 * here. Every real deployment backs the client with node-postgres.
 */
let database: Database;

interface CliArgs {
  topic: string;
  direction: Direction;
  provider?: string;
  model?: string;
  candidateIndex: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    topic: '',
    direction: 'UPSTREAM',
    candidateIndex: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--topic':
        if (next) args.topic = next;
        i += 1;
        break;
      case '--direction':
        if (next === 'UPSTREAM' || next === 'DOWNSTREAM') args.direction = next;
        i += 1;
        break;
      case '--provider':
        if (next) args.provider = next;
        i += 1;
        break;
      case '--model':
        if (next) args.model = next;
        i += 1;
        break;
      case '--candidate':
        if (next) args.candidateIndex = Number.parseInt(next, 10) || 0;
        i += 1;
        break;
      default:
        break;
    }
  }
  if (!args.topic) {
    throw new Error('Usage: run-extraction.ts --topic "<topic>" [--direction UPSTREAM|DOWNSTREAM]');
  }
  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { db } = await import('../src/lib/db/client');
  database = db as unknown as Database;
  const contactEmail = process.env.WIKIPEDIA_CONTACT_EMAIL ?? 'dev@example.com';
  const rateLimiter = new RateLimiter({ requestsPerSecond: 5 });

  const wikipedia = createWikipediaClient({ contactEmail, rateLimiter });
  const wikidata = createWikidataClient({ contactEmail, rateLimiter });
  const resolver = createResolver(wikidata);
  const searchService = createSearchService({ wikipedia, wikidata, resolver });
  const sourceDocuments = createSourceDocumentService({ db: database, wikipedia });
  const provider = getProvider({
    ...(args.provider ? { providerId: args.provider } : {}),
    ...(args.model ? { model: args.model } : {}),
  });

  log(`Searching Wikipedia for "${args.topic}"...`);
  const candidates = await searchService.search(args.topic, 5);
  if (candidates.length === 0) {
    log('No candidates found.');
    process.exitCode = 1;
    return;
  }
  log(`Found ${candidates.length} candidate(s):`);
  candidates.forEach((candidate, index) => {
    log(
      `  [${index}] ${candidate.title} (page ${candidate.pageId}, QID ${candidate.resolvedQid ?? 'none'}, confidence ${candidate.qidConfidence})`,
    );
  });

  const chosen = candidates[Math.min(args.candidateIndex, candidates.length - 1)];
  if (!chosen) {
    log('Candidate index out of range.');
    process.exitCode = 1;
    return;
  }
  log(`Chosen: [${args.candidateIndex}] ${chosen.title}`);
  log();

  const root = await createRootNode(database, sourceDocuments, wikidata, { candidate: chosen });
  log(`Root node: ${root.nodeId} (${root.outcome}, qid ${root.qid ?? 'none'})`);
  log(`Provider: ${provider.providerId} / ${provider.defaultModel}`);
  log(`Direction: ${args.direction}`);
  log();

  const result = await runExtraction(database, {
    provider,
    sourceDocumentService: sourceDocuments,
    resolver,
    wikipedia,
    wikidata,
  }, { focalNodeId: root.nodeId, direction: args.direction });

  await printSummary(result);
}

async function printSummary(result: RunExtractionResult): Promise<void> {
  if (result.outcome !== 'COMPLETED') {
    log('=== Extraction result ===');
    log(`Outcome: ${result.outcome}`);
    if ('reason' in result) log(`Reason: ${result.reason}`);
    if ('error' in result) log(`Stage: ${result.stage} | Error: ${result.error} | retryable=${result.retryable}`);
    process.exitCode = 1;
    return;
  }

  const [run] = await database
    .select()
    .from(extractionRuns)
    .where(eq(extractionRuns.id, result.extractionRunId));

  log('=== Extraction result ===');
  log(`Outcome: COMPLETED (${result.finalState})`);
  log(`Proposed: ${result.edgesProposed} | Accepted: ${result.edgesAccepted} | Rejected: ${result.edgesRejected}`);
  log(`Cost (USD): ${result.estimatedCostUsd.toFixed(6)}`);
  if (run?.sparsenessReason) log(`Sparseness: ${run.sparsenessReason}`);
  log();

  if (result.edgesAccepted > 0) {
    log('--- Accepted edges ---');
    const acceptedEdges = await database
      .select()
      .from(edges)
      .where(eq(edges.firstExtractionRunId, result.extractionRunId));

    const nodeIds = new Set<string>();
    for (const edge of acceptedEdges) {
      nodeIds.add(edge.causeNodeId);
      nodeIds.add(edge.effectNodeId);
    }
    const nodeRows = nodeIds.size
      ? await database.select().from(nodes).where(inArray(nodes.id, [...nodeIds]))
      : [];
    const nodeById = new Map(nodeRows.map((row) => [row.id, row]));

    const evidenceRows = acceptedEdges.length
      ? await database
          .select()
          .from(evidenceSpans)
          .where(inArray(evidenceSpans.edgeId, acceptedEdges.map((edge) => edge.id)))
      : [];
    const evidenceByEdge = new Map<string, typeof evidenceRows>();
    for (const span of evidenceRows) {
      const list = evidenceByEdge.get(span.edgeId) ?? [];
      list.push(span);
      evidenceByEdge.set(span.edgeId, list);
    }

    acceptedEdges.forEach((edge, index) => {
      const cause = nodeById.get(edge.causeNodeId);
      const effect = nodeById.get(edge.effectNodeId);
      const causeLabel = cause ? `${cause.label}${cause.wikidataQid ? ` (${cause.wikidataQid})` : ''}` : edge.causeNodeId;
      const effectLabel = effect ? `${effect.label}${effect.wikidataQid ? ` (${effect.wikidataQid})` : ''}` : edge.effectNodeId;
      log(`${index + 1}. ${causeLabel} --${edge.relationType}--> ${effectLabel}  [rank ${edge.importanceRank}, chronology ${edge.chronologyStatus}]`);
      for (const span of evidenceByEdge.get(edge.id) ?? []) {
        log(`   section: ${span.sectionTitle ?? '(none)'}`);
        log(`   quote: "${span.quoteText.slice(0, 200)}"`);
      }
    });
    log();
  }

  if (result.edgesRejected > 0) {
    log('--- Rejected proposals ---');
    const rejected = await database
      .select()
      .from(rejectedProposals)
      .where(eq(rejectedProposals.extractionRunId, result.extractionRunId));
    rejected.forEach((row, index) => {
      const data = row.proposalData as { proposal?: { relatedEntity?: { name?: string } } };
      const name = data.proposal?.relatedEntity?.name ?? '(unknown)';
      log(`${index + 1}. ${name}: ${row.rejectionReason}`);
    });
    log();
  }

  process.exitCode = 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
