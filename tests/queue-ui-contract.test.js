const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const queueTab = read('client/src/components/dashboard/QueueTab.tsx');
const actionBar = read('client/src/components/dashboard/ActionBar.tsx');
const indexPage = read('client/src/pages/Index.tsx');

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
