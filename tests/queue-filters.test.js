const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const helperPath = path.resolve(__dirname, '../client/src/lib/queue-filters.ts');
const compiled = ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const helperModule = new Module(helperPath, module);
helperModule.filename = helperPath;
helperModule.paths = Module._nodeModulePaths(path.dirname(helperPath));
helperModule._compile(compiled, helperPath);
const {
  emptyQueueFilters,
  parseQueueSearch,
  serializeQueueSearch,
  queueFiltersToApi,
  queueFiltersActive,
  queueFiltersEqual,
} = helperModule.exports;

test('queue search params round-trip and ignore unknown values', () => {
  const parsed = parseQueueSearch('?wire=crypto&classification=GRANT&route=source_check&score=unscored&timeline=upcoming&entry=42&junk=1');
  assert.deepEqual(parsed, {
    wire: 'crypto',
    classification: 'GRANT',
    route: 'source_check',
    scoreBand: 'unscored',
    timeline: 'upcoming',
    entryId: '42',
  });
  assert.equal(
    serializeQueueSearch(parsed),
    '?wire=crypto&classification=GRANT&route=source_check&score=unscored&timeline=upcoming&entry=42',
  );
  assert.equal(parseQueueSearch('?wire=unknown&score=loud').wire, null);
  assert.equal(parseQueueSearch('?score=loud').scoreBand, null);
});

test('score bands map to server query params and leave unscored entries out of numeric bands', () => {
  assert.deepEqual(queueFiltersToApi({ ...emptyQueueFilters(), scoreBand: 'strong' }), { minScore: 70 });
  assert.deepEqual(queueFiltersToApi({ ...emptyQueueFilters(), scoreBand: 'medium' }), { minScore: 50, maxScore: 69 });
  assert.deepEqual(queueFiltersToApi({ ...emptyQueueFilters(), scoreBand: 'weak' }), { minScore: 0, maxScore: 49 });
  assert.deepEqual(queueFiltersToApi({ ...emptyQueueFilters(), scoreBand: 'unscored' }), { unscored: true });
});

test('queue filter activity and equality ignore only matching snapshots', () => {
  const empty = emptyQueueFilters();
  const wired = { ...empty, wire: 'ai' };
  assert.equal(queueFiltersActive(empty), false);
  assert.equal(queueFiltersActive(wired), true);
  assert.equal(queueFiltersEqual(wired, { ...wired }), true);
  assert.equal(queueFiltersEqual(wired, { ...wired, route: 'publish' }), false);
});
