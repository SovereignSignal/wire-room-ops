# Program Identity Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pipeline durable program identity per `docs/superpowers/specs/2026-07-10-program-identity-design.md` — a `programs` registry, a resolution service, an act-and-report intake gate, digest surfacing, and a corpus backfill.

**Architecture:** New `src/services/program-identity.ts` owns the table, key normalization, 3-pass matcher, round assessment, LLM canonicalization, and the shared post-classify finalize helper. `checkDuplicate` gains an opt-in Layer 1.75; process-raw and daily-intake opt in and demote with `actioned_by='program-gate'`. The digest joins `programs` for history lines and adds a `gate` ledger lane. A manual backfill script clusters 10.7k entries into ~1k programs and repairs duplicate-chain cycles.

**Tech Stack:** Node.js/TypeScript, Express, Postgres (`pg`), Grok chat completions (via `config.apis.grok`), `node:test` + ts-node transpile-only.

## Global Constraints

- Branch `feat/program-identity` (spec already committed at its tip). Baseline: 207/207 tests, `npm run typecheck` exit 0.
- Confidence mapping (spec-pinned): key exact = 0.95, substring = 0.85, token-overlap = 0.75, URL agreement +0.10 (cap 0.99), org mismatch VETOES substring/token matches. Auto-dupe bar: ≥ 0.85 AND same_round AND program has ≥1 prior entry.
- Round ambiguity resolves to `new_round` (filtering a real update costs more than showing a near-dupe — same bias rule as decided-recheck).
- The gate is fail-open everywhere: any resolver error logs and never blocks intake.
- The Telegram/manual dumb pipe (`intake-core.ts`) is NOT modified — its `urlOnly` dedup stays as-is.
- `STARTUP_MIGRATIONS` entries keep the exact `{ name: 'kebab', run: ensureFn }` single-line format (regex-pinned by tests/enum-lockstep.test.js).
- No DB CHECK constraint changes; `matchType: 'program'` is TS-only.
- Never pipe `tsc` — run `npm run typecheck` bare and check the exit code.
- Commit per task with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Grok calls log usage with `purpose: 'program-identity'` (fire-and-forget `logApiUsage`).

## File Structure

- Create: `src/services/program-identity.ts` — table DDL, key normalization, matcher, round logic, canonicalization, finalize helper, history line.
- Create: `src/scripts/program-backfill.ts` — manual clustering/backfill/chain-repair script (`--dry-run`).
- Modify: `src/db/startup-migrations.ts` (one entry), `src/services/dedup.ts` (Layer 1.75), `src/jobs/process-raw.ts` + `src/jobs/daily-intake.ts` (opt-in + demotion + finalize), `src/jobs/daily-digest.ts` (gate lane + history join), `src/services/email.ts` (history line render), `CLAUDE.md`.
- Tests: `tests/program-identity.test.js` (new), `tests/dedup-program-gate.test.js` (new), `tests/program-backfill.test.js` (new), `tests/daily-digest.test.js` + `tests/digest-email.test.js` (extend).

---

### Task 1: Key normalization + programs table

**Files:**
- Create: `src/services/program-identity.ts`
- Modify: `src/db/startup-migrations.ts`
- Test: `tests/program-identity.test.js` (create)

**Interfaces:**
- Produces: `normalizeProgramKey(name: string): string`; `ensureProgramsTable(): Promise<void>`; `ProgramRow` interface (exact fields in code below). Later tasks import all three.

- [ ] **Step 1: Write the failing tests**

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProgramKey } = require('../src/services/program-identity');

// Real corpus variants — one program, one key.
test('normalizeProgramKey collapses round/cohort/date noise', () => {
  const variants = [
    'Anthropic Fellows Program',
    'Anthropic Fellows Program 2026',
    'Anthropic Fellows Program (Sept 2026 cohort)',
    'Anthropic Fellows Program (July 2026 cohort)',
    'Anthropic Fellows Program — May & July 2026 Cohorts',
    'Anthropic Fellows Program for AI safety research',
  ];
  const keys = new Set(variants.map(normalizeProgramKey));
  // "for AI safety research" is descriptive suffix, kept — two keys max
  assert.ok(keys.size <= 2, `expected <=2 keys, got ${[...keys].join(', ')}`);
  assert.equal(normalizeProgramKey('Anthropic Fellows Program 2026'), normalizeProgramKey('Anthropic Fellows Program (Sept 2026 cohort)'));
});

test('normalizeProgramKey strips rounds, quarters, seasons, fund numbers', () => {
  assert.equal(normalizeProgramKey('Cardano Catalyst Fund14'), normalizeProgramKey('Cardano Catalyst Fund12'));
  assert.equal(normalizeProgramKey('Uniswap Acceleration Season 3'), normalizeProgramKey('Uniswap Acceleration Season 7'));
  assert.equal(normalizeProgramKey('Zcash CDRGP Q3/Q4 2026'), normalizeProgramKey('Zcash CDRGP Q1 2027'));
  assert.equal(normalizeProgramKey('Optimism Round 8 Retro Funding'), normalizeProgramKey('Optimism Round 6 Retro Funding'));
});

test('normalizeProgramKey keeps genuinely different programs apart', () => {
  assert.notEqual(normalizeProgramKey('Arbitrum Foundation Audit Program'), normalizeProgramKey('Arbitrum Open House'));
  assert.notEqual(normalizeProgramKey('Anthropic Fellows Program'), normalizeProgramKey('Anthropic Economic Futures Initiative'));
  assert.notEqual(normalizeProgramKey('Claude Corps Fellowship'), normalizeProgramKey('Claude for Open Source'));
});

