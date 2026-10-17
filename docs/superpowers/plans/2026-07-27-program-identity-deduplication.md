# Program Identity Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the program matcher from minting duplicate program rows, then merge the ~758 duplicate rows it already created, so `programs` becomes a trustworthy one-row-per-program funder map.

**Architecture:** Two independently shippable halves. **Part A** fixes the two matcher defects that create duplicate identities (program-type suffixes producing different keys; org-name wording tricking the collision guard into forking a key). **Part B** adds a `program-merge` service plus a dry-run/plan-hash CLI — modelled on the existing `org-merge.ts` and on the `program-integrity-repair.ts` review gate already in the tree — that folds each duplicate row into the row that owns its entries' duplicate chain. Part A ships first and alone; Part B is safe to run only after Part A stops new ghosts appearing.

**Tech Stack:** TypeScript (strict), Node `node:test` + `assert/strict`, Postgres via `pg`, Express admin routes, ts-node CLI scripts.

## Global Constraints

- TypeScript strict mode; `npx tsc --noEmit` must exit 0 before any commit.
- Tests are `node --test tests/**/*.test.js` and require `require('ts-node/register/transpile-only')` at the top of each test file.
- DB-backed tests must skip cleanly when `DATABASE_URL` is unset (`console.log('Skipping …'); process.exit(0)`) — CI supplies a Postgres 16 service, local runs usually do not.
- Never call `ensure*` DDL ad hoc from a startup path. Schema changes get exactly one entry in `STARTUP_MIGRATIONS` (`src/db/startup-migrations.ts`).
- Destructive DB operations require a reviewed plan hash before `--apply` (established by `src/scripts/program-integrity-repair.ts`). No new cron jobs — owner rule is "fold, don't multiply"; these are manual scripts.
- Existing behaviour that must not regress: the Layer 1.75 program gate in `src/services/dedup.ts:129-130` fires only when `entry_count > 0 AND canonical_entry_id` is non-null. Merging must leave the surviving row satisfying both.
- `programs.normalized_key` carries a UNIQUE constraint; `createProgram` upserts via `ON CONFLICT (normalized_key)`.

## Preconditions

This plan assumes the uncommitted `codex/program-integrity-repair` work is committed first (it is typecheck-clean and 419 tests pass). Part B reuses `refreshProgramCounters` and `TransactionPool` from it.

**Do not run `program-integrity-repair --apply` before Part B.** Its current plan nulls `canonical_entry_id` on 1,008 rows, which switches the Layer 1.75 gate off for a quarter of the registry. After Part B those rows no longer exist and the repair plan shrinks to the ~254 legitimate rows.

## Measured baseline (production, 2026-07-27)

| Fact | Value |
|---|---|
| Programs total | 4,267 |
| Duplicate ("ghost") rows | 1,008 |
| …with exactly 1 entry | 788 |
| …whose entries' chain head sits in a **different** program (mergeable) | 758 |
| …whose chain head has no program at all | 259 |
| Ghost entries that are `status='duplicate'` | 1,461 of 1,462 |

**Task 4's `CANDIDATE_SQL` was executed against production on 2026-07-27 (read-only). Verified output:**

| | |
|---|---|
| Merge candidates (ghosts resolving to exactly **one** target program) | **727** |
| …tier `auto` (name overlap ≥60% **or** org identity agrees) | **528** (73%) |
| …of those, qualifying on org identity alone | 83 |
| …tier `review` | **199** |
| Registry after applying the auto tier | 4,267 → **3,739** |

The candidate count is 727 rather than the 1,008 ghosts because the CTE deliberately requires a single unambiguous target; ghosts whose entries' chain heads span several programs are excluded rather than guessed at.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/program-identity.ts` (modify) | `normalizeProgramKey` gains suffix-family stripping; `createProgram`'s collision guard gains org-identity comparison. New exported pure helper `sameOrgIdentity`. |
| `tests/program-identity.test.js` (modify) | Unit coverage for both matcher fixes. |
| `src/services/program-merge.ts` (create) | `mergePrograms(pool, sourceId, targetId)` — transactional fold of one program row into another. |
| `tests/program-merge.test.js` (create) | Stub-pool unit coverage of the merge contract. |
| `src/services/program-merge-plan.ts` (create) | Builds the ghost→target merge plan with confidence tiers; plan hash; apply path. |
| `tests/program-merge-plan.test.js` (create) | Stub-pool coverage of plan building, tiering, and the drift guard. |
| `src/scripts/program-merge.ts` (create) | CLI: dry-run by default, `--apply --expect-plan-hash <sha256>`, `--tier auto\|review`. |
| `tests/program-merge-db.test.js` (create) | Real-Postgres end-to-end: build schema, seed a ghost, merge, assert invariants. |

---

## Part A — Stop minting ghosts

### Task 1: Suffix-family normalization in `normalizeProgramKey`

The normalizer strips round/cohort/date noise but keeps program-type suffixes, so one program stored two ways gets two keys:

```
"Framework Computer Open Source Sponsorship Program" -> frameworkcomputeropensourcesponsorshipprogram
"Framework Computer Open Source Sponsorships"        -> frameworkcomputeropensourcesponsorships
"Rain Protocol Grant Program"                        -> rainprotocolgrantprogram
"Rain Protocol Grants"                               -> rainprotocolgrants
```

