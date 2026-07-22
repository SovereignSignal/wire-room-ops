require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnrichmentResponse } = require('../src/services/org-enricher');

test('parses full enrichment fields and clamps invalids', () => {
  const raw = JSON.stringify([{
    id: 5, org_type: 'Web2', source_type: 'Foundation', website: 'https://anthropic.com',
    twitter: 'https://x.com/anthropicai', github_url: 'https://github.com/anthropics',
    description: 'AI safety lab.', tags: ['ai','safety','llm'], last_signal: 'Released Fable 5.',
    source: 'https://anthropic.com/about',
  }, {
    id: 6, website: 'notaurl', twitter: null, tags: 'notarray', github_url: 'ftp://x',
  }]);
  const out = parseEnrichmentResponse(raw);
  assert.equal(out[0].github_url, 'https://github.com/anthropics');
  assert.deepEqual(out[0].tags, ['ai','safety','llm']);
  assert.equal(out[0].source, 'https://anthropic.com/about');
  assert.equal(out[1].website, null);      // invalid url -> null
  assert.equal(out[1].github_url, null);    // non-http -> null
  assert.deepEqual(out[1].tags, []);        // non-array -> []
});

test('parseEnrichmentResponse rejects non-JSON, junk, and empty arrays', () => {
  assert.throws(() => parseEnrichmentResponse('not json'), /JSON array/);
  assert.throws(() => parseEnrichmentResponse('[]'), /empty/);
});

test('tags are capped at 5', () => {
  const raw = JSON.stringify([{ id: 1, tags: ['a','b','c','d','e','f','g'] }]);
  assert.equal(parseEnrichmentResponse(raw)[0].tags.length, 5);
});

test('accepts numeric-string IDs and rejects unsafe, duplicate, or out-of-batch IDs', () => {
  const out = parseEnrichmentResponse(JSON.stringify([{ id: '9', website:'https://x.io' }]), new Set([9]));
  assert.equal(out[0].id, 9);

  assert.throws(
    () => parseEnrichmentResponse(JSON.stringify([{ org_type:'Web2' }, { id: 9 }])),
    /invalid org id/,
  );
  assert.throws(
    () => parseEnrichmentResponse(JSON.stringify([{ id: 9 }, { id: '9' }])),
    /duplicate org id 9/,
  );
  assert.throws(
    () => parseEnrichmentResponse(JSON.stringify([{ id: 10 }]), new Set([9])),
    /outside the submitted batch/,
  );
});

test('parseEnrichmentResponse carries operator_read and tolerates its absence', () => {
  const { parseEnrichmentResponse } = require('../src/services/org-enricher');
  const withRead = parseEnrichmentResponse(JSON.stringify([{ id: 1, operator_read: 'scaling a new fund with a 2-person team', description: 'x', tags: [] }]));
  assert.equal(withRead[0].operator_read, 'scaling a new fund with a 2-person team');
  const without = parseEnrichmentResponse(JSON.stringify([{ id: 2, description: 'y', tags: [] }]));
  assert.equal(without[0].operator_read, null);
});