test('normalizeProgramKey handles empty/degenerate input', () => {
  assert.equal(normalizeProgramKey(''), '');
  assert.equal(normalizeProgramKey('2026'), '');
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/program-identity.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/services/program-identity.ts`:

```ts
/**
 * Program identity — canonical program registry + resolution.
 *
 * The pipeline has URL identity (seen_urls) and exact-name identity
 * (dedup Layer 1.5), but no PROGRAM identity: the same program re-enters
 * under every new name variant and URL (Anthropic Fellows: ~60 entries,
 * 15+ name variants). This service owns the `programs` table and resolves
 * entries to canonical programs. Design: docs/superpowers/specs/2026-07-10-
 * program-identity-design.md. Table DDL lives here (same pattern as
 * org_profiles living in org-extractor.ts).
 */
import { getPool } from '../db';

// ── Key normalization ───────────────────────────────────────────────────
// The primary identity key: lowercase alnum with round/cohort/date noise
// removed BEFORE squashing, so "Fund14" ≡ "Fund12" and "(Sept 2026 cohort)"
// vanishes entirely.
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
const NOISE_PATTERNS: RegExp[] = [
  /\b20\d\d\b/g,                                  // years
  new RegExp(`\\b(?:${MONTHS})\\b`, 'gi'),        // month names
  /\bcohorts?\b/gi,
  /\brounds?\s*\d*\b/gi,
  /\bbatch(?:es)?\s*\d*\b/gi,
  /\bwaves?\s*\d*\b/gi,
  /\bseasons?\s*\d*\b/gi,
  /\bfund\s*(\d+)\b/gi,                           // Fund14 → fund (number dropped below)
  /\bq[1-4]\b/gi,
  /\bh[12]\b/gi,
  /\b\d+(?:st|nd|rd|th)\b/gi,                     // ordinals
];

export function normalizeProgramKey(name: string): string {
  let s = (name || '').toLowerCase();
  s = s.replace(/\bfund\s*\d+\b/gi, 'fund');
  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');
  return s.replace(/[^a-z0-9]/g, '');
}

// ── Table ───────────────────────────────────────────────────────────────
export interface ProgramRow {
  id: number;
  canonical_name: string;
  normalized_key: string;
  org_id: number | null;
  org_name: string | null;
  wire: string | null;
  aliases: string[];
  canonical_url: string | null;
  url_domains: string[];
  canonical_entry_id: number | null;
  latest_round_label: string | null;
  latest_deadline: string | null;
  entry_count: number;
  approved_count: number;
  declined_count: number;
  last_decision: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export async function ensureProgramsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS programs (
    id SERIAL PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    org_id INTEGER REFERENCES org_profiles(id) ON DELETE SET NULL,
    org_name TEXT,
    wire TEXT,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    canonical_url TEXT,
    url_domains TEXT[] NOT NULL DEFAULT '{}',
    canonical_entry_id INTEGER,
    latest_round_label TEXT,
    latest_deadline DATE,
    entry_count INTEGER NOT NULL DEFAULT 0,
    approved_count INTEGER NOT NULL DEFAULT 0,
    declined_count INTEGER NOT NULL DEFAULT 0,
    last_decision TEXT,
    first_seen DATE,
    last_seen DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (normalized_key)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_programs_org ON programs(org_id)`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_program ON scan_entries(program_id)`);
}
```

In `src/db/startup-migrations.ts`: add the import `import { ensureProgramsTable } from '../services/program-identity';` next to the existing service imports, and append ONE line to the list, after `{ name: 'org-profiles', run: ensureOrgProfilesTable },` (programs references org_profiles, so it must run later):

```ts
  { name: 'programs', run: ensureProgramsTable },
```

- [ ] **Step 4: Verify** — `node --test tests/program-identity.test.js` → PASS; `npm test`; `npm run typecheck` bare → exit 0.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(programs): normalizeProgramKey + programs table"` (+trailer).

---

### Task 2: Resolution matcher, round assessment, history

**Files:**
- Modify: `src/services/program-identity.ts`
- Test: `tests/program-identity.test.js` (append)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces (exact — Tasks 4-7 rely on them):
  - `interface ProgramMatch { program: ProgramRow; confidence: number; pass: 'key' | 'substring' | 'tokens'; urlBoost: boolean }`
  - `resolveProgram(pool, candidate: { name: string; orgName?: string | null; sourceUrl?: string | null; wire?: string | null }): Promise<ProgramMatch | null>` — `pool` is any `{ query }`-shaped object (fake-pool testable).
  - `interface RoundVerdict { verdict: 'same_round' | 'new_round'; roundLabel: string | null }`
  - `assessRound(program: ProgramRow, candidate: { name: string; deadline?: string | null }): RoundVerdict` — pure.
  - `extractRoundLabel(name: string): string | null` — pure.
  - `historyLine(p: ProgramRow): string` — pure display string, e.g. `seen 61× · approved 1× · declined 12× · last declined 2026-07-07`.

- [ ] **Step 1: Write failing tests (append)**

```js
const {
  resolveProgram, assessRound, extractRoundLabel, historyLine,
} = require('../src/services/program-identity');

function fakeProgram(overrides = {}) {
  return {
    id: 1, canonical_name: 'Anthropic Fellows Program', normalized_key: normalizeProgramKey('Anthropic Fellows Program'),
    org_id: null, org_name: 'Anthropic', wire: 'ai',
    aliases: ['Anthropic Fellows Program 2026', 'Anthropic AI Safety Fellowship'],
    canonical_url: 'https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/',
    url_domains: ['alignment.anthropic.com'], canonical_entry_id: 8416,
    latest_round_label: 'july 2026 cohort', latest_deadline: '2026-06-30',
    entry_count: 60, approved_count: 1, declined_count: 12,
    last_decision: 'declined 2026-07-07', first_seen: '2026-03-09', last_seen: '2026-07-09',
    ...overrides,
  };
}

function programPool(rows) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return { rows }; } };
}

test('resolveProgram: normalized-key exact match = 0.95', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, { name: 'Anthropic Fellows Program (Dec 2026 cohort)', wire: 'ai' });
  assert.equal(m.pass, 'key');
  assert.equal(m.confidence, 0.95);
});

test('resolveProgram: alias match counts as key match', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, { name: 'Anthropic AI Safety Fellowship 2027', wire: 'ai' });
  assert.ok(m, 'alias should resolve');
  assert.equal(m.pass, 'key');
});

test('resolveProgram: URL domain agreement boosts confidence', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, {
    name: 'Anthropic Research Fellowship', // token overlap only
    sourceUrl: 'https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/31',
  });
  assert.ok(m);
  assert.equal(m.urlBoost, true);
  assert.ok(m.confidence >= 0.85, `boosted token match should reach the bar, got ${m.confidence}`);
});

test('resolveProgram: org mismatch vetoes non-key matches', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, { name: 'OpenAI Fellows Program Something', orgName: 'OpenAI' });
  assert.equal(m, null, 'different org must not fuzzy-match');
});

test('resolveProgram: no rows → null', async () => {
  const m = await resolveProgram(programPool([]), { name: 'Brand New Thing Grants' });
  assert.equal(m, null);
});

test('extractRoundLabel finds cohort/round/fund tokens', () => {
  assert.equal(extractRoundLabel('Anthropic Fellows Program (Sept 2026 cohort)'), 'sept 2026 cohort');
  assert.equal(extractRoundLabel('Cardano Catalyst Fund14'), 'fund14');
  assert.equal(extractRoundLabel('Optimism Round 8'), 'round 8');
  assert.equal(extractRoundLabel('NLnet Open Call'), null);
});

test('assessRound: differing round label = new_round; same/absent = same_round; ambiguity → new_round', () => {
  const p = fakeProgram();
  assert.equal(assessRound(p, { name: 'Anthropic Fellows Program (Sept 2026 cohort)' }).verdict, 'new_round');
  assert.equal(assessRound(p, { name: 'Anthropic Fellows Program (July 2026 cohort)' }).verdict, 'same_round');
  // no label on either side + later deadline → new_round
  const noLabel = fakeProgram({ latest_round_label: null });
  assert.equal(assessRound(noLabel, { name: 'Anthropic Fellows Program', deadline: '2026-09-30' }).verdict, 'new_round');
  // no label, no deadline signal → same_round (nothing indicates a new cycle)
  assert.equal(assessRound(noLabel, { name: 'Anthropic Fellows Program' }).verdict, 'same_round');
});

test('historyLine composes the display string', () => {
  assert.equal(historyLine(fakeProgram()), 'seen 60× · approved 1× · declined 12× · last declined 2026-07-07');
  assert.equal(historyLine(fakeProgram({ approved_count: 0, declined_count: 0, last_decision: null, entry_count: 3 })), 'seen 3×');
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement** (append to `src/services/program-identity.ts`):

```ts
// ── Resolution ──────────────────────────────────────────────────────────
export interface ProgramMatch { program: ProgramRow; confidence: number; pass: 'key' | 'substring' | 'tokens'; urlBoost: boolean }

const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tokensOf = (s: string) => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 3));
const domainOf = (url: string | null | undefined): string | null => {
  const m = (url || '').match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
};

type QueryPool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function resolveProgram(
  pool: QueryPool,
  candidate: { name: string; orgName?: string | null; sourceUrl?: string | null; wire?: string | null },
): Promise<ProgramMatch | null> {
  const key = normalizeProgramKey(candidate.name);
  if (!key) return null;
  // Candidate pull: cheap prefilter on key prefix OR shared org/wire keeps the
  // scan bounded; final scoring happens in JS (mirrors findSimilarOrg's style).
  const { rows } = await pool.query(
    `SELECT * FROM programs
     WHERE normalized_key = $1
        OR normalized_key LIKE $2 || '%' OR $2 LIKE normalized_key || '%'
        OR ($3::text IS NOT NULL AND lower(org_name) = lower($3))
        OR ($4::text IS NOT NULL AND $4 = ANY(url_domains))
     LIMIT 25`,
    [key, key.slice(0, 10), candidate.orgName ?? null, domainOf(candidate.sourceUrl) ?? null],
  ) as { rows: ProgramRow[] };
  if (rows.length === 0) return null;

  const candDomain = domainOf(candidate.sourceUrl);
  const candTokens = tokensOf(candidate.name);
  const candOrg = candidate.orgName ? norm(candidate.orgName) : null;

  let best: ProgramMatch | null = null;
  for (const p of rows) {
    const keys = [p.normalized_key, ...(p.aliases || []).map(normalizeProgramKey)];
    const orgAgrees = candOrg && p.org_name ? norm(p.org_name) === candOrg || norm(p.org_name).includes(candOrg) || candOrg.includes(norm(p.org_name)) : null;
    const urlBoost = Boolean(candDomain && ((p.url_domains || []).includes(candDomain) || domainOf(p.canonical_url) === candDomain));

    let pass: ProgramMatch['pass'] | null = null;
    if (keys.includes(key)) pass = 'key';
    else if (key.length >= 8 && keys.some(k => k.length >= 8 && (k.includes(key) || key.includes(k)))) pass = 'substring';
    else {
      const pTokens = tokensOf(`${p.canonical_name} ${(p.aliases || []).join(' ')}`);
      const shared = [...candTokens].filter(t => pTokens.has(t));
      const denom = Math.min(candTokens.size, pTokens.size) || 1;
      if (shared.length >= 2 && shared.length / denom >= 0.7) pass = 'tokens';
    }
    if (!pass) continue;
    // Org mismatch vetoes fuzzy passes (key match survives — the key IS the identity)
    if (pass !== 'key' && orgAgrees === false) continue;

    let confidence = pass === 'key' ? 0.95 : pass === 'substring' ? 0.85 : 0.75;
    if (urlBoost) confidence = Math.min(0.99, confidence + 0.10);
    if (!best || confidence > best.confidence) best = { program: p, confidence, pass, urlBoost };
  }
  return best;
}

