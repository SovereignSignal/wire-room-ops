const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// The client package is ESM while the root test harness is CommonJS. Compile
// this dependency-free helper in memory so the test remains compatible with
// every Node version supported by the root package.
const helperPath = path.resolve(__dirname, '../client/src/lib/dashboard-state.ts');
const compiled = ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const helperModule = new Module(helperPath, module);
helperModule.filename = helperPath;
helperModule.paths = Module._nodeModulePaths(path.dirname(helperPath));
helperModule._compile(compiled, helperPath);
const {
  deriveDashboardHealth,
  dashboardPathForTab,
  dashboardTabFromPath,
  effectiveOperatorRoute,
  isInScoreBand,
  normalizeQualityScore,
  visibleSelection,
} = helperModule.exports;

test('quality scores preserve unscored state and exclude it from numeric bands', () => {
  assert.equal(normalizeQualityScore(null), null);
  assert.equal(normalizeQualityScore(''), null);
  assert.equal(normalizeQualityScore('72'), 72);
  assert.equal(normalizeQualityScore('not-a-score'), null);
  assert.equal(isInScoreBand(null, 0, 39), false);
  assert.equal(isInScoreBand(null, null, null), true);
});

test('bulk selection is restricted to rows still visible', () => {
  const selected = new Set(['1', '2', '3']);
  const visible = new Set(['2', '4']);
  assert.deepEqual([...visibleSelection(selected, visible)], ['2']);
});

test('curator route has precedence over classifier route', () => {
  assert.equal(effectiveOperatorRoute({
    curator: { route: 'relationship_signal' },
    operator_route: 'decline',
  }), 'relationship_signal');
  assert.equal(effectiveOperatorRoute({ operator_route: 'source_check' }), 'source_check');
});

test('dashboard health reports partial failures as degraded', () => {
  assert.equal(deriveDashboardHealth([
    { status: 'fulfilled', value: {} },
    { status: 'rejected', reason: new Error('down') },
  ]), 'degraded');
  assert.equal(deriveDashboardHealth([
    { status: 'rejected', reason: new Error('down') },
  ]), 'offline');
});

test('dashboard tab paths round trip and unknown paths fall back safely', () => {
  assert.equal(dashboardTabFromPath('/queue'), 'queue');
  assert.equal(dashboardTabFromPath('/grants-intel/'), 'grants-intel');
  assert.equal(dashboardTabFromPath('/unknown'), 'overview');
  assert.equal(dashboardPathForTab('settings'), '/settings');
  assert.equal(dashboardPathForTab('unknown'), '/overview');
});
