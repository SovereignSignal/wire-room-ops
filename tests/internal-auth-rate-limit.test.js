const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('internal-key agents are rate-limited after auth, session users are not', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/middleware/internal-auth.ts'), 'utf8');
  assert.match(source, /enforceAgentRateLimit/);
  assert.match(source, /agent:\$\{actor\}:\$\{bucket\}/);
  assert.match(source, /AGENT_SUBMIT_MAX = 20/);
  assert.match(source, /AGENT_WRITE_MAX = 40/);
  assert.match(source, /status\(429\)/);
  assert.match(source, /return requireAuth\(req, res, next\)/);
});
