const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const queueTab = read('client/src/components/dashboard/QueueTab.tsx');
const actionBar = read('client/src/components/dashboard/ActionBar.tsx');
const indexPage = read('client/src/pages/Index.tsx');
const entrySheet = read('client/src/components/dashboard/EntryDetailsSheet.tsx');

test('card and desktop queue rows expose the same three labelled decisions', () => {
  for (const decision of ['WIRES_DECISION', 'PROGRAMS_DECISION', 'REJECT_DECISION']) {
    const visibleLabels = queueTab.match(new RegExp(`^\\s*\\{${decision}\\.label\\}\\s*$`, 'gm')) || [];
    assert.equal(visibleLabels.length, 2, `${decision} label should be visible once in cards and once in the desktop table`);
    const accessibleLabels = queueTab.match(new RegExp(`aria-label=\\{${decision}\\.label\\}`, 'g')) || [];
    assert.equal(accessibleLabels.length, 2, `${decision} should label both controls for assistive technology`);
  }
  const threeColumnRows = queueTab.match(/grid grid-cols-3/g) || [];
  assert.equal(threeColumnRows.length, 2, 'card and desktop rows should both use equal three-column grids');
});

test('card layout remains active until the 1080px desktop table fits', () => {
  assert.match(queueTab, /className="block xl:hidden space-y-2"/);
  assert.match(queueTab, /className="hidden xl:block glow-card overflow-x-auto overflow-y-visible"/);
  assert.match(queueTab, /className="ops-table w-full min-w-\[1080px\]"/);
  assert.doesNotMatch(queueTab, /block md:hidden space-y-2/);
  assert.doesNotMatch(queueTab, /hidden md:block glow-card/);
});

test('queue row decisions map to publish, capture, and reviewed rejection handlers', () => {
  assert.match(queueTab, /onSingleAction[^\n]+entry\.id, WIRES_DECISION\.status/);
  assert.match(queueTab, /onApproveToPrograms\(\[entry\.id\]\)/);
  assert.match(queueTab, /onSingleAction[^\n]+entry\.id, REJECT_DECISION\.status/);
  assert.doesNotMatch(queueTab, /entry\.id, 'archived'/);
});

test('bulk action bar uses the same decision model and equal geometry', () => {
  assert.match(actionBar, /grid grid-cols-3/);
  assert.match(actionBar, /onClick=\{onApproveToWires\}/);
  assert.match(actionBar, /onClick=\{onApproveToPrograms\}/);
  assert.match(actionBar, /onClick=\{onReject\}/);
  assert.match(queueTab, /onApproveToWires=\{\(\) => handleAction\(WIRES_DECISION\.status\)\}/);
  assert.match(queueTab, /onApproveToPrograms=\{\(\) => \{/);
  assert.match(queueTab, /onReject=\{\(\) => handleAction\(REJECT_DECISION\.status\)\}/);
  for (const decision of ['WIRES_DECISION', 'PROGRAMS_DECISION', 'REJECT_DECISION']) {
    assert.match(actionBar, new RegExp(`\\{${decision}\\.label\\}`));
  }
});

test('curator stays attached to entry context instead of consuming its own table column', () => {
  assert.doesNotMatch(queueTab, /<th[^>]*>Curator<\/th>/);
  assert.match(queueTab, /<td className="overflow-hidden">[\s\S]*?<CuratorBadge curator=\{entry\.metadata\?\.curator\}/);
  assert.match(queueTab, /<div className="block xl:hidden space-y-2">[\s\S]*?<CuratorBadge curator=\{entry\.metadata\?\.curator\}/);
  assert.match(queueTab, /<th[^>]*>Source<\/th>/);
  assert.match(queueTab, /colSpan=\{5\}/);
  assert.doesNotMatch(queueTab, /colSpan=\{6\}/);
});

test('page wiring names the quiet approval path for its operator-facing destination', () => {
  assert.match(indexPage, /handleApproveToPrograms/);
  assert.match(indexPage, /onApproveToPrograms=\{handleApproveToPrograms\}/);
  assert.match(indexPage, /Approved to Programs/);
});

test('queue filters are server-side and survive tab changes', () => {
  assert.match(queueTab, /Filters apply to the full queue/);
  assert.doesNotMatch(queueTab, /Filters apply to the \{entries\.length\} loaded rows/);
  assert.match(indexPage, /hidden=\{activeTab !== 'queue'\}/);
  assert.match(indexPage, /queueFiltersToApi/);
  assert.match(indexPage, /onNavigateToQueue=\{\(wire\) => \{/);
  assert.match(indexPage, /DecisionConfirmDialog/);
});

test('queue hides tweet sources by default with an obvious include-tweets chip', () => {
  assert.match(queueTab, /TWEETS HIDDEN/);
  assert.match(queueTab, /Tweets hidden from queue/);
  assert.match(queueTab, /hideTweets: !filters\.hideTweets/);
  assert.match(queueTab, /hideTweets: true/);
  const filters = read('client/src/lib/queue-filters.ts');
  assert.match(filters, /hideTweets: true/);
  assert.match(filters, /params\.get\('tweets'\) !== '1'/);
  assert.match(filters, /if \(filters\.hideTweets\) params\.hideTweets = true/);
});

test('entry details sheet can complete the same three queue decisions', () => {
  for (const decision of ['WIRES_DECISION', 'PROGRAMS_DECISION', 'REJECT_DECISION']) {
    assert.match(entrySheet, new RegExp(`aria-label=\\{${decision}\\.label\\}`));
    assert.match(entrySheet, new RegExp(`\\{${decision}\\.label\\}`));
  }
  assert.match(entrySheet, /onApproveToWires/);
  assert.match(entrySheet, /entry.status === 'queued'/);
});

test('queue exposes manual paste intake for the highest-approval channel', () => {
  assert.match(queueTab, /PasteIntakePanel/);
  assert.match(queueTab, /aria-label="Paste intake"/);
  assert.match(queueTab, /onIntakeComplete/);
  const paste = read('client/src/components/dashboard/PasteIntakePanel.tsx');
  assert.match(paste, /submitManualIntake/);
  assert.match(paste, /manual-intake/);
  assert.match(indexPage, /onIntakeComplete=\{loadData\}/);
  const api = read('client/src/api/index.ts');
  assert.match(api, /\/scan\/manual-intake/);
});

test('entry details sheet retries failed distribution sends', () => {
  assert.match(entrySheet, /redistributeEntry/);
  assert.match(entrySheet, /aria-label="Retry failed sends"/);
  assert.match(entrySheet, /RETRY FAILED SENDS/);
  assert.match(entrySheet, /failedLogs/);
  const api = read('client/src/api/index.ts');
  assert.match(api, /\/redistribute/);
});

test('approve-to-wires confirm is required before the live publish call', () => {
  assert.match(indexPage, /This publishes to Telegram immediately/);
  assert.match(indexPage, /Approve anyway/);
  assert.match(indexPage, /requestDecision\('wires'/);
});
