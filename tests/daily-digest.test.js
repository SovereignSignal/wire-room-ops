require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getTopPendingFinds } = require('../src/jobs/daily-digest');

test('getTopPendingFinds returns fresh queued items ordered by curator signal first', async () => {
  let captured = null;
  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          captured = { sql, params };
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  await getTopPendingFinds(pool, 7);

  assert.ok(captured, 'query was not called');
  assert.match(captured.sql, /status = 'queued'/);
  assert.match(captured.sql, /created_at >= NOW\(\) - INTERVAL '24 hours'/);
  assert.match(captured.sql, /deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE/);
  assert.match(captured.sql, /metadata->'curator'->>'route'/);
  assert.match(captured.sql, /metadata->'curator'->>'confidence'/);
  assert.match(captured.sql, /quality_score DESC NULLS LAST/);
  assert.deepEqual(captured.params, [7]);
});