// ── Round assessment ────────────────────────────────────────────────────
export interface RoundVerdict { verdict: 'same_round' | 'new_round'; roundLabel: string | null }

const ROUND_RE = new RegExp(
  `\\b(?:(?:${MONTHS})[\\s./&-]*)*20\\d\\d\\s*cohorts?\\b|\\bcohorts?\\b|\\bfund\\s*\\d+\\b|\\brounds?\\s*\\d+\\b|\\bseasons?\\s*\\d+\\b|\\bbatch(?:es)?\\s*\\d+\\b|\\bwaves?\\s*\\d+\\b|\\bq[1-4](?:\\s*/\\s*q[1-4])?\\s*20\\d\\d\\b|\\b20\\d\\d\\b`,
  'gi',
);

export function extractRoundLabel(name: string): string | null {
  // Grab the widest round-ish phrase: prefer "(...cohort)" parentheticals, else regex hits joined
  const paren = name.match(/\(([^)]*(?:cohort|round|batch|fund|season)[^)]*)\)/i);
  if (paren) return paren[1].trim().toLowerCase();
  const hits = name.match(ROUND_RE);
  if (!hits || hits.length === 0) return null;
  return hits.join(' ').trim().toLowerCase() || null;
}

export function assessRound(program: ProgramRow, candidate: { name: string; deadline?: string | null }): RoundVerdict {
  const candLabel = extractRoundLabel(candidate.name);
  const progLabel = program.latest_round_label ? program.latest_round_label.toLowerCase() : null;
  if (candLabel && progLabel) {
    return candLabel === progLabel
      ? { verdict: 'same_round', roundLabel: candLabel }
      : { verdict: 'new_round', roundLabel: candLabel }; // ambiguity → new_round bias
  }
  if (candLabel && !progLabel) return { verdict: 'new_round', roundLabel: candLabel };
  // No labels anywhere: a strictly later deadline signals a new cycle
  if (candidate.deadline && program.latest_deadline) {
    const cand = Date.parse(candidate.deadline);
    const prog = Date.parse(program.latest_deadline);
    if (!Number.isNaN(cand) && !Number.isNaN(prog) && cand > prog) {
      return { verdict: 'new_round', roundLabel: null };
    }
  }
  return { verdict: 'same_round', roundLabel: candLabel };
}

// ── Display ─────────────────────────────────────────────────────────────
export function historyLine(p: ProgramRow): string {
  const parts = [`seen ${p.entry_count}×`];
  if (p.approved_count > 0) parts.push(`approved ${p.approved_count}×`);
  if (p.declined_count > 0) parts.push(`declined ${p.declined_count}×`);
  if (p.last_decision) parts.push(`last ${p.last_decision}`);
  return parts.join(' · ');
}
```

- [ ] **Step 4: Verify** — focused test, `npm test`, `npm run typecheck` bare (exit 0).
- [ ] **Step 5: Commit** — `git commit -m "feat(programs): 3-pass resolver, round assessment, history line"`.

---

### Task 3: Creation, sighting, canonicalization, finalize helper

**Files:**
- Modify: `src/services/program-identity.ts`
- Test: `tests/program-identity.test.js` (append)

**Interfaces:**
- Consumes: `extractOrgFromName` from `../services/org-extractor` (pattern/alias org extraction, no LLM); `config.apis.grok` (`baseUrl`, `apiKey`); `logApiUsage` from `./api-usage`; `normalizeUrl` from `../utils/url`.
- Produces:
  - `createProgram(pool, data: { name: string; canonicalName?: string | null; orgName?: string | null; wire?: string | null; sourceUrl?: string | null; roundLabel?: string | null }): Promise<number>` — upsert by normalized_key, RETURNING id.
  - `recordSighting(pool, programId: number, entry: { name: string; sourceUrl?: string | null; deadline?: string | null; roundLabel?: string | null }): Promise<void>`
  - `canonicalizeBatch(entries: Array<{ id: number; name: string; description: string }>, fetchImpl?: typeof fetch): Promise<Array<{ id: number; org: string | null; program: string | null; round_label: string | null }>>`
  - `type ProgramResolutionStamp = { programId: number; confidence: number; verdict: 'same_round' | 'new_round'; roundLabel: string | null; historyLine: string }` (exported — this is also the shape `DedupResult.programResolution` carries in Task 5)
  - `finalizeProgramForEntry(pool, entry: { id: number; name: string; sourceUrl?: string | null; wire?: string | null; deadline?: string | null; description?: string | null }, resolution: ProgramResolutionStamp | null): Promise<void>` — the ONE post-dedup hook callers use; fail-open (never throws). When resolution is present it uses `resolution.verdict`/`roundLabel`/`historyLine` directly (no re-assessment) and calls `recordSighting(pool, resolution.programId, …)`.

- [ ] **Step 1: Failing tests (append)** — fake pool capturing SQL; canonicalizeBatch with injected fetch:

```js
const { createProgram, recordSighting, canonicalizeBatch, finalizeProgramForEntry } = require('../src/services/program-identity');

test('createProgram upserts by normalized_key and returns id', async () => {
  const pool = programPool([{ id: 42 }]);
  const id = await createProgram(pool, { name: 'Brand New Grants Round 2', canonicalName: 'Brand New Grants', orgName: 'BrandCo', wire: 'oss', sourceUrl: 'https://brand.co/grants', roundLabel: 'round 2' });
  assert.equal(id, 42);
  assert.match(pool.calls[0].sql, /INSERT INTO programs/);
  assert.match(pool.calls[0].sql, /ON CONFLICT \(normalized_key\)/);
});

test('canonicalizeBatch parses the LLM JSON and survives junk', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '[{"id": 7, "org": "Anthropic", "program": "Anthropic Fellows Program", "round_label": "sept 2026 cohort"}]' } }] }),
  });
  const out = await canonicalizeBatch([{ id: 7, name: 'Anthropic Fellows (Sept 2026)', description: 'x' }], fetchImpl);
  assert.deepEqual(out, [{ id: 7, org: 'Anthropic', program: 'Anthropic Fellows Program', round_label: 'sept 2026 cohort' }]);
  const bad = await canonicalizeBatch([{ id: 8, name: 'y', description: '' }], async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.deepEqual(bad, [], 'LLM failure returns empty, never throws');
});

test('finalizeProgramForEntry: resolution present → sighting recorded + metadata.program stamped', async () => {
  const pool = programPool([]);
  await finalizeProgramForEntry(pool, { id: 500, name: 'X Round 3', wire: 'ai' },
    { programId: 1, confidence: 0.95, verdict: 'same_round', roundLabel: null, historyLine: 'seen 60× · approved 1×' });
  const sqls = pool.calls.map(c => c.sql).join('\n');
  assert.match(sqls, /UPDATE programs/);
  assert.match(sqls, /program_id = /);
  assert.match(sqls, /'program'/); // metadata stamp
});

test('finalizeProgramForEntry: fail-open — a throwing pool never propagates', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  await finalizeProgramForEntry(pool, { id: 1, name: 'x' }, null); // must not throw
});
```

- [ ] **Step 2: verify failure. Step 3: Implement (append):**

```ts
import { config } from '../config';
import { logApiUsage } from './api-usage';
import { extractOrgFromName } from './org-extractor';
import { normalizeUrl } from '../utils/url';

