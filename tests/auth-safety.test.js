require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const db = require('../src/db');
const auth = require('../src/services/auth');

// An actual process is required: an unhandled Express 4 rejection can terminate
// the server even when a unit test catches the same service exception.
test('malformed cookies and download queries cannot terminate the HTTP server', () => {
  const child = spawnSync(process.execPath, ['-e', `
    require('dotenv').config = () => ({ parsed: {} });
    process.env.DEV_MODE = 'false';
    process.env.PRIVY_APP_ID = 'test-app';
    process.env.PRIVY_APP_SECRET = 'test-secret';
    require('ts-node/register/transpile-only');
    const assert = require('node:assert/strict');
    const { app } = require('./src/server');
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        for (const value of [{ test: 1 }, ['token'], 123, true, null, 'bad-token']) {
          const headers = { Cookie: 'session=j:' + encodeURIComponent(JSON.stringify(value)) };
          for (const path of ['/api/scan/entries', '/api/dashboard/stats']) {
            const res = await fetch(base + path, { headers });
            assert.equal(res.status, 401);
            await res.text();
          }
          for (const path of ['/logout', '/file/unused']) {
            const res = await fetch(base + path, { headers, redirect: 'manual' });
            assert.equal(res.status, 302);
            await res.text();
          }
        }
        const malformedLink = await fetch(base + '/download?token[a]=x');
        assert.equal(malformedLink.status, 200);
        assert.match(await malformedLink.text(), /Invalid|expired/i);
        const health = await fetch(base + '/health');
        assert.equal(health.status, 200);
        await health.text();
        server.close();
      } catch (error) { console.error(error); process.exit(1); }
    });
  `], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test('session validation rejects malformed input before accessing storage', async (t) => {
  t.mock.method(db, 'getPool', () => { throw new Error('storage must not be used'); });
  for (const value of [undefined, null, {}, [], 42, true, '', 'x'.repeat(64), 'a'.repeat(63)]) {
    assert.equal(await auth.getSessionEmail(value), null);
    assert.equal(await auth.validateSession(value), false);
    await auth.invalidateSession(value);
  }
});

test('issued sessions still authenticate and can be revoked', async (t) => {
  t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [] }) }));
  const token = await auth.createSessionToken('test@example.invalid');
  assert.equal(await auth.getSessionEmail(token), 'test@example.invalid');
  await auth.invalidateSession(token);
  assert.equal(await auth.getSessionEmail(token), null);
  const download = auth.createDownloadToken('file-id');
  assert.equal(auth.validateMagicLink(download).fileId, 'file-id');
});

test('auth middleware forwards unexpected lookup failures to Express', async (t) => {
  process.env.DEV_MODE = 'false';
  const { requireAuth } = require('../src/middleware/auth');
  const error = new Error('injected lookup error');
  t.mock.method(auth, 'getSessionEmail', async () => { throw error; });
  let forwarded;
  await requireAuth({ cookies: {} }, {}, err => { forwarded = err; });
  assert.equal(forwarded, error);
});
