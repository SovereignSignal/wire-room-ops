require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateCsrf } = require('../src/middleware/csrf');

const APP = 'http://localhost:5173';

function req(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/scan/entries/1/action',
    headers: {},
    ...overrides,
    headers: { ...overrides.headers },
  };
}

test('safe methods and bearer tokens skip CSRF', () => {
  assert.equal(evaluateCsrf({ method: 'GET', path: '/api/scan/queue', headers: {} }, APP), 'ok');
  assert.equal(evaluateCsrf(req({
    headers: { authorization: 'Bearer agent-key', cookie: 'session=abc' },
  }), APP), 'ok');
});

test('telegram webhook is exempt even without Origin', () => {
  assert.equal(evaluateCsrf(req({
    path: '/api/telegram/intake-webhook',
    headers: { cookie: 'session=abc' },
  }), APP), 'ok');
});

test('matching Origin or Referer is accepted', () => {
  assert.equal(evaluateCsrf(req({ headers: { origin: 'http://localhost:5173' } }), APP), 'ok');
  assert.equal(evaluateCsrf(req({ headers: { referer: 'http://localhost:5173/queue' } }), APP), 'ok');
});

test('mismatched Origin is rejected even without a session cookie', () => {
  assert.equal(evaluateCsrf(req({ headers: { origin: 'https://evil.example' } }), APP), 'mismatch');
});

test('cookie-authenticated writes require Origin or Referer', () => {
  assert.equal(evaluateCsrf(req({ headers: { cookie: 'session=abc; other=1' } }), APP), 'missing');
  assert.equal(evaluateCsrf(req({ headers: {} }), APP), 'ok');
});

test('server mounts csrfGuard before routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
  assert.match(source, /import \{ csrfGuard \} from '\.\/middleware\/csrf'/);
  assert.match(source, /app\.use\(csrfGuard\)/);
  assert.doesNotMatch(source, /No Origin or Referer: allow/);
});
