require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildForumJudgePrompt,
  parseForumJudgeResponse,
} = require('../src/services/forum');

function candidate(title, url, forumName) {
  return {
    title,
    url,
    forumName,
    createdAt: '2026-10-20T00:00:00.000Z',
    replies: 4,
    views: 20,
    source: 'allowlist',
  };
}

const GOVERNANCE = candidate(
  'AIP: Transfer 500 ETH from the Arbitrum treasury',
  'https://forum.arbitrum.foundation/t/treasury-transfer/900',
  'Arbitrum',
);
const OPEN_GRANT = candidate(
  'Builder Grants RFP — applications are open',
  'https://forum.celo.org/t/builder-grants-rfp/410',
  'Celo',
);

test('forum judge prompt passes only open funding calls and names both threads', () => {
  const prompt = buildForumJudgePrompt([GOVERNANCE, OPEN_GRANT], 'crypto');

  assert.match(prompt, /open funding calls only/);
  assert.match(prompt, /grants, RFPs, and calls for proposals that are open to apply/);
  assert.match(prompt, /bounties that are open to apply/);
  assert.match(prompt, /hackathons with prizes that are open to apply/);
  assert.match(prompt, /governance proposals, votes, and delegate elections/);
  assert.match(prompt, /treasury transfers and budget allocations/);
  assert.match(prompt, /status updates, award announcements, retros, and round results/);
  assert.match(prompt, /When unsure, set is_opportunity=false/);
  assert.match(prompt, /1\. \[Arbitrum\] AIP: Transfer 500 ETH from the Arbitrum treasury/);
  assert.match(prompt, /2\. \[Celo\] Builder Grants RFP — applications are open/);
  assert.doesNotMatch(prompt, /areas 1–6/);
  assert.doesNotMatch(prompt, /lean is_opportunity=true/);
  assert.doesNotMatch(prompt, /signal_stage":"proposed\|open\|awarded\|voting\|recurring"/);
});

test('forum judge keeps an open grant call and drops a governance post', () => {
  const content = JSON.stringify([
    {
      n: 1,
      is_opportunity: true,
      name: 'Arbitrum treasury transfer',
      funder: 'Arbitrum',
      amount: '500 ETH',
      deadline: null,
      signal_stage: 'voting',
      summary: 'A proposal to transfer 500 ETH from the treasury is up for a vote.',
    },
    {
      n: 2,
      is_opportunity: true,
      name: 'Celo Builder Grants RFP',
      funder: 'Celo',
      amount: '$50,000',
      deadline: '2026-11-15',
      signal_stage: 'open',
      summary: 'Celo is accepting applications to the Builder Grants RFP.',
    },
  ]);

  const out = parseForumJudgeResponse(content, [GOVERNANCE, OPEN_GRANT]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Celo Builder Grants RFP');
  assert.equal(out[0].sourceUrl, OPEN_GRANT.url);
  assert.match(out[0].description, /Signal: open/);
  assert.equal(out[0].amount, '$50,000');
});

test('forum judge drops governance and status posts the model did not mark open', () => {
  const status = candidate(
    'Kusama OpenGov status update',
    'https://forum.kusama.network/t/status/12',
    'Kusama',
  );
  const content = JSON.stringify([
    { n: 1, is_opportunity: false, signal_stage: 'proposed', name: 'Arbitrum treasury transfer', summary: 'Treasury vote.' },
    { n: 2, is_opportunity: true, signal_stage: 'awarded', name: 'Kusama status update', summary: 'A status update on the last referendum.' },
    { n: 3, is_opportunity: true, name: 'Celo Builder Grants RFP', signal_stage: 'open', summary: 'Applications are open.' },
  ]);

  const out = parseForumJudgeResponse(content, [GOVERNANCE, status, OPEN_GRANT]);
  assert.deepEqual(out.map(row => row.sourceUrl), [OPEN_GRANT.url]);
});

test('keyword fallback keeps an open grant call and skips a governance post', () => {
  const governance = candidate(
    'Transfer 500 ETH from the Arbitrum treasury',
    'https://forum.arbitrum.foundation/t/treasury-transfer/901',
    'Arbitrum',
  );
  const out = parseForumJudgeResponse('not json', [governance, OPEN_GRANT]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, OPEN_GRANT.title);
  assert.equal(out[0].sourceUrl, OPEN_GRANT.url);
});
