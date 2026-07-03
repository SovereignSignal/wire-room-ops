// Pins the enum/CHECK-constraint drift class that crash-looped production
// three times in June 2026: multiple ensure* functions DROP+ADD the same CHECK
// constraint, and the allowed values drifted apart from each other and from
// the TypeScript unions / route validators that write those columns.
// This test fails the moment any writer of an enum falls out of lockstep.
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** Extract the quoted values of every `CHECK (<col> IN ('a','b',...))` DDL
 *  occurrence — anchored on CHECK so query-time `IN (...)` filters don't match. */
function checkConstraintSets(source, col) {
  const sets = [];
  const re = new RegExp(`CHECK\\s*\\(\\s*${col}\\s+IN\\s*\\(([^)]+)\\)`, 'g');
  let m;
  while ((m = re.exec(source))) {
    sets.push(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
  }
  return sets;
}

const dbSource = read('src/db/index.ts');

test('scan_entries.status: every CHECK writer is identical and matches the ScanStatus union', () => {
  const sets = checkConstraintSets(dbSource, 'status').filter(s => s.includes('raw')); // scan_entries only
  assert.ok(sets.length >= 2, `expected multiple scan_entries status CHECK writers, found ${sets.length}`);
  const canonical = [...sets[0]].sort();
  for (const s of sets) {
    assert.deepEqual([...s].sort(), canonical, 'a status CHECK writer diverged from the others');
  }
  // The TS union in types/intake.ts must list exactly the same values
  const typesSource = read('src/types/intake.ts');
  const unionBlock = typesSource.match(/export type ScanStatus =([\s\S]*?);/);
  assert.ok(unionBlock, 'ScanStatus union not found');
  const unionValues = [...unionBlock[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(unionValues, canonical, 'ScanStatus union out of lockstep with the DB CHECK constraint');
});

test('scan_entries.scan_source: SCAN_SOURCES matches every CHECK writer', () => {
  const { SCAN_SOURCES } = require('../src/types/intake');
  const sets = checkConstraintSets(dbSource, 'scan_source');
  assert.ok(sets.length >= 1, 'no scan_source CHECK found');
  for (const s of sets) {
    assert.deepEqual([...s].sort(), [...SCAN_SOURCES].sort(), 'SCAN_SOURCES out of lockstep with a scan_source CHECK writer');
  }
});

test('schedules.schedule_type: TS unions, route validator, and parseScheduleRow agree', () => {
  const schedulerSource = read('src/services/scheduler.ts');
  const routeSource = read('src/routes/schedules.ts');

  const unionOf = (src) => {
    const m = src.match(/scheduleType\?: ([^;]+);/);
    assert.ok(m, 'scheduleType union not found');
    return [...m[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]).sort();
  };
  const dbUnion = unionOf(dbSource);
  const schedUnion = unionOf(schedulerSource);
  assert.deepEqual(schedUnion, dbUnion, 'db/index.ts and scheduler.ts ScheduleType unions diverged');

  const validator = routeSource.match(/!\[([^\]]+)\]\.includes\(scheduleType\)/);
  assert.ok(validator, 'route validator list not found');
  const routeValues = [...validator[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]).sort();
  assert.deepEqual(routeValues, dbUnion, 'routes/schedules.ts validator diverged from the ScheduleType union');

  // parseScheduleRow must have an explicit branch for every non-default type
  // (a missing branch silently coerces that type to 'scan-execution' — the
  // exact bug that would have run a source-feeds schedule as a paid scan).
  const parseFn = dbSource.match(/function parseScheduleRow[\s\S]*?return \{/);
  assert.ok(parseFn, 'parseScheduleRow not found');
  for (const t of dbUnion.filter(t => t !== 'scan-execution')) {
    assert.ok(parseFn[0].includes(`'${t}'`), `parseScheduleRow has no branch for schedule_type '${t}'`);
  }
});

test('scan_prompts.tool_type: route validators are within the final CHECK writer', () => {
  const sets = checkConstraintSets(dbSource, 'tool_type').filter(s => s.length >= 2);
  assert.ok(sets.length >= 1, 'no tool_type CHECK found');
  const finalSet = new Set(sets[sets.length - 1]); // last writer wins at boot
  const promptRoute = read('src/routes/scan-prompts.ts');
  const lists = [...promptRoute.matchAll(/\[\s*'x_search'[^\]]*\]/g)];
  assert.ok(lists.length >= 1, 'tool_type validator lists not found in scan-prompts route');
  for (const l of lists) {
    for (const v of [...l[0].matchAll(/'([a-z_]+)'/g)].map(x => x[1])) {
      assert.ok(finalSet.has(v), `route accepts tool_type '${v}' that the DB CHECK constraint rejects`);
    }
  }
});