export async function createProgram(
  pool: QueryPool,
  data: { name: string; canonicalName?: string | null; orgName?: string | null; wire?: string | null; sourceUrl?: string | null; roundLabel?: string | null },
): Promise<number> {
  const canonical = (data.canonicalName || data.name).trim();
  const key = normalizeProgramKey(canonical) || normalizeProgramKey(data.name);
  const dom = domainOf(data.sourceUrl);
  const { rows } = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key, org_name, wire, aliases, canonical_url, url_domains, latest_round_label, entry_count, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, ARRAY[$5]::text[], $6, CASE WHEN $7::text IS NULL THEN '{}'::text[] ELSE ARRAY[$7]::text[] END, $8, 0, CURRENT_DATE, CURRENT_DATE)
     ON CONFLICT (normalized_key) DO UPDATE SET
       aliases = (SELECT ARRAY(SELECT DISTINCT unnest(programs.aliases || ARRAY[$5]::text[]))),
       last_seen = CURRENT_DATE, updated_at = NOW()
     RETURNING id`,
    [canonical, key, data.orgName ?? null, data.wire ?? null, data.name, data.sourceUrl ? normalizeUrl(data.sourceUrl) : null, dom, data.roundLabel ?? null],
  );
  return rows[0].id;
}

export async function recordSighting(
  pool: QueryPool,
  programId: number,
  entry: { name: string; sourceUrl?: string | null; deadline?: string | null; roundLabel?: string | null },
): Promise<void> {
  const dom = domainOf(entry.sourceUrl);
  await pool.query(
    `UPDATE programs SET
       aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || ARRAY[$2]::text[]))),
       url_domains = CASE WHEN $3::text IS NULL OR $3 = ANY(url_domains) THEN url_domains ELSE url_domains || ARRAY[$3]::text[] END,
       entry_count = entry_count + 1,
       latest_round_label = COALESCE($4, latest_round_label),
       latest_deadline = GREATEST(COALESCE(latest_deadline, '1970-01-01'::date), COALESCE(NULLIF($5, '')::date, '1970-01-01'::date)),
       last_seen = CURRENT_DATE, updated_at = NOW()
     WHERE id = $1`,
    [programId, entry.name, dom, entry.roundLabel ?? null, entry.deadline ?? null],
  );
}

// ── LLM canonicalization (mirrors org-extractor's extractOrgsWithGrok) ──
export async function canonicalizeBatch(
  entries: Array<{ id: number; name: string; description: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ id: number; org: string | null; program: string | null; round_label: string | null }>> {
  if (entries.length === 0) return [];
  const start = Date.now();
  const entriesText = entries.map(e => `[ID:${e.id}] "${e.name}" — ${(e.description || '').substring(0, 100)}`).join('\n');
  const prompt = `For each grant/funding entry below, name the FUNDING PROGRAM canonically. Return ONLY a JSON array of {"id", "org", "program", "round_label"}.

Rules:
- "program" = funder + program name, WITHOUT cohort/round/dates (e.g. "Anthropic Fellows Program", not "Anthropic Fellows Program (Sept 2026 cohort)")
- "round_label" = the cohort/round/cycle phrase if present (e.g. "sept 2026 cohort", "fund14"), else null
- "org" = the funding organization (canonical name), or null if unclear
- If the entry names no identifiable program, "program": null

Entries:
${entriesText}

Return ONLY valid JSON array, no explanation.`;
  try {
    const response = await fetchImpl(`${config.apis.grok.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apis.grok.apiKey}` },
      body: JSON.stringify({ model: 'grok-4.20-beta-0309-non-reasoning', messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    });
    if (!response.ok) throw new Error(`grok ${((response as Response).status)}`);
    const data = await (response as Response).json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '[]';
    const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    logApiUsage({ provider: 'grok', model: 'grok-4.20-beta-0309-non-reasoning', purpose: 'program-identity', duration_ms: Date.now() - start });
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r: any) => r && typeof r.id === 'number')
      .map((r: any) => ({ id: r.id, org: r.org ?? null, program: r.program ?? null, round_label: r.round_label ?? null }));
  } catch (err) {
    logApiUsage({ provider: 'grok', model: 'grok-4.20-beta-0309-non-reasoning', purpose: 'program-identity', duration_ms: Date.now() - start, success: false, error_message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// ── The one post-dedup hook callers use ─────────────────────────────────
export type ProgramResolutionStamp = {
  programId: number; confidence: number;
  verdict: 'same_round' | 'new_round'; roundLabel: string | null; historyLine: string;
};

/**
 * Called by process-raw / daily-intake AFTER an entry survives dedup.
 * resolution present → record the sighting + stamp metadata.program.
 * resolution null → canonicalize (LLM, 1 entry) → create/attach a program.
 * Fail-open: every failure logs and returns; intake never blocks on identity.
 */
export async function finalizeProgramForEntry(
  pool: QueryPool,
  entry: { id: number; name: string; sourceUrl?: string | null; wire?: string | null; deadline?: string | null; description?: string | null },
  resolution: ProgramResolutionStamp | null,
): Promise<void> {
  try {
    if (resolution) {
      await recordSighting(pool, resolution.programId, { name: entry.name, sourceUrl: entry.sourceUrl, deadline: entry.deadline, roundLabel: resolution.roundLabel });
      const verdict = resolution.confidence >= 0.85 ? resolution.verdict : 'tentative';
      await pool.query(
        `UPDATE scan_entries SET program_id = $2,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $3::jsonb)
         WHERE id = $1`,
        [entry.id, resolution.programId, JSON.stringify({ id: resolution.programId, verdict, confidence: resolution.confidence, round_label: resolution.roundLabel, history: resolution.historyLine })],
      );
      return;
    }
    // New program: one small LLM call; deterministic fallback on failure
    const [canon] = await canonicalizeBatch([{ id: entry.id, name: entry.name, description: '' }]);
    const orgName = canon?.org ?? extractOrgFromName(entry.name);
    const programId = await createProgram(pool, {
      name: entry.name,
      canonicalName: canon?.program ?? null,
      orgName, wire: entry.wire ?? null, sourceUrl: entry.sourceUrl ?? null,
      roundLabel: canon?.round_label ?? extractRoundLabel(entry.name),
    });
    await pool.query(
      `UPDATE scan_entries SET program_id = $2,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $3::jsonb)
       WHERE id = $1`,
      [entry.id, programId, JSON.stringify({ id: programId, verdict: 'new_program' })],
    );
  } catch (err) {
    console.error(`[ProgramIdentity] finalize failed for entry ${entry.id} (fail-open):`, err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 4: Verify** (focused + `npm test` + bare typecheck). **Step 5: Commit** — `git commit -m "feat(programs): creation, sightings, LLM canonicalization, finalize hook"`.

---

### Task 4: Gate — Layer 1.75 in checkDuplicate

**Files:**
- Modify: `src/services/dedup.ts`
- Test: `tests/dedup-program-gate.test.js` (create)

**Interfaces:**
- Consumes: `resolveProgram`, `assessRound`, `historyLine` (Task 2).
- Produces: `checkDuplicate` options gain `programGate?: boolean`; `DedupResult.matchType` union gains `'program'`; `DedupResult` gains `programResolution?: ProgramResolutionStamp | null` (import the type from `./program-identity`; present whenever the gate ran AND matched, including on non-duplicate outcomes — callers stamp from it). Match becomes a duplicate ONLY when: confidence ≥ 0.85 AND verdict same_round AND `program.entry_count > 0` AND `program.canonical_entry_id` is not null; `matchedEntryId = program.canonical_entry_id`.

- [ ] **Step 1: Failing tests** — `tests/dedup-program-gate.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDuplicate } = require('../src/services/dedup');

// Fake pool that answers seen_urls/name-layer queries empty, and answers the
// programs candidate query with a canned program row.
function gatePool(programRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM programs/.test(sql)) return { rows: programRows };
      return { rows: [] };
    },
  };
}