**Files:**
- Modify: `src/services/program-identity.ts:25-44` (the `NOISE_PATTERNS` block and `normalizeProgramKey`)
- Test: `tests/program-identity.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `normalizeProgramKey(name: string): string` — same signature, stricter output. Task 2 and all of Part B depend on it.

- [ ] **Step 1: Write the failing test**

Append to `tests/program-identity.test.js`:

```javascript
test('normalizeProgramKey collapses the program-type suffix family', () => {
  // Same program, two spellings -> one key
  assert.equal(
    normalizeProgramKey('Framework Computer Open Source Sponsorship Program'),
    normalizeProgramKey('Framework Computer Open Source Sponsorships'),
  );
  assert.equal(
    normalizeProgramKey('Rain Protocol Grant Program'),
    normalizeProgramKey('Rain Protocol Grants'),
  );
  assert.equal(
    normalizeProgramKey('AI for Individual Rights Grants'),
    normalizeProgramKey('AI for Individual Rights Fund'),
  );
});

test('normalizeProgramKey keeps distinct programs distinct', () => {
  // A qualifier before the suffix is signal, not noise
  assert.notEqual(
    normalizeProgramKey('NGI Zero Commons Fund'),
    normalizeProgramKey('NGI Zero Core Fund'),
  );
  // Suffix stripping must not empty a name that is only a suffix
  assert.equal(normalizeProgramKey('Grants'), 'grants');
  assert.equal(normalizeProgramKey('The Fund'), 'thefund');
});

