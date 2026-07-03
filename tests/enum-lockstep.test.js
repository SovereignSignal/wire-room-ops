// Pins the enum/CHECK-constraint drift class that crash-looped production
// three times in June 2026. Since Phase 5, drift is impossible BY CONSTRUCTION:
// every CHECK constraint, TS union, and route validator derives from the
// canonical consts in src/types/intake.ts, and all DDL runs through the one
// ordered list in src/db/startup-migrations.ts. This test pins that wiring —
// it fails if anyone reintroduces a hand-maintained literal list.
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const {
  SCAN_SOURCES, SCAN_STATUSES, SCHEDULE_TYPES, SURFACE_TYPES, TOOL_TYPES, TOOL_TYPES_DB, sqlEnumList,
} = require('../src/types/intake');

test('canonical consts have the expected shape', () => {
  assert.equal(SCAN_SOURCES.length, 14);
  assert.equal(SCAN_STATUSES.length, 11);
  assert.ok(SCAN_STATUSES.includes('incomplete'), 'the June drift value must stay in the list');
  assert.equal(SCHEDULE_TYPES.length, 6);
  for (const t of TOOL_TYPES) assert.ok(TOOL_TYPES_DB.includes(t), `TOOL_TYPES_DB must contain '${t}'`);
  assert.ok(TOOL_TYPES_DB.includes('community'), 'legacy community rows must stay DB-valid');
  assert.equal(sqlEnumList(['a', 'b']), "'a', 'b'");
});

test('db/index.ts builds every CHECK constraint from the canonical consts (no literal lists)', () => {
  const db = read('src/db/index.ts');
  // Interpolations present, with the right multiplicity per column
  assert.ok((db.match(/sqlEnumList\(SCAN_STATUSES\)/g) || []).length >= 3, 'all 3 status CHECK writers must interpolate SCAN_STATUSES');
  assert.ok((db.match(/sqlEnumList\(SCAN_SOURCES\)/g) || []).length >= 1, 'scan_source CHECK must interpolate SCAN_SOURCES');
  assert.ok((db.match(/sqlEnumList\(SCHEDULE_TYPES\)/g) || []).length >= 2, 'schedule_type normalizer + CHECK must interpolate SCHEDULE_TYPES');
  assert.ok((db.match(/sqlEnumList\(SURFACE_TYPES\)/g) || []).length >= 1, 'surface_type CHECK must interpolate SURFACE_TYPES');
  assert.ok((db.match(/sqlEnumList\(TOOL_TYPES_DB\)/g) || []).length >= 2, 'both tool_type CHECK writers must interpolate TOOL_TYPES_DB');
  // No hand-maintained literal CHECK lists may remain for these columns
  assert.ok(!/CHECK \(status IN \('raw'/.test(db), 'literal status CHECK list reintroduced');
  assert.ok(!/CHECK \(scan_source IN \('x-scan'/.test(db), 'literal scan_source CHECK list reintroduced');
  assert.ok(!/CHECK \(schedule_type IN \('scan-execution'/.test(db), 'literal schedule_type CHECK list reintroduced');
  assert.ok(!/CHECK \(surface_type IN \('grants_page'/.test(db), 'literal surface_type CHECK list reintroduced');
  assert.ok(!/CHECK \(tool_type IN \('x_search'/.test(db), 'literal tool_type CHECK list reintroduced');
  // parseScheduleRow validates via the const, not a branch chain
  assert.ok(/SCHEDULE_TYPES as readonly string\[\]\)\.includes\(row\.schedule_type\)/.test(db), 'parseScheduleRow must validate via SCHEDULE_TYPES');
});

test('route validators use the canonical consts', () => {
  const sched = read('src/routes/schedules.ts');
  assert.ok(sched.includes('SCHEDULE_TYPES as readonly string[]).includes(scheduleType)'), 'schedules route must validate via SCHEDULE_TYPES');
  assert.ok(!/\[\s*'scan-execution',\s*'forum-scan'/.test(sched), 'literal schedule-type list reintroduced in schedules route');
  const prompts = read('src/routes/scan-prompts.ts');
  assert.ok(prompts.includes('TOOL_TYPES as readonly string[]).includes(toolType)'), 'scan-prompts route must validate via TOOL_TYPES');
  assert.ok(!/\[\s*'x_search',\s*'web_search',\s*'perplexity'/.test(prompts), 'literal tool-type list reintroduced in scan-prompts route');
});

test('TS unions derive from the consts (typeof X[number])', () => {
  const t = read('src/types/intake.ts');
  for (const name of ['SCAN_SOURCES', 'SCAN_STATUSES', 'SCHEDULE_TYPES', 'SURFACE_TYPES', 'TOOL_TYPES']) {
    assert.ok(t.includes(`typeof ${name}[number]`), `union for ${name} must derive from the const`);
  }
  const db = read('src/db/index.ts');
  assert.ok(db.includes('scheduleType?: ScheduleType;'), 'StoredScheduleConfig must use the shared ScheduleType');
  const sched = read('src/services/scheduler.ts');
  assert.ok(sched.includes('scheduleType?: ScheduleType;'), 'ScheduleConfig must use the shared ScheduleType');
});

test('the startup-migration list is the only schema path (no ad-hoc ensures in boot code)', () => {
  const mig = read('src/db/startup-migrations.ts');
  const listed = [...mig.matchAll(/\{ name: '([a-z-]+)', run: (ensure\w+) \}/g)];
  assert.ok(listed.length >= 16, `expected >=16 migrations, found ${listed.length}`);

  const server = read('src/server.ts');
  assert.ok(server.includes('runStartupMigrations()'), 'server boot must run the canonical list');
  assert.ok(!/await ensure\w+\(\)/.test(server), 'server.ts must not call ensure* directly');

  const ci = read('scripts/ci-db-setup.ts');
  assert.ok(ci.includes('runStartupMigrations({ fatal: true })'), 'CI must run the canonical list fatally');
  assert.ok(!/await ensure\w+\(\)/.test(ci), 'ci-db-setup must not call ensure* directly');

  const sched = read('src/services/scheduler.ts');
  assert.ok(!/await ensure(ScheduleTable|FeedsTable|ScanTables|ScanPromptsTable|DistributionTables)\(\)/.test(sched), 'initScheduler must not run its own ensures');
});