const PROGRAM = {
  id: 9, canonical_name: 'Anthropic Fellows Program', normalized_key: 'anthropicfellowsprogram',
  org_id: null, org_name: 'Anthropic', wire: 'ai', aliases: [],
  canonical_url: null, url_domains: [], canonical_entry_id: 8416,
  latest_round_label: 'july 2026 cohort', latest_deadline: null,
  entry_count: 60, approved_count: 1, declined_count: 12,
  last_decision: 'declined 2026-07-07', first_seen: null, last_seen: null,
};

test('program gate: same round at key confidence → duplicate pointing at the canonical entry', async () => {
  const r = await checkDuplicate(gatePool([PROGRAM]), { sourceUrl: 'https://random.example/x', name: 'Anthropic Fellows Program (July 2026 cohort)', wire: 'ai' }, 180, { programGate: true });
  assert.equal(r.isDuplicate, true);
  assert.equal(r.matchType, 'program');
  assert.equal(r.matchedEntryId, 8416);
  assert.match(r.reason, /seen 60×/);
});

test('program gate: NEW round resolves but does not block; resolution rides on the result', async () => {
  const r = await checkDuplicate(gatePool([PROGRAM]), { sourceUrl: 'https://random.example/x', name: 'Anthropic Fellows Program (Sept 2026 cohort)', wire: 'ai' }, 180, { programGate: true });
  assert.equal(r.isDuplicate, false);
  assert.equal(r.programResolution.verdict, 'new_round');
  assert.equal(r.programResolution.programId, 9);
});

test('program gate: off by default and under urlOnly', async () => {
  const p1 = gatePool([PROGRAM]);
  await checkDuplicate(p1, { sourceUrl: 'https://a.example/x', name: 'Anthropic Fellows Program (July 2026 cohort)', wire: 'ai' }, 180);
  assert.ok(!p1.calls.some(c => /FROM programs/.test(c.sql)), 'no gate without opt-in');
  const p2 = gatePool([PROGRAM]);
  await checkDuplicate(p2, { sourceUrl: 'https://a.example/x', name: 'Anthropic Fellows Program (July 2026 cohort)', wire: 'ai' }, 180, { urlOnly: true, programGate: true });
  assert.ok(!p2.calls.some(c => /FROM programs/.test(c.sql)), 'urlOnly wins — dumb pipe stays URL-only');
});

test('program gate: resolver failure fails open', async () => {
  const pool = { async query(sql) { if (/FROM programs/.test(sql)) throw new Error('boom'); return { rows: [] }; } };
  const r = await checkDuplicate(pool, { sourceUrl: 'https://a.example/x', name: 'Anything', wire: 'ai' }, 180, { programGate: true });
  assert.equal(r.isDuplicate, false);
});
```

- [ ] **Step 2: verify failure. Step 3: Implement** in `src/services/dedup.ts`:

Add to imports: `import { resolveProgram, assessRound, historyLine, ProgramResolutionStamp } from './program-identity';`
Extend the options type on `checkDuplicate` from `options?: { urlOnly?: boolean }` to `options?: { urlOnly?: boolean; programGate?: boolean }`, the `DedupResult.matchType` union to `'url_exact' | 'name_exact' | 'name_fuzzy' | 'program' | null`, and add to `DedupResult`:

```ts
  /** Program-identity resolution (Layer 1.75) — present when the gate ran and matched, even on non-duplicate outcomes. */
  programResolution?: ProgramResolutionStamp | null;
```

Insert after the Layer 1.5 name-exact block (dedup.ts ~line 96, before the disabled fuzzy layer), following its early-return style:

```ts
  // Layer 1.75: program identity (opt-in; act-and-report gate).
  // Same program + same round + high confidence = duplicate with history.
  // New round resolves but never blocks — callers stamp metadata.program.
  let programResolution: DedupResult['programResolution'] = null;
  if (options?.programGate && !options?.urlOnly) {
    try {
      const match = await resolveProgram(pool, { name: entry.name, sourceUrl: entry.sourceUrl, wire: entry.wire });
      if (match) {
        const round = assessRound(match.program, { name: entry.name });
        programResolution = {
          programId: match.program.id,
          confidence: match.confidence,
          verdict: round.verdict,
          roundLabel: round.roundLabel,
          historyLine: historyLine(match.program),
        };
        if (round.verdict === 'same_round' && match.confidence >= 0.85
            && match.program.entry_count > 0 && match.program.canonical_entry_id) {
          return {
            isDuplicate: true,
            matchType: 'program',
            matchedEntryId: match.program.canonical_entry_id,
            matchedEntryName: match.program.canonical_name,
            confidence: match.confidence,
            reason: `Program "${match.program.canonical_name}" — ${historyLine(match.program)}`,
            programResolution,
          };
        }
      }
    } catch (err) {
      console.error('[Dedup] Program gate failed (fail-open):', err instanceof Error ? err.message : err);
    }
  }
