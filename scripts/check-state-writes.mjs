#!/usr/bin/env node
/**
 * State-write enforcement (M7, acceptance criterion #2).
 *
 * The expansion state machine has exactly two sanctioned writers:
 *   - src/lib/queue/transition.ts  (the single transition function)
 *   - src/lib/queue/claim.ts       (the atomic SKIP LOCKED claim)
 *
 * Everything else must go through them. This grep-style check scans the
 * production source (excluding tests and generated migrations) and fails if any
 * other file writes `expansionRequests.status` or a node's
 * `upstreamState`/`downstreamState`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const ALLOWED = new Set([
  'src/lib/queue/transition.ts',
  'src/lib/queue/claim.ts',
  // edges.status writers: the ACTIVE insert path, node-merge retirement, and
  // the feedback-driven auto-hide rule (M8).
  'src/lib/graph/insertVerifiedEdge.ts',
  'src/lib/graph/mergeNodes.ts',
  'src/lib/feedback/autoHide.ts',
]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === 'test' || entry === 'migrations') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const CHECKS = [
  {
    name: 'raw UPDATE "expansionRequests" ... status',
    re: /UPDATE\s+"expansionRequests"[\s\S]{0,1000}?"status"\s*=/g,
  },
  {
    name: '.update(expansionRequests).set(... status ...)',
    re: /\.update\(\s*expansionRequests\s*\)[\s\S]{0,200}?\.set\([\s\S]{0,400}?\bstatus\s*[:=]/g,
  },
  {
    name: 'raw UPDATE "nodes" ... upstreamState/downstreamState',
    re: /UPDATE\s+"nodes"[\s\S]{0,1000}?"(?:upstreamState|downstreamState)"\s*=/g,
  },
  {
    name: '.update(nodes).set(... upstreamState/downstreamState ...)',
    re: /\.update\(\s*nodes\s*\)[\s\S]{0,200}?\.set\([\s\S]{0,400}?(?:upstreamState|downstreamState)\s*:/g,
  },
  {
    name: 'raw UPDATE "edges" ... status',
    re: /UPDATE\s+"edges"[\s\S]{0,1000}?"status"\s*=/g,
  },
  {
    name: '.update(edges).set(... status ...)',
    re: /\.update\(\s*edges\s*\)[\s\S]{0,200}?\.set\([\s\S]{0,400}?\bstatus\s*[:=]/g,
  },
];

const allowedHits = [];
const violations = [];

for (const file of walk(SRC, [])) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');
  for (const check of CHECKS) {
    const matches = text.match(check.re);
    if (!matches) continue;
    const record = { file: rel, check: check.name, count: matches.length };
    if (ALLOWED.has(rel)) allowedHits.push(record);
    else violations.push(record);
  }
}

console.log('State-write enforcement');
console.log('=======================');
console.log('Scanned production files under src/ (excluding src/test and migrations).');
console.log(`Allowlist: ${[...ALLOWED].join(', ')}\n`);

console.log('Sanctioned writes found in allowlisted files:');
if (allowedHits.length === 0) {
  console.log('  (none detected)');
} else {
  for (const hit of allowedHits) {
    console.log(`  [ALLOW] ${hit.file} — ${hit.check} (${hit.count})`);
  }
}

console.log('\nDisallowed writes outside the allowlist:');
if (violations.length === 0) {
  console.log('  (none)');
} else {
  for (const v of violations) {
    console.log(`  [FAIL] ${v.file} — ${v.check} (${v.count})`);
  }
}

console.log('=======================');
if (violations.length === 0) {
  console.log('Result: PASS (no state writes outside the allowlist)');
} else {
  console.log(`Result: FAIL (${violations.length} violating file/pattern pair(s))`);
  process.exitCode = 1;
}
