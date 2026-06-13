require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateDigestOrgMentions } = require('../src/services/digest-orgs');

test('aggregateDigestOrgMentions counts distinct mentions and link presence', () => {
  const summaries = [
    { id: 1, wire: 'models', items: [
      { org: 'Anthropic', url: 'https://anthropic.com' },
      { org: 'Anthropic', url: null },
      { org: 'crafter-station/petdex', url: 'https://github.com/crafter-station/petdex' },
      { org: '', url: null },
    ]},
    { id: 2, wire: 'models', items: [ { org: 'Anthropic', url: null } ] },
  ];
  const agg = aggregateDigestOrgMentions(summaries);
  const anthropic = agg.get('Anthropic');
  assert.equal(anthropic.mentionCount, 3);
  assert.equal(anthropic.hasLink, true);
  assert.deepEqual(anthropic.occurrences, [
    { summaryId: 1, itemIndex: 0, wire: 'models' },
    { summaryId: 1, itemIndex: 1, wire: 'models' },
    { summaryId: 2, itemIndex: 0, wire: 'models' },
  ]);
  assert.equal(agg.get('crafter-station/petdex').mentionCount, 1);
  assert.equal(agg.has(''), false);
});