```

and thread `programResolution` into the function's final non-duplicate return object (`return { isDuplicate: false, ..., programResolution }`).

- [ ] **Step 4: Verify** (new file + `npm test` + bare typecheck). **Step 5: Commit** — `git commit -m "feat(dedup): program-identity gate as opt-in Layer 1.75"`.

---

### Task 5: Wire the callers — process-raw and daily-intake

**Files:**
- Modify: `src/jobs/process-raw.ts`, `src/jobs/daily-intake.ts`
- Test: extend `tests/dedup-program-gate.test.js` only if a pure helper emerges; primary verification is the full suite + typecheck (both jobs are DB-integration paths; their dedup behavior is covered by the Task 4 unit layer).

**Interfaces:**
- Consumes: `checkDuplicate(..., { programGate: true })`, `finalizeProgramForEntry` (Task 3), `DedupResult.matchType === 'program'`, `dedupResult.programResolution`.
- Produces: entries demoted by the gate carry `actioned_by = 'program-gate'` (the digest's gate lane counts on this exact string — Task 6).

- [ ] **Step 1: process-raw** (`src/jobs/process-raw.ts`):
  1. The Phase-2 `checkDuplicate` call (~line 156) gains a 4th arg `{ programGate: true }`.
  2. The duplicate-demotion UPDATE (~line 170) sets actor when the gate fired — replace with:

```ts
          if (dedupResult.isDuplicate) {
            await db.query(
              `UPDATE scan_entries
               SET status = 'duplicate',
                   duplicate_of_id = $1,
                   duplicate_reason = $2,
                   actioned_by = COALESCE($4, actioned_by)
               WHERE id = $3 AND status = 'raw'`,
              [dedupResult.matchedEntryId, dedupResult.reason, row.id,
               dedupResult.matchType === 'program' ? 'program-gate' : null]
            );
            stats.duplicates++;
          } else {
```

  3. After the Gate-2 classify try/catch block completes (right after the `catch (classError)` block's closing brace, still inside the non-duplicate else-branch), add:

```ts
            // Program identity: record the sighting / create the program and
            // stamp metadata.program. Fail-open inside; never blocks the cycle.
            await finalizeProgramForEntry(db, {
              id: row.id, name: row.name, sourceUrl: row.source_url, wire: row.wire,
              description: row.description ?? null,
            }, dedupResult.programResolution ?? null);
```

  (`DedupResult.programResolution` and `ProgramResolutionStamp` are the same shape by design — pass it straight through.)

  4. Add the import: `import { finalizeProgramForEntry } from '../services/program-identity';`

- [ ] **Step 2: daily-intake** (`src/jobs/daily-intake.ts`): the Phase-2 `checkDuplicate` call (~line 354) gains `{ programGate: true }` as its 4th argument (after `config.dedupeWindow`); the duplicate UPDATE below it gains the same `actioned_by = COALESCE($4, actioned_by)` treatment (params `[dedupResult.matchedEntryId, dedupResult.reason, entryId, dedupResult.matchType === 'program' ? 'program-gate' : null]`); and after the alternate-source/deduped else-branch (right after `uniqueEntryIds.push(entryId);`), add:

```ts
      await finalizeProgramForEntry(pool, {
        id: entryId, name: item.result.name, sourceUrl: item.result.sourceUrl,
        wire: item.wire, deadline: item.result.deadline ?? null,
        description: item.result.description ?? null,
      }, dedupResult.programResolution ?? null);
```

  plus the import.

- [ ] **Step 3: Verify** — `npm test` (207+ pass), `npm run typecheck` bare exit 0. `grep -n "programGate" src/jobs/*.ts src/services/intake-core.ts` — intake-core must have ZERO hits.
- [ ] **Step 4: Commit** — `git commit -m "feat(intake): program gate live in process-raw + daily-intake (act and report)"`.

---

### Task 6: Digest surfacing — gate lane + history line

**Files:**
- Modify: `src/jobs/daily-digest.ts`, `src/services/email.ts`
- Test: `tests/daily-digest.test.js`, `tests/digest-email.test.js` (append)

**Interfaces:**
- Consumes: `scan_entries.program_id`, `programs` columns, `actioned_by='program-gate'`.
- Produces: `TopFindEntry` gains `program_verdict: string | null` and `program_history: string | null`; `buildRunLedger` lanes gain `gate` (omitted when zero).

- [ ] **Step 1: Failing tests**

Append to `tests/daily-digest.test.js`:

```js
test('buildRunLedger: gate lane appears with 24h auto-dupe count, omitted at zero', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '5', failed: '0' }]);   // scans probe
  pool.queueResponse([{ n: '12' }]);                 // gate probe
  const { deps } = fakeState({ 'summary-sync:watermark': new Date().toISOString() });
  const { ledger } = await buildRunLedger(pool, { date: '2026-07-10' }, deps);
  const gate = ledger.lanes.find(l => l.key === 'gate');
  assert.equal(gate.detail, 'gate 12 duped');
  assert.equal(gate.state, 'ok');

  const pool2 = fakePool();
  pool2.queueResponse([{ ok: '5', failed: '0' }]);
  pool2.queueResponse([{ n: '0' }]);
  const r2 = await buildRunLedger(pool2, { date: '2026-07-10' }, deps);
  assert.ok(!r2.ledger.lanes.some(l => l.key === 'gate'), 'zero → omitted');
});

test('getFreshFinds selects program history via the programs join', async () => {
  const pool = fakePool();
  pool.queueResponse([]);
  pool.queueResponse([{ total_new: '0' }]);
  const { deps } = fakeState({ [DIGEST_WATERMARK_KEY]: {} });
  await getFreshFinds(pool, 8, deps);
  assert.match(pool.calls[0].sql, /LEFT JOIN programs/);
  assert.match(pool.calls[0].sql, /program_history/);
  assert.match(pool.calls[0].sql, /program_verdict/);
});
```

Append to `tests/digest-email.test.js`:

```js
test('cards render program history; new_round gets the round note', () => {
  const finds = [{
    id: 301, name: 'Anthropic Fellows Program (Dec 2026 cohort)', wire: 'ai', quality_score: 90,
    amount: null, deadline: null, source_url: null, curator_route: null, curator_confidence: null,
    summary: 'Funded AI-safety research fellowship.',
    recheck_verdict: null, recheck_matched_name: null, recheck_matched_status: null,
    program_verdict: 'new_round', program_history: 'seen 61× · approved 1× · declined 12× · last declined 2026-07-07',
  }];
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: finds, totalNewEligible: 1, runLedger: LEDGER });
  assert.match(r.html, /New round of a known program/);
  assert.match(r.html, /seen 61×/);
  assert.match(r.text, /seen 61×/);
});
```

- [ ] **Step 2: verify failure. Step 3: Implement.**

`src/jobs/daily-digest.ts` — in `buildRunLedger`, after the scans probe try/catch, add:

```ts
  // gate — program-identity auto-dupes in the last 24h (the "report" half of act-and-report)
  try {
    const { rows } = await pool.query<{ n: string }>(`
      SELECT COUNT(*) AS n FROM scan_entries
      WHERE actioned_by = 'program-gate' AND updated_at >= NOW() - INTERVAL '24 hours'`);
    const n = parseInt(rows[0]?.n ?? '0', 10);
    if (n > 0) lanes.push({ key: 'gate', state: 'ok', detail: `gate ${n} duped` });
  } catch {
    // omit — optional evidence
  }
```

(NOTE for the implementer: this probe runs BETWEEN the scans probe and the feeds lane push, so the Task-2-era test asserting exact lane order `['scans 41✓','feeds 19/19',…]` stays green only because that test's fakePool returns `rows: []` for the gate query → `n=0` → omitted. The gate test above queues its response AFTER the scans response — queue order in fakePool is scans first, gate second.)

`getFreshFinds`'s `FRESH_FINDS_SELECT`: extend the SELECT list and join:

```sql
         q.metadata->'program'->>'verdict' AS program_verdict,
         CASE WHEN p.id IS NULL THEN NULL ELSE
           'seen ' || p.entry_count || '×'
           || CASE WHEN p.approved_count > 0 THEN ' · approved ' || p.approved_count || '×' ELSE '' END
           || CASE WHEN p.declined_count > 0 THEN ' · declined ' || p.declined_count || '×' ELSE '' END
           || CASE WHEN p.last_decision IS NOT NULL THEN ' · last ' || p.last_decision ELSE '' END
         END AS program_history
```

with `LEFT JOIN programs p ON p.id = q.program_id` added after the existing `LEFT JOIN scan_entries m` join.

`src/services/email.ts` — `TopFindEntry` gains:

```ts
  program_verdict: string | null;
  program_history: string | null;
```

and in the card renderer, after `updateHtml`, add:

```ts
      const programHtml = e.program_history
        ? `<p style="margin:5px 0 0;font-size:10.5px;color:#8a6d1f;${MONO}">${e.program_verdict === 'new_round' ? '&#8635; New round of a known program &middot; ' : ''}${escapeHtml(e.program_history)}</p>`
        : '';
```

rendered after `${updateHtml}` in the card div, and mirrored in the text part (`programLine` appended alongside `updateLine`):

```ts
      const programLine = e.program_history
        ? `\n    ${e.program_verdict === 'new_round' ? '↻ New round of a known program · ' : ''}${e.program_history}` : '';
```

(Existing test fixtures in digest-email.test.js don't have the new fields — they're `null`-safe via the `e.program_history ?` guard; add `program_verdict: null, program_history: null` only where TS complains, which it won't in JS tests.)

- [ ] **Step 4: Verify** (both focused files + `npm test` + bare typecheck). **Step 5: Commit** — `git commit -m "feat(digest): gate ledger lane + program history on cards"`.

---

### Task 7: Backfill script with chain repair

**Files:**
- Create: `src/scripts/program-backfill.ts`
- Test: `tests/program-backfill.test.js` (create — pure helpers only)

**Interfaces:**
- Consumes: `normalizeProgramKey`, `canonicalizeBatch`, `createProgram`, `historyLine` (Tasks 1-3).
- Produces: exported pure helpers `clusterByKey(rows: Array<{ id: number; name: string; status: string }>): Map<string, Array<{ id: number; name: string; status: string }>>` and `resolveChainSafe(pointers: Map<number, number | null>, startId: number): number` (cycle-safe canonical resolution: walks `duplicate_of_id`, max 20 hops, on cycle returns the SMALLEST id in the cycle — deterministic). CLI: `railway run npx ts-node src/scripts/program-backfill.ts --dry-run` prints the plan; without the flag it writes.

- [ ] **Step 1: Failing tests** — `tests/program-backfill.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { clusterByKey, resolveChainSafe } = require('../src/scripts/program-backfill');

test('clusterByKey groups by normalized program key and skips empty keys', () => {
  const rows = [
    { id: 1, name: 'Anthropic Fellows Program', status: 'approved' },
    { id: 2, name: 'Anthropic Fellows Program 2026', status: 'duplicate' },
    { id: 3, name: 'NLnet Open Call', status: 'queued' },
    { id: 4, name: '2026', status: 'archived' }, // degenerate → skipped
  ];
  const clusters = clusterByKey(rows);
  const sizes = [...clusters.values()].map(v => v.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('resolveChainSafe: flat chains, deep chains, cycles (real corpus fixture 8804<->8771), orphans', () => {
  const ptr = new Map([
    [10, null],          // canonical
    [11, 10], [12, 11],  // depth 2
    [8804, 8771], [8771, 8804], // the real mutual cycle
    [99, 100],           // dangling pointer to unknown id
  ]);
  assert.equal(resolveChainSafe(ptr, 12), 10);
  assert.equal(resolveChainSafe(ptr, 10), 10);
  assert.equal(resolveChainSafe(ptr, 8804), 8771, 'cycle resolves to smallest member');
  assert.equal(resolveChainSafe(ptr, 8771), 8771);
  assert.equal(resolveChainSafe(ptr, 99), 100, 'dangling pointer resolves to its target');
});
```

- [ ] **Step 2: verify failure. Step 3: Implement** `src/scripts/program-backfill.ts`:

```ts
/**
 * Program-identity backfill — MANUAL, resumable, idempotent.
 *
 *   railway run npx ts-node src/scripts/program-backfill.ts --dry-run
 *   railway run npx ts-node src/scripts/program-backfill.ts
 *
 * 1. Cluster all scan_entries by normalizeProgramKey(name).
 * 2. LLM-canonicalize one representative per multi-member-or-decided cluster.
 * 3. Upsert programs, set scan_entries.program_id, compute counters,
 *    pick canonical_entry_id (approved > declined > queued, newest).
 * 4. Chain hygiene: repair duplicate_of_id cycles (point every member at the
 *    smallest id) and give pointer-less duplicates a pointer to their
 *    program's canonical entry when resolvable.
 * Idempotent: entries with program_id set are skipped on re-run.
 */
import { getPool } from '../db';
import { normalizeProgramKey, canonicalizeBatch, createProgram } from '../services/program-identity';

export function clusterByKey(rows: Array<{ id: number; name: string; status: string }>): Map<string, Array<{ id: number; name: string; status: string }>> {
  const clusters = new Map<string, Array<{ id: number; name: string; status: string }>>();
  for (const r of rows) {
    const key = normalizeProgramKey(r.name);
    if (!key) continue;
    const bucket = clusters.get(key) ?? [];
    bucket.push(r);
    clusters.set(key, bucket);
  }
  return clusters;
}

export function resolveChainSafe(pointers: Map<number, number | null>, startId: number): number {
  const path: number[] = [];
  let cur = startId;
  for (let hop = 0; hop < 20; hop++) {
    path.push(cur);
    const next = pointers.get(cur);
    if (next == null) return cur;                    // canonical or unknown target
    if (path.includes(next)) {                       // cycle — deterministic pick
      const cycle = path.slice(path.indexOf(next)).concat(next);
      return Math.min(...cycle);
    }
    if (!pointers.has(next)) return next;            // dangling pointer: trust it
    cur = next;
  }
  return cur;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = getPool();

  const { rows } = await pool.query<{ id: number; name: string; status: string; wire: string; source_url: string; deadline: string | null; program_id: number | null; duplicate_of_id: number | null; updated_at: Date }>(
    `SELECT id, name, status, wire, source_url, deadline, program_id, duplicate_of_id, updated_at FROM scan_entries WHERE name IS NOT NULL`);
  console.log(`entries: ${rows.length}, already linked: ${rows.filter(r => r.program_id).length}`);

  const unlinked = rows.filter(r => !r.program_id);
  const clusters = clusterByKey(unlinked);
  const DECIDED = new Set(['approved', 'declined', 'duplicate']);
  const eligible = [...clusters.entries()].filter(([, members]) =>
    members.length >= 2 || members.some(m => DECIDED.has(m.status)));
  console.log(`clusters: ${clusters.size} total, ${eligible.length} eligible (≥2 members or decided)`);
  if (dryRun) {
    const top = eligible.sort((a, b) => b[1].length - a[1].length).slice(0, 20);
    for (const [key, members] of top) console.log(`  ${String(members.length).padStart(4)}  ${key}  e.g. "${members[0].name.slice(0, 60)}"`);
  }

  // Canonicalize representatives in chunks of 20
  const reps = eligible.map(([key, members]) => ({ key, rep: members[0], members }));
  const canonicalById = new Map<number, { org: string | null; program: string | null; round_label: string | null }>();
  if (!dryRun) {
    for (let i = 0; i < reps.length; i += 20) {
      const chunk = reps.slice(i, i + 20);
      const out = await canonicalizeBatch(chunk.map(c => ({ id: c.rep.id, name: c.rep.name, description: '' })));
      for (const o of out) canonicalById.set(o.id, o);
      console.log(`canonicalized ${Math.min(i + 20, reps.length)}/${reps.length}`);
    }
  }

  let linked = 0;
  if (!dryRun) {
    for (const { rep, members } of reps) {
      const canon = canonicalById.get(rep.id);
      const programId = await createProgram(pool, {
        name: rep.name, canonicalName: canon?.program ?? null, orgName: canon?.org ?? null,
        wire: (rep as any).wire ?? null, sourceUrl: (rep as any).source_url ?? null, roundLabel: canon?.round_label ?? null,
      });
      const ids = members.map(m => m.id);
      await pool.query(`UPDATE scan_entries SET program_id = $1 WHERE id = ANY($2::int[]) AND program_id IS NULL`, [programId, ids]);
      // counters + canonical exemplar from members
      await pool.query(
        `UPDATE programs p SET
           entry_count = s.total, approved_count = s.approved, declined_count = s.declined,
           first_seen = s.first_seen, last_seen = s.last_seen,
           canonical_entry_id = s.exemplar,
           last_decision = s.last_decision,
           aliases = (SELECT ARRAY(SELECT DISTINCT unnest(p.aliases || s.names)))
         FROM (
           SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
                  COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
                  MIN(created_at)::date AS first_seen, MAX(created_at)::date AS last_seen,
                  (ARRAY_AGG(id ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'declined' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, created_at DESC))[1] AS exemplar,
                  (ARRAY_AGG(status || ' ' || updated_at::date ORDER BY updated_at DESC) FILTER (WHERE status IN ('approved','declined')))[1] AS last_decision,
                  ARRAY_AGG(DISTINCT name) AS names
           FROM scan_entries WHERE program_id = $1
         ) s
         WHERE p.id = $1`, [programId]);
      linked += ids.length;
    }
    console.log(`programs written; entries linked: ${linked}`);
  }

  // Chain hygiene (runs in both modes; writes only when live)
  const pointers = new Map<number, number | null>(rows.map(r => [r.id, r.duplicate_of_id]));
  const dupes = rows.filter(r => r.status === 'duplicate');
  let cycleFixes = 0, orphanFixes = 0;
  for (const d of dupes) {
    if (d.duplicate_of_id != null) {
      const canonical = resolveChainSafe(pointers, d.id);
      if (canonical !== d.duplicate_of_id && canonical !== d.id) {
        cycleFixes++;
        if (!dryRun) await pool.query(`UPDATE scan_entries SET duplicate_of_id = $1 WHERE id = $2`, [canonical, d.id]);
      }
    } else {
      orphanFixes++; // pointer-less duplicate: leave unless its program has an exemplar
      if (!dryRun) {
        await pool.query(
          `UPDATE scan_entries se SET duplicate_of_id = p.canonical_entry_id
           FROM programs p WHERE se.id = $1 AND se.program_id = p.id
             AND p.canonical_entry_id IS NOT NULL AND p.canonical_entry_id <> se.id`, [d.id]);
      }
    }
  }
  console.log(`chain hygiene: ${cycleFixes} pointers flattened/de-cycled, ${orphanFixes} orphan dupes examined`);
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error('BACKFILL FAILED:', e); process.exit(1); });
}
```

- [ ] **Step 4: Verify** — `node --test tests/program-backfill.test.js` PASS; `npm test`; bare typecheck exit 0. Do NOT run the script against prod in this task.
- [ ] **Step 5: Commit** — `git commit -m "feat(programs): corpus backfill script with cycle-safe chain repair"`.

---

### Task 8: Link introspection — tweet unwrap, ATS org hints, capped aggregator scrape

**Files:**
- Modify: `src/services/program-identity.ts`, `src/jobs/process-raw.ts`, `src/jobs/daily-intake.ts`
- Test: `tests/program-identity.test.js` (append)

**Interfaces:**
- Consumes: `extractAndResolveUrls` is NOT needed — descriptions carry plain URLs; `scrapeUrl` from `../services/scraper` (Firecrawl); `getAppState`/`setAppState` from `../db`.
- Produces: `introspectEntryUrl(entry: { sourceUrl?: string | null; description?: string | null }): { canonicalUrl: string | null; orgHint: string | null }` — PURE, deterministic: (a) if sourceUrl is an x.com/twitter.com status and the description contains a non-x http(s) URL, canonicalUrl = that URL; (b) if sourceUrl matches `job-boards.greenhouse.io/<slug>/`, `jobs.ashbyhq.com/<slug>`, or `jobs.lever.co/<slug>` → orgHint = slug (dashes → spaces), canonicalUrl = null (an ATS domain is org identity, not program identity). Otherwise `{ canonicalUrl: sourceUrl ?? null, orgHint: null }`.
  Plus `maybeScrapeAggregator(entry: { sourceUrl?: string | null }, deps?): Promise<string | null>` — returns an outbound canonical URL scraped from a known aggregator page, capped at 10/day via app_state key `program-gate:scrape-count:<YYYY-MM-DD>`; aggregator domains = `['opportunitiesforyouth.org', 'opportunities247.org']` + comma-separated `process.env.PROGRAM_AGGREGATOR_DOMAINS`; over cap or non-aggregator or scrape failure → null. Injectable deps `{ getAppState, setAppState, scrape }` for tests.

- [ ] **Step 1: Failing tests (append to tests/program-identity.test.js)**

```js
const { introspectEntryUrl, maybeScrapeAggregator } = require('../src/services/program-identity');

