require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseExportPage, pageToSurfaces } = require('../src/scripts/import-watch-surfaces-export');

const SAMPLE = `# 1inch Network

Type: Protocol DAO
Tags: Builder Program, Crypto / Web3, Public Goods Funder
Status: Active
Tier: Tier 3 - Monitor
Action(s): Created via Daily Crypto Grant Wire 2026-05-28 after a proposal surfaced on http://gov.1inch.network during the governance-vote scan.
Website: https://1inch.io/
Twitter: https://x.com/1inch
Created by: Operator
Forum URL: https://gov.1inch.network/
Grants Program URL: https://1inch.network/foundation
Last Checked: May 29, 2026
Source Type: Forum, Governance Portal, Website, X Account
Wire: Crypto
`;

test('parseExportPage reads title and key:value fields', () => {
  const { name, fields } = parseExportPage(SAMPLE);
  assert.equal(name, '1inch Network');
  assert.equal(fields['Tier'], 'Tier 3 - Monitor');
  assert.equal(fields['Grants Program URL'], 'https://1inch.network/foundation');
});

test('pageToSurfaces emits one row per mapped URL field with wire/tier', () => {
  const rows = pageToSurfaces(SAMPLE);
  const types = rows.map(r => r.surface_type).sort();
  assert.deepEqual(types, ['forum', 'grants_page', 'website', 'x_account']);
  const forum = rows.find(r => r.surface_type === 'forum');
  assert.equal(forum.org_name, '1inch Network');
  assert.equal(forum.wire, 'crypto');
  assert.equal(forum.tier, 'Tier 3 - Monitor');
  assert.equal(forum.source_of_truth, 'notion-export');
});

test('pageToSurfaces skips non-http values and pages without a title', () => {
  assert.deepEqual(pageToSurfaces('no title here'), []);
  const rows = pageToSurfaces('# X\n\nWebsite: not-a-url\n');
  assert.deepEqual(rows, []);
});