test('normalizeProgramKey still strips round/cohort/date noise', () => {
  assert.equal(
    normalizeProgramKey('Anthropic Fellows Program (Dec 2026 cohort)'),
    normalizeProgramKey('Anthropic Fellows Program'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/program-identity.test.js`
Expected: FAIL — the first two assertions in "collapses the program-type suffix family" report unequal strings (`...sponsorshipprogram` vs `...sponsorships`).

- [ ] **Step 3: Write minimal implementation**

In `src/services/program-identity.ts`, directly below the `NOISE_PATTERNS` array, add:

```typescript
// Program-type suffixes. The SAME program is written "X Grants", "X Grant
// Program", "X Fund", "X Sponsorships" by different sources; keeping the
// suffix in the key mints a second identity for each spelling (measured:
// 61% of duplicate program rows are exactly this). Stripped only from the
// END of the name, so a mid-name qualifier ("Commons Fund" vs "Core Fund")
// still separates two genuinely different programs.
const PROGRAM_SUFFIX_RE =
  /\s*\b(?:grants?|grant\s+programs?|programs?|programmes?|funds?|funding|sponsorships?|fellowships?|scholarships?|initiatives?|schemes?|rfps?|awards?)\b\s*$/i;

function stripProgramSuffixes(name: string): string {
  let s = name;
  // Loop: "Grant Program" and "Grants Fund" stack two suffixes deep.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(PROGRAM_SUFFIX_RE, '').trim();
    // Never strip a name down to nothing — "Grants" must stay "Grants".
    if (!next || next === s) break;
    s = next;
  }
  return s;
}
```

Then change `normalizeProgramKey` to apply it after noise removal and before squashing:

```typescript
export function normalizeProgramKey(name: string): string {
  let s = (name || '').toLowerCase();
  s = s.replace(/\bfund\s*\d+\b/gi, 'fund');
  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');
  s = stripProgramSuffixes(s.replace(/\s+/g, ' ').trim());
  return s.replace(/[^a-z0-9]/g, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/program-identity.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && node --test tests/**/*.test.js`
Expected: `tsc` exits 0; every test passes. `resolveProgram`'s `substring` pass (`src/services/program-identity.ts:205`) already tolerates a shorter candidate key matching a longer stored key, so existing rows with un-stripped keys keep resolving.

- [ ] **Step 6: Commit**

```bash
git add src/services/program-identity.ts tests/program-identity.test.js
git commit -m "fix(program-identity): collapse program-type suffixes into one key"
```

---

### Task 2: Org-identity comparison in the collision guard

`createProgram`'s collision guard forks the key when the existing key-holder has a different org **string**. It compares raw normalized text, so `"AWS"` and `"Amazon Web Services"` read as different funders and the same program gets two rows:

```
#7    "AWS AI & ML Scholars Program"  key: awsaimlscholarsprogram        org: "Amazon Web Services"
#783  "AWS AI & ML Scholars Program"  key: awsaimlscholarsprogram--aws   org: "AWS"
```

The guard is right to exist (it prevents unrelated "Round Table Grants" programs merging). It needs a smarter comparison, not removal.

**Files:**
- Modify: `src/services/program-identity.ts:275-295` (the collision guard inside `createProgram`)
- Test: `tests/program-identity.test.js`

**Interfaces:**
- Consumes: `normalizeProgramKey` from Task 1.
- Produces: `sameOrgIdentity(a: string | null | undefined, b: string | null | undefined): boolean` — exported pure helper. Part B's plan builder uses it to score merge confidence.

- [ ] **Step 1: Write the failing test**

Append to `tests/program-identity.test.js` (add `sameOrgIdentity` to the existing `require` destructuring at the top of the file):

```javascript
test('sameOrgIdentity treats an acronym and its expansion as one org', () => {
  assert.equal(sameOrgIdentity('AWS', 'Amazon Web Services'), true);
  assert.equal(sameOrgIdentity('Amazon Web Services', 'AWS'), true);
  assert.equal(sameOrgIdentity('OTF', 'Open Technology Fund'), true);
});

test('sameOrgIdentity keeps unrelated orgs apart', () => {
  assert.equal(sameOrgIdentity('Gitcoin', 'Optimism'), false);
  assert.equal(sameOrgIdentity('AWS', 'Google'), false);
  // A shared initial letter is not an initialism match
  assert.equal(sameOrgIdentity('AWS', 'Applied Web Standards Group'), false);
});

test('sameOrgIdentity handles the existing substring and null cases', () => {
  assert.equal(sameOrgIdentity('Rain Protocol', 'Rain Protocol Foundation'), true);
  assert.equal(sameOrgIdentity(null, 'Gitcoin'), false);
  assert.equal(sameOrgIdentity('Gitcoin', null), false);
  assert.equal(sameOrgIdentity(null, null), false);
});

test('createProgram does NOT fork the key for an acronym org variant', async () => {
  const pool = programPool([{ id: 42, org_name: 'Amazon Web Services' }]);
  await createProgram(pool, {
    name: 'AWS AI & ML Scholars Program',
    canonicalName: 'AWS AI & ML Scholars Program',
    orgName: 'AWS',
    wire: 'ai',
    sourceUrl: 'https://aws.amazon.com/scholars',
    roundLabel: null,
  });
  const insert = pool.calls.find(c => /INSERT INTO programs/.test(c.sql));
  assert.ok(insert);
  assert.equal(insert.params[1].includes('--'), false,
    'an acronym/expansion org variant must not disambiguate the key');
});

test('createProgram STILL forks the key for a genuinely different org', async () => {
  const pool = programPool([{ id: 42, org_name: 'Optimism' }]);
  await createProgram(pool, {
    name: 'Round Table Grants',
    canonicalName: 'Round Table Grants',
    orgName: 'Gitcoin',
    wire: 'crypto',
    sourceUrl: 'https://gitcoin.co/grants',
    roundLabel: null,
  });
  const insert = pool.calls.find(c => /INSERT INTO programs/.test(c.sql));
  assert.match(insert.params[1], /--gitcoin$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/program-identity.test.js`
Expected: FAIL — `sameOrgIdentity is not a function`, and the acronym test reports a key containing `--aws`.

- [ ] **Step 3: Write minimal implementation**

In `src/services/program-identity.ts`, below the `norm` helper (line 101), add:

```typescript
/** Initials of the significant words: "Amazon Web Services" -> "aws". */
function initialsOf(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !['of', 'the', 'and', 'for', 'a', 'an'].includes(w))
    .map(w => w[0])
    .join('');
}

/**
 * Do two org strings name the same funder?
 *
 * Sources write the same org as "AWS" and "Amazon Web Services"; the
 * collision guard used raw string comparison and forked the program key on
 * that difference alone, minting a duplicate program row. Exact, substring,
 * and initialism agreement all count as one identity.
 */
export function sameOrgIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  // Initialism: compare the acronym form of the longer name to the shorter.
  const [short, long] = x.length <= y.length ? [x, a] : [y, b];
  const initials = initialsOf(long);
  return initials.length >= 2 && initials === short;
}
```

Then replace the collision guard inside `createProgram` (the `if (orgNorm) { … }` block) with:

```typescript
  if (data.orgName) {
    const existing = await pool.query(`SELECT org_name FROM programs WHERE normalized_key = $1`, [key]) as { rows: Array<{ org_name: string | null }> };
    const other = existing.rows[0]?.org_name ?? null;
    if (other && !sameOrgIdentity(other, data.orgName)) {
      key = `${key}--${norm(data.orgName)}`;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/program-identity.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && node --test tests/**/*.test.js`
Expected: `tsc` exits 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/program-identity.ts tests/program-identity.test.js
git commit -m "fix(program-identity): compare org identity, not org spelling, in the collision guard"
```

**Part A is independently shippable here.** Open a PR with Tasks 1–2 and deploy before starting Part B — merging while the matcher still mints ghosts just refills the bucket.

---

## Part B — Merge the existing duplicates

### Task 3: `mergePrograms` service

Folds a duplicate program row into the row that owns its entries' duplicate chain. Modelled on `src/services/org-merge.ts`, but transactional and lock-taking because it moves rows the dedup graph points at.

**Files:**
- Create: `src/services/program-merge.ts`
- Test: `tests/program-merge.test.js`

**Interfaces:**
- Consumes: `refreshProgramCounters`, `TransactionPool`, `QueryPool` from `src/services/program-identity.ts`; `lockDuplicateGraph` from `src/services/duplicate-chain.ts`.
- Produces:
  - `interface ProgramMergeResult { sourceId: number; targetId: number; entriesRelinked: number; aliasesAdded: number; domainsAdded: number; }`
  - `mergePrograms(pool: TransactionPool, sourceId: number, targetId: number): Promise<ProgramMergeResult>`
  - `mergeProgramsInTransaction(client: QueryPool, sourceId: number, targetId: number): Promise<ProgramMergeResult>` — the same work against a caller-supplied client, used by Task 4's batch apply.

- [ ] **Step 1: Write the failing test**

Create `tests/program-merge.test.js`:

```javascript
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePrograms } = require('../src/services/program-merge');

function mergePool(handler) {
  const calls = [];
  const client = {
    async query(sql, params) { calls.push({ sql, params }); return handler(sql, params); },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return { calls, async connect() { calls.push({ sql: 'CONNECT', params: [] }); return client; } };
}

const twoPrograms = (sql) => {
  if (/SELECT id, canonical_name, aliases, url_domains, org_name FROM programs/.test(sql)) {
    return { rows: [
      { id: 7, canonical_name: 'AWS AI & ML Scholars Program', aliases: ['AWS Scholars'], url_domains: ['aws.amazon.com'], org_name: 'Amazon Web Services' },
      { id: 783, canonical_name: 'AWS AI & ML Scholars Program', aliases: ['AWS AI Scholars'], url_domains: ['amazon.com'], org_name: 'AWS' },
    ] };
  }
  if (/UPDATE scan_entries SET program_id/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }] };
  return { rows: [] };
};

test('mergePrograms relinks entries, unions metadata, deletes the source', async () => {
  const pool = mergePool(twoPrograms);
  const result = await mergePrograms(pool, 7, 783);

  const sqls = pool.calls.map(c => c.sql).join('\n');
  assert.match(sqls, /BEGIN/);
  assert.match(sqls, /pg_advisory_xact_lock/);          // duplicate-graph lock
  assert.match(sqls, /UPDATE scan_entries SET program_id/);
  assert.match(sqls, /UPDATE programs SET/);            // alias/domain union on target
  assert.match(sqls, /DELETE FROM programs WHERE id = \$1/);
  assert.match(sqls, /COMMIT/);
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');

  assert.equal(result.sourceId, 7);
  assert.equal(result.targetId, 783);
  assert.equal(result.entriesRelinked, 2);
});

test('mergePrograms refuses to merge a program into itself', async () => {
  const pool = mergePool(twoPrograms);
  await assert.rejects(() => mergePrograms(pool, 7, 7), /into itself/);
});

test('mergePrograms rolls back when a program is missing', async () => {
  const pool = mergePool(sql => {
    if (/SELECT id, canonical_name, aliases, url_domains, org_name FROM programs/.test(sql)) {
      return { rows: [{ id: 7, canonical_name: 'X', aliases: [], url_domains: [], org_name: null }] };
    }
    return { rows: [] };
  });
  await assert.rejects(() => mergePrograms(pool, 7, 783), /not found/);
  assert.ok(pool.calls.some(c => c.sql === 'ROLLBACK'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/program-merge.test.js`
Expected: FAIL — `Cannot find module '../src/services/program-merge'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/program-merge.ts`:

```typescript
import { lockDuplicateGraph } from './duplicate-chain';
import { refreshProgramCounters } from './program-identity';
import type { QueryPool, TransactionPool } from './program-identity';

export interface ProgramMergeResult {
  sourceId: number;
  targetId: number;
  entriesRelinked: number;
  aliasesAdded: number;
  domainsAdded: number;
}

interface ProgramRowLite {
  id: number;
  canonical_name: string;
  aliases: string[] | null;
  url_domains: string[] | null;
  org_name: string | null;
}

/** Fold `sourceId` into `targetId` using a caller-supplied transaction client. */
export async function mergeProgramsInTransaction(
  client: QueryPool,
  sourceId: number,
  targetId: number,
): Promise<ProgramMergeResult> {
  if (sourceId === targetId) throw new Error('Cannot merge a program into itself');

  const { rows } = await client.query(
    `SELECT id, canonical_name, aliases, url_domains, org_name FROM programs
     WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [[sourceId, targetId]],
  ) as { rows: ProgramRowLite[] };
  const source = rows.find(r => Number(r.id) === sourceId);
  const target = rows.find(r => Number(r.id) === targetId);
  if (!source) throw new Error(`Source program id=${sourceId} not found`);
  if (!target) throw new Error(`Target program id=${targetId} not found`);

  const relinked = await client.query(
    `UPDATE scan_entries SET program_id = $1 WHERE program_id = $2 RETURNING id`,
    [targetId, sourceId],
  );

  // The source's name and every alias it collected become target aliases, so
  // resolveProgram keeps matching the wording that produced the duplicate.
  const addedAliases = [...new Set([source.canonical_name, ...(source.aliases ?? [])])]
    .filter(a => a && !(target.aliases ?? []).includes(a));
  const addedDomains = [...new Set(source.url_domains ?? [])]
    .filter(d => d && !(target.url_domains ?? []).includes(d));

  await client.query(
    `UPDATE programs SET
       aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))),
       url_domains = (SELECT ARRAY(SELECT DISTINCT unnest(url_domains || $3::text[]))),
       org_name = COALESCE(org_name, $4),
       updated_at = NOW()
     WHERE id = $1`,
    [targetId, addedAliases, addedDomains, source.org_name],
  );

  await client.query(`DELETE FROM programs WHERE id = $1`, [sourceId]);

  // Recompute counters/canonical AFTER the relink so the target owns them.
  await refreshProgramCounters(client, [targetId]);

  return {
    sourceId,
    targetId,
    entriesRelinked: relinked.rows.length,
    aliasesAdded: addedAliases.length,
    domainsAdded: addedDomains.length,
  };
}

/** Fold `sourceId` into `targetId` in its own transaction. */
export async function mergePrograms(
  pool: TransactionPool,
  sourceId: number,
  targetId: number,
): Promise<ProgramMergeResult> {
  if (sourceId === targetId) throw new Error('Cannot merge a program into itself');
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    await lockDuplicateGraph(client);
    const result = await mergeProgramsInTransaction(client, sourceId, targetId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (began) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/program-merge.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && node --test tests/**/*.test.js`
Expected: `tsc` exits 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/program-merge.ts tests/program-merge.test.js
git commit -m "feat(program-merge): transactional fold of a duplicate program into its target"
```

---

### Task 4: Merge plan builder with confidence tiers

Proposes every ghost→target pair. A ghost is a program whose entries are all `duplicate` and whose chain heads sit under one other program. Two tiers so the mechanical majority can apply without a human reading 758 rows:

- **auto** — ghost and target program names share ≥60% tokens, **or** their orgs agree via `sameOrgIdentity`. (Measured against production: 528 of 727.)
- **review** — everything else; listed in the plan, never applied by `--tier auto`. (199 rows.)

The `review` tier is not merely "unclear merges" — sampling it shows it also surfaces **upstream dedup mistakes**, where two unrelated programs got chained together:

```
#49  "Coreum Grants"                          -> #3432 "RockNBlock: 50 Blockchain Ecosystem Grants for 2026"
#26  "NSF Program on Fairness in AI"          -> #3239 "Department of Energy FAIR Data and Models for AI"
#222 "Security Lab Request for Proposals"     -> #1461 "Open Technology Fund"
```

Merging those would be wrong. That is exactly why the tier exists and why `--tier review` must never be run unattended.

**Files:**
- Create: `src/services/program-merge-plan.ts`
- Test: `tests/program-merge-plan.test.js`

**Interfaces:**
- Consumes: `sameOrgIdentity` (Task 2); `mergeProgramsInTransaction` (Task 3); `QueryPool`, `TransactionPool` from `program-identity.ts`.
- Produces:
  - `interface MergeCandidate { sourceId: number; sourceName: string; targetId: number; targetName: string; entryCount: number; tier: 'auto' | 'review'; reason: string; }`
  - `interface MergePlan { version: 1; candidates: MergeCandidate[]; planHash: string; }`
  - `buildMergePlan(db: QueryPool): Promise<MergePlan>`
  - `runProgramMerge(pool: TransactionPool, options: { apply?: boolean; expectedPlanHash?: string; tier?: 'auto' | 'review' }): Promise<MergeReceipt>`
  - `interface MergeReceipt { script: 'program-merge'; version: 1; mode: 'dry-run' | 'apply'; planHash: string; tier: 'auto' | 'review'; candidates: MergeCandidate[]; applied: number; }`

- [ ] **Step 1: Write the failing test**

Create `tests/program-merge-plan.test.js`:

```javascript
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMergePlan, runProgramMerge } = require('../src/services/program-merge-plan');

const CANDIDATE_ROWS = [
  // near-identical names -> auto
  { source_id: 84, source_name: 'Rain Protocol Grant Program', source_org: 'Rain Protocol',
    target_id: 150, target_name: 'Rain Protocol Grants', target_org: 'Rain Protocol', entry_count: 1 },
  // different names, same org via acronym -> auto
  { source_id: 7, source_name: 'AWS AI & ML Scholars Program', source_org: 'Amazon Web Services',
    target_id: 783, target_name: 'Scholars Program', target_org: 'AWS', entry_count: 1 },
  // unrelated names and orgs -> review
  { source_id: 310, source_name: 'Antigravity Pro Plan Quota Changes', source_org: null,
    target_id: 364, target_name: 'Systemic Model Quota Failure', target_org: null, entry_count: 13 },
];

const planPool = (rows = CANDIDATE_ROWS) => ({
  calls: [],
  async query(sql, params) {
    this.calls.push({ sql, params });
    if (/FROM programs/.test(sql)) return { rows };
    return { rows: [] };
  },
});

test('buildMergePlan tiers by name overlap and org identity', async () => {
  const plan = await buildMergePlan(planPool());
  assert.equal(plan.candidates.length, 3);
  const byId = Object.fromEntries(plan.candidates.map(c => [c.sourceId, c]));
  assert.equal(byId[84].tier, 'auto');
  assert.equal(byId[7].tier, 'auto');
  assert.equal(byId[310].tier, 'review');
  assert.match(byId[7].reason, /org/i);
});

test('buildMergePlan hashes the plan deterministically', async () => {
  const a = await buildMergePlan(planPool());
  const b = await buildMergePlan(planPool());
  assert.equal(a.planHash, b.planHash);
  assert.match(a.planHash, /^[a-f0-9]{64}$/);
});

test('runProgramMerge dry-run opens no transaction', async () => {
  const pool = planPool();
  pool.connect = async () => { throw new Error('dry run must not connect'); };
  const receipt = await runProgramMerge(pool, {});
  assert.equal(receipt.mode, 'dry-run');
  assert.equal(receipt.applied, 0);
  assert.equal(receipt.candidates.length, 3);
});

test('runProgramMerge apply refuses a missing or malformed plan hash', async () => {
  const pool = planPool();
  await assert.rejects(() => runProgramMerge(pool, { apply: true }), /expect-plan-hash/);
  await assert.rejects(() => runProgramMerge(pool, { apply: true, expectedPlanHash: 'nope' }), /expect-plan-hash/);
});

test('runProgramMerge apply aborts when the plan drifted', async () => {
  const pool = planPool();
  const client = { async query() { return { rows: CANDIDATE_ROWS }; }, release() {} };
  pool.connect = async () => client;
  await assert.rejects(
    () => runProgramMerge(pool, { apply: true, expectedPlanHash: 'a'.repeat(64) }),
    /drifted/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/program-merge-plan.test.js`
Expected: FAIL — `Cannot find module '../src/services/program-merge-plan'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/program-merge-plan.ts`:

```typescript
import { createHash } from 'node:crypto';
import { sameOrgIdentity } from './program-identity';
import type { QueryPool, TransactionPool } from './program-identity';
import { mergeProgramsInTransaction } from './program-merge';
import { lockDuplicateGraph } from './duplicate-chain';

export interface MergeCandidate {
  sourceId: number;
  sourceName: string;
  targetId: number;
  targetName: string;
  entryCount: number;
  tier: 'auto' | 'review';
  reason: string;
}

export interface MergePlan {
  version: 1;
  candidates: MergeCandidate[];
  planHash: string;
}

export interface MergeReceipt {
  script: 'program-merge';
  version: 1;
  mode: 'dry-run' | 'apply';
  planHash: string;
  tier: 'auto' | 'review';
  candidates: MergeCandidate[];
  applied: number;
}

// A ghost program: every one of its entries is a duplicate, and every chain
// head resolves to exactly ONE other program. That single program is the
// merge target.
const CANDIDATE_SQL = `
  WITH ghost AS (
    SELECT p.id
    FROM programs p
    JOIN scan_entries e ON e.program_id = p.id
    GROUP BY p.id
    HAVING COUNT(*) FILTER (WHERE e.status <> 'duplicate') = 0
  ), head AS (
    SELECT g.id AS source_id, h.program_id AS target_id, COUNT(*)::int AS hits
    FROM ghost g
    JOIN scan_entries e ON e.program_id = g.id
    JOIN scan_entries h ON h.id = e.duplicate_of_id
    WHERE h.program_id IS NOT NULL AND h.program_id <> g.id
    GROUP BY g.id, h.program_id
  ), single_target AS (
    SELECT source_id, MIN(target_id)::int AS target_id
    FROM head GROUP BY source_id HAVING COUNT(DISTINCT target_id) = 1
  )
  SELECT s.source_id, sp.canonical_name AS source_name, sp.org_name AS source_org,
         s.target_id, tp.canonical_name AS target_name, tp.org_name AS target_org,
         sp.entry_count
  FROM single_target s
  JOIN programs sp ON sp.id = s.source_id
  JOIN programs tp ON tp.id = s.target_id
  ORDER BY s.source_id`;

const tokens = (s: string): Set<string> =>
  new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 2));

function nameOverlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  const shared = [...A].filter(t => B.has(t)).length;
  return shared / Math.min(A.size, B.size);
}

export async function buildMergePlan(db: QueryPool): Promise<MergePlan> {
  const { rows } = await db.query(CANDIDATE_SQL);
  const candidates: MergeCandidate[] = rows.map((r: any) => {
    const overlap = nameOverlap(r.source_name, r.target_name);
    const orgAgrees = sameOrgIdentity(r.source_org, r.target_org);
    const tier: 'auto' | 'review' = overlap >= 0.6 || orgAgrees ? 'auto' : 'review';
    const reason = overlap >= 0.6
      ? `name overlap ${Math.round(overlap * 100)}%`
      : orgAgrees
        ? `same org identity ("${r.source_org}" ≡ "${r.target_org}")`
        : `name overlap ${Math.round(overlap * 100)}%, orgs disagree`;
    return {
      sourceId: Number(r.source_id),
      sourceName: String(r.source_name),
      targetId: Number(r.target_id),
      targetName: String(r.target_name),
      entryCount: Number(r.entry_count ?? 0),
      tier,
      reason,
    };
  });
  const body = { version: 1 as const, candidates };
  return { ...body, planHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

export async function runProgramMerge(
  pool: TransactionPool,
  options: { apply?: boolean; expectedPlanHash?: string; tier?: 'auto' | 'review' } = {},
): Promise<MergeReceipt> {
  const tier = options.tier ?? 'auto';
  if (!options.apply) {
    const plan = await buildMergePlan(pool);
    return { script: 'program-merge', version: 1, mode: 'dry-run', planHash: plan.planHash, tier, candidates: plan.candidates, applied: 0 };
  }
  if (!/^[a-f0-9]{64}$/.test(options.expectedPlanHash ?? '')) {
    throw new Error('Apply requires --expect-plan-hash with the reviewed 64-character SHA-256 hash');
  }

  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '300s'`);
    await lockDuplicateGraph(client);

    const plan = await buildMergePlan(client);
    if (plan.planHash !== options.expectedPlanHash) {
      throw new Error(`Merge plan drifted: expected ${options.expectedPlanHash}, current ${plan.planHash}`);
    }

    // 'auto' applies only auto rows; 'review' applies everything.
    const doomed = tier === 'auto' ? plan.candidates.filter(c => c.tier === 'auto') : plan.candidates;
    for (const c of doomed) {
      await mergeProgramsInTransaction(client, c.sourceId, c.targetId);
    }

    await client.query('COMMIT');
    return { script: 'program-merge', version: 1, mode: 'apply', planHash: plan.planHash, tier, candidates: doomed, applied: doomed.length };
  } catch (error) {
    if (began) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/program-merge-plan.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && node --test tests/**/*.test.js`
Expected: `tsc` exits 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/program-merge-plan.ts tests/program-merge-plan.test.js
git commit -m "feat(program-merge): tiered merge plan with a reviewed plan hash"
```

---

### Task 5: CLI script

**Files:**
- Create: `src/scripts/program-merge.ts`
- Test: covered by Task 4's unit tests plus Task 6's DB test; the arg parser gets its own assertions here.

**Interfaces:**
- Consumes: `runProgramMerge` (Task 4); `getPool`, `closePool` from `src/db`.
- Produces: `parseMergeArgs(argv: string[]): { apply: boolean; expectedPlanHash?: string; tier: 'auto' | 'review' }`

- [ ] **Step 1: Write the failing test**

Append to `tests/program-merge-plan.test.js`:

```javascript
const { parseMergeArgs } = require('../src/scripts/program-merge');

test('parseMergeArgs defaults to a dry run on the auto tier', () => {
  assert.deepEqual(parseMergeArgs([]), { apply: false, expectedPlanHash: undefined, tier: 'auto' });
});

test('parseMergeArgs accepts apply with a hash and an explicit tier', () => {
  const hash = 'b'.repeat(64);
  assert.deepEqual(
    parseMergeArgs(['--apply', '--expect-plan-hash', hash, '--tier', 'review']),
    { apply: true, expectedPlanHash: hash, tier: 'review' },
  );
});

test('parseMergeArgs rejects apply without a valid hash and unknown flags', () => {
  assert.throws(() => parseMergeArgs(['--apply']), /expect-plan-hash/);
  assert.throws(() => parseMergeArgs(['--apply', '--expect-plan-hash', 'short']), /expect-plan-hash/);
  assert.throws(() => parseMergeArgs(['--tier', 'sideways']), /tier/);
  assert.throws(() => parseMergeArgs(['--wat']), /Unknown argument/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/program-merge-plan.test.js`
Expected: FAIL — `Cannot find module '../src/scripts/program-merge'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/scripts/program-merge.ts`:

```typescript
/**
 * Merge duplicate ("ghost") program rows into the program that owns their
 * entries' duplicate chain.
 *
 * Read-only by default — prints the plan and its hash:
 *   railway run npx ts-node src/scripts/program-merge.ts
 *
 * Apply only the reviewed, unchanged plan:
 *   railway run npx ts-node src/scripts/program-merge.ts \
 *     --apply --expect-plan-hash <sha256> [--tier auto|review]
 */
import { closePool, getPool } from '../db';
import { runProgramMerge } from '../services/program-merge-plan';

export interface MergeCliOptions {
  apply: boolean;
  expectedPlanHash?: string;
  tier: 'auto' | 'review';
}

export function parseMergeArgs(argv: string[]): MergeCliOptions {
  let apply = false;
  let expectedPlanHash: string | undefined;
  let tier: 'auto' | 'review' = 'auto';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--expect-plan-hash') {
      expectedPlanHash = argv[++i];
      if (!expectedPlanHash) throw new Error('--expect-plan-hash requires a value');
    } else if (arg.startsWith('--expect-plan-hash=')) {
      expectedPlanHash = arg.slice('--expect-plan-hash='.length);
    } else if (arg === '--tier') {
      const value = argv[++i];
      if (value !== 'auto' && value !== 'review') throw new Error('--tier must be auto or review');
      tier = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (apply && !/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')) {
    throw new Error('--apply requires --expect-plan-hash with the reviewed 64-character SHA-256 hash');
  }
  return { apply, expectedPlanHash, tier };
}

async function main(): Promise<void> {
  const options = parseMergeArgs(process.argv.slice(2));
  try {
    const receipt = await runProgramMerge(getPool(), options);
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('PROGRAM MERGE FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/program-merge-plan.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && node --test tests/**/*.test.js`
Expected: `tsc` exits 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/program-merge.ts tests/program-merge-plan.test.js
git commit -m "feat(program-merge): dry-run-first CLI"
```

---

### Task 6: Real-Postgres end-to-end test

Stub pools cannot catch a mistake in the ghost-detection CTE. This exercises it against a real server, mirroring `tests/program-integrity-db.test.js`.

**Files:**
- Create: `tests/program-merge-db.test.js`

**Interfaces:**
- Consumes: `buildMergePlan`, `runProgramMerge` (Task 4); `mergePrograms` (Task 3).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/program-merge-db.test.js`:

```javascript
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { buildMergePlan, runProgramMerge } = require('../src/services/program-merge-plan');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping program-merge DB tests: DATABASE_URL not set');
  process.exit(0);
}

const schema = `program_merge_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: DB_URL });
const pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });

test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE programs (
      id SERIAL PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_key TEXT NOT NULL UNIQUE,
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
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE scan_entries (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      program_id INTEGER REFERENCES programs(id),
      duplicate_of_id INTEGER REFERENCES scan_entries(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
});

test.after(async () => {
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
  await admin.end();
});

test('a ghost program is detected, merged, and leaves the gate satisfied', async () => {
  const target = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key, org_name, entry_count)
     VALUES ('Rain Protocol Grants', 'rainprotocolgrants', 'Rain Protocol', 0) RETURNING id`);
  const ghost = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key, org_name, entry_count)
     VALUES ('Rain Protocol Grant Program', 'rainprotocolgrantprogram', 'Rain Protocol', 0) RETURNING id`);
  const targetId = target.rows[0].id;
  const ghostId = ghost.rows[0].id;

  const head = await pool.query(
    `INSERT INTO scan_entries (name, status, program_id) VALUES ('Rain Grants', 'approved', $1) RETURNING id`,
    [targetId]);
  await pool.query(
    `INSERT INTO scan_entries (name, status, program_id, duplicate_of_id)
     VALUES ('Rain Grant Program', 'duplicate', $1, $2)`,
    [ghostId, head.rows[0].id]);

  const plan = await buildMergePlan(pool);
  const candidate = plan.candidates.find(c => c.sourceId === ghostId);
  assert.ok(candidate, 'the ghost must appear in the plan');
  assert.equal(candidate.targetId, targetId);
  assert.equal(candidate.tier, 'auto');

  const receipt = await runProgramMerge(pool, { apply: true, expectedPlanHash: plan.planHash, tier: 'auto' });
  assert.equal(receipt.applied, plan.candidates.filter(c => c.tier === 'auto').length);

  const gone = await pool.query(`SELECT id FROM programs WHERE id = $1`, [ghostId]);
  assert.equal(gone.rows.length, 0, 'the ghost row is deleted');

  const survivor = await pool.query(
    `SELECT entry_count, approved_count, canonical_entry_id, aliases FROM programs WHERE id = $1`, [targetId]);
  const row = survivor.rows[0];
  assert.equal(row.entry_count, 2, 'both entries now belong to the target');
  assert.equal(row.approved_count, 1);
  assert.ok(row.canonical_entry_id, 'the Layer 1.75 gate needs a canonical entry');
  assert.ok(row.aliases.includes('Rain Protocol Grant Program'), 'the ghost name survives as an alias');

  const relinked = await pool.query(`SELECT COUNT(*)::int AS n FROM scan_entries WHERE program_id = $1`, [targetId]);
  assert.equal(relinked.rows[0].n, 2);
});

test('the plan is empty once every ghost is merged (idempotent)', async () => {
  const plan = await buildMergePlan(pool);
  assert.equal(plan.candidates.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Start a throwaway server (the socket dir must be short — Postgres caps the socket path at 103 bytes):

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
mkdir -p /tmp/wrops-pg
initdb -D /tmp/wrops-pg/data -U postgres --auth=trust
pg_ctl -D /tmp/wrops-pg/data -o "-p 55432 -k /tmp/wrops-pg" -l /tmp/wrops-pg/pg.log start
createdb -h 127.0.0.1 -p 55432 -U postgres wireops_test
```

Run: `DATABASE_URL="postgres://postgres@127.0.0.1:55432/wireops_test" node --test tests/program-merge-db.test.js`
Expected: FAIL — the plan is empty or the ghost survives, depending on which piece is still wrong.

- [ ] **Step 3: Fix whatever the real server rejects**

No new module. Correct `CANDIDATE_SQL` in `src/services/program-merge-plan.ts` until the test passes. The likely miss is the `HAVING COUNT(*) FILTER (WHERE e.status <> 'duplicate') = 0` clause silently excluding programs with zero entries — those are not ghosts and must not appear.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgres://postgres@127.0.0.1:55432/wireops_test" node --test tests/program-merge-db.test.js`
Expected: PASS, 2 tests.

Tear down:

```bash
pg_ctl -D /tmp/wrops-pg/data stop -m fast && rm -rf /tmp/wrops-pg
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && node --test tests/**/*.test.js`
Expected: `tsc` exits 0; all tests pass (the DB test skips without `DATABASE_URL`).

- [ ] **Step 6: Commit**

```bash
git add tests/program-merge-db.test.js src/services/program-merge-plan.ts
git commit -m "test(program-merge): real-Postgres coverage of ghost detection and merge"
```

---

## Production rollout (after both PRs deploy)

Run from a machine with production `DATABASE_URL`. Every step is reversible until `--apply`.

- [ ] **1. Dry run, read the plan**

```bash
railway run npx ts-node src/scripts/program-merge.ts > merge-plan.json
```

Expect ~727 candidates, ~528 tier `auto` (verified against production 2026-07-27). A materially different count means the matcher fix in Part A changed behaviour — re-read the plan before applying.

- [ ] **2. Spot-check 10 auto rows by hand.** Confirm each `sourceName`/`targetName` pair really is one program. If any is wrong, tighten the tiering in `buildMergePlan` and re-run — do not hand-edit the plan.

- [ ] **3. Snapshot before mutating**

```bash
pg_dump "$DATABASE_URL" -t programs -t scan_entries --no-owner --no-acl | gzip > programs-pre-merge.sql.gz
```

- [ ] **4. Apply the auto tier**

```bash
railway run npx ts-node src/scripts/program-merge.ts \
  --apply --expect-plan-hash "$(jq -r .planHash merge-plan.json)" --tier auto
```

- [ ] **5. Verify the gate still works.** `programs` should drop by the applied count, and no surviving program with `entry_count > 0` should have a null `canonical_entry_id`:

```sql
SELECT COUNT(*) FROM programs WHERE entry_count > 0 AND canonical_entry_id IS NULL;
```

Expect a small number, and strictly fewer than the 1,008 baseline.

- [ ] **6. Re-run the integrity dry run.** `src/scripts/program-integrity-repair.ts` should now propose far fewer than 1,262 rows, and the `canonical: id -> null` share should be a fraction of the 1,008 baseline. Only then decide whether to apply it.

- [ ] **7. Take the `review` tier (199 rows) to the operator** as a list. Do not auto-apply it. It holds three different things that each want a different answer: forum-noise rows (bug reports that were given program identities — delete), genuine merges the heuristic could not score (merge), and **upstream dedup false positives** like `Coreum Grants -> RockNBlock listicle` (leave the programs alone; the wrong call was the entry-level duplicate link, which is a separate fix).

---

## Self-Review

**Spec coverage.** Matcher suffix defect → Task 1. Org-collision defect → Task 2. Merge mechanism → Task 3. Candidate selection and human gate → Task 4. Operator entry point → Task 5. SQL verified against a real server → Task 6. Rollout and the interaction with the existing integrity script → the rollout section. The 259 ghosts whose chain head has no program are deliberately **out of scope** — `CANDIDATE_SQL` requires `h.program_id IS NOT NULL`, so they are never proposed; they need the head to be given a program first, which is a separate piece of work.

**Placeholder scan.** No TBDs. Every code step carries the actual code; every test step carries the actual assertions; every run step names the command and the expected result.

**Type consistency.** `QueryPool`/`TransactionPool` are imported from `program-identity.ts` in all three new modules, matching the existing `program-integrity.ts` convention. `mergeProgramsInTransaction` takes `QueryPool` (a client inside a caller's transaction); `mergePrograms` takes `TransactionPool` (it opens its own). `MergeCandidate.tier` is the same `'auto' | 'review'` union in the plan builder, the receipt, and the CLI options. `buildMergePlan` and `runProgramMerge` are the only names crossing the service/script boundary, and both appear with identical signatures in Tasks 4, 5, and 6.