test('introspectEntryUrl unwraps tweets and maps ATS hosts to org hints', () => {
  const tweet = introspectEntryUrl({
    sourceUrl: 'https://x.com/someuser/status/12345',
    description: 'Apply now: https://alignment.anthropic.com/2025/fellows/ — great program',
  });
  assert.equal(tweet.canonicalUrl, 'https://alignment.anthropic.com/2025/fellows/');
  const ats = introspectEntryUrl({ sourceUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/5023394008' });
  assert.equal(ats.orgHint, 'anthropic');
  assert.equal(ats.canonicalUrl, null);
  const plain = introspectEntryUrl({ sourceUrl: 'https://nlnet.nl/news/2026/call.html' });
  assert.equal(plain.canonicalUrl, 'https://nlnet.nl/news/2026/call.html');
  assert.equal(plain.orgHint, null);
});

test('maybeScrapeAggregator: cap enforced, non-aggregators skipped, failures null', async () => {
  const store = new Map();
  const deps = {
    async getAppState(k) { return store.has(k) ? store.get(k) : null; },
    async setAppState(k, v) { store.set(k, v); },
    async scrape() { return { success: true, content: 'Apply at https://real-funder.org/grants today' }; },
  };
  assert.equal(await maybeScrapeAggregator({ sourceUrl: 'https://nlnet.nl/x' }, deps), null, 'non-aggregator skipped');
  const hit = await maybeScrapeAggregator({ sourceUrl: 'https://opportunitiesforyouth.org/2026/05/some-post' }, deps);
  assert.equal(hit, 'https://real-funder.org/grants');
  const key = [...store.keys()].find(k => k.startsWith('program-gate:scrape-count:'));
  assert.equal(store.get(key), 1);
  store.set(key, 10);
  assert.equal(await maybeScrapeAggregator({ sourceUrl: 'https://opportunitiesforyouth.org/2026/05/other' }, deps), null, 'cap enforced');
});
```

- [ ] **Step 2: verify failure. Step 3: Implement (append to program-identity.ts):**

```ts
import { getAppState, setAppState } from '../db';
import { scrapeUrl } from './scraper';

const ATS_PATTERNS: Array<{ re: RegExp }> = [
  { re: /^https?:\/\/job-boards\.greenhouse\.io\/([^/]+)/i },
  { re: /^https?:\/\/jobs\.ashbyhq\.com\/([^/]+)/i },
  { re: /^https?:\/\/jobs\.lever\.co\/([^/]+)/i },
];

export function introspectEntryUrl(entry: { sourceUrl?: string | null; description?: string | null }): { canonicalUrl: string | null; orgHint: string | null } {
  const src = entry.sourceUrl || null;
  if (src && /^https?:\/\/(?:www\.)?(x|twitter)\.com\//i.test(src)) {
    const m = (entry.description || '').match(/https?:\/\/(?!(?:www\.)?(?:x|twitter)\.com)[^\s)\]"']+/i);
    if (m) return { canonicalUrl: m[0].replace(/[.,;:]+$/, ''), orgHint: null };
    return { canonicalUrl: src, orgHint: null };
  }
  for (const { re } of ATS_PATTERNS) {
    const m = src ? src.match(re) : null;
    if (m) return { canonicalUrl: null, orgHint: m[1].replace(/-/g, ' ').toLowerCase() };
  }
  return { canonicalUrl: src, orgHint: null };
}

const DEFAULT_AGGREGATORS = ['opportunitiesforyouth.org', 'opportunities247.org'];
const SCRAPE_CAP_PER_DAY = 10;

export async function maybeScrapeAggregator(
  entry: { sourceUrl?: string | null },
  deps: { getAppState: typeof getAppState; setAppState: typeof setAppState; scrape: typeof scrapeUrl } = { getAppState, setAppState, scrape: scrapeUrl },
): Promise<string | null> {
  try {
    const dom = domainOf(entry.sourceUrl);
    if (!dom) return null;
    const aggregators = new Set([...DEFAULT_AGGREGATORS, ...(process.env.PROGRAM_AGGREGATOR_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
    if (!aggregators.has(dom)) return null;
    const key = `program-gate:scrape-count:${new Date().toISOString().slice(0, 10)}`;
    const count = (await deps.getAppState<number>(key)) ?? 0;
    if (count >= SCRAPE_CAP_PER_DAY) return null;
    await deps.setAppState(key, count + 1);
    const result = await deps.scrape(entry.sourceUrl as string);
    if (!result.success || !result.content) return null;
    const m = result.content.match(/https?:\/\/(?![^\s]*(?:opportunitiesforyouth|opportunities247)\.org)[^\s)\]"']+/i);
    return m ? m[0].replace(/[.,;:]+$/, '') : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wire into the finalize path** — in `finalizeProgramForEntry`'s new-program branch (resolution null), before `canonicalizeBatch`, add:

```ts
    const intro = introspectEntryUrl({ sourceUrl: entry.sourceUrl, description: entry.description ?? null });
    const scraped = intro.canonicalUrl === entry.sourceUrl ? await maybeScrapeAggregator(entry) : null;
    const bestUrl = scraped ?? intro.canonicalUrl ?? entry.sourceUrl ?? null;
```

and use `bestUrl` instead of `entry.sourceUrl` in the `createProgram` call, and `intro.orgHint ?? canon?.org ?? extractOrgFromName(entry.name)` as the org fallback chain. Then in `resolveProgram`'s callers nothing changes — the gate already passes sourceUrl; ATS/tweet refinement affects creation quality first (resolution-side introspection is a follow-up, noted in the commit body).

- [ ] **Step 5: Verify** (focused + full + bare typecheck). **Step 6: Commit** — `git commit -m "feat(programs): link introspection — tweet unwrap, ATS org hints, capped aggregator scrape"`.

---

### Task 9: Docs, full gates, ship prep

**Files:**
- Modify: `CLAUDE.md`
- Modify only on failure: anything the gates flag.

- [ ] **Step 1: CLAUDE.md** — surgical, truthful edits: (a) Table Groups table gains a row: `| **Programs** | \`programs\` | Program-identity registry: canonical program per funder (aliases, url_domains, round + decision history); \`scan_entries.program_id\` links members; fed by the intake gate (dedup Layer 1.75, act-and-report, \`actioned_by='program-gate'\`) and \`src/scripts/program-backfill.ts\` |`; (b) the Dedup Tables section notes the new layer in one sentence; (c) the file-tree gets `program-identity.ts` under services and `program-backfill.ts` under scripts, one line each matching the existing comment style.
- [ ] **Step 2: Full gates** — `npm test` (all pass), `npm run typecheck` bare exit 0, `npm run typecheck:client` exit 0 (no client changes expected — confirm).
- [ ] **Step 3: Commit** — `git commit -m "docs: program-identity layer in CLAUDE.md"`.

After Task 8, the controller (not a task) runs: final whole-branch review → PR → merge → deploy → `--dry-run` backfill review → live backfill → verify gate lane + history lines in the next digest.
