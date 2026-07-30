const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../client/src/components/dashboard/queue-decisions.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const decisionModule = { exports: {} };
new Function('exports', 'module', 'require', compiled)(decisionModule.exports, decisionModule, require);

const {
  QUEUE_DECISIONS,
  QUEUE_DECISION_BUTTON_BASE,
  QUEUE_DECISION_TONE_CLASSES,
} = decisionModule.exports;

test('queue decisions expose the three operator outcomes in display order', () => {
  assert.deepEqual(
    QUEUE_DECISIONS.map(({ key, label, status, quiet, tone }) => ({ key, label, status, quiet, tone })),
    [
      { key: 'wires', label: 'Approve to Wires', status: 'approved', quiet: false, tone: 'success' },
      { key: 'programs', label: 'Approve to Programs', status: 'approved', quiet: true, tone: 'warning' },
      { key: 'reject', label: 'Reject', status: 'declined', quiet: false, tone: 'danger' },
    ],
  );
});

test('queue decision controls share equal-size wrapping geometry', () => {
  assert.match(QUEUE_DECISION_BUTTON_BASE, /\bw-full\b/);
  assert.match(QUEUE_DECISION_BUTTON_BASE, /\bh-full\b/);
  assert.match(QUEUE_DECISION_BUTTON_BASE, /\bmin-h-12\b/);
  assert.match(QUEUE_DECISION_BUTTON_BASE, /\bwhitespace-normal\b/);
});

test('queue decision tones are green, yellow, and red status colors', () => {
  assert.match(QUEUE_DECISION_TONE_CLASSES.success, /status-success/g);
  assert.match(QUEUE_DECISION_TONE_CLASSES.warning, /status-warning/g);
  assert.match(QUEUE_DECISION_TONE_CLASSES.danger, /status-danger/g);
});
