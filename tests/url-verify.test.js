require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyUrl, findDeadUrlFields } = require('../src/services/url-verify');

const mk = (status) => async () => ({ status });

test('2xx/3xx -> ok', async () => {
  assert.equal(await verifyUrl('https://x.io', mk(200)), 'ok');
  assert.equal(await verifyUrl('https://x.io', mk(301)), 'ok');
});
test('404/410 -> notfound', async () => {
  assert.equal(await verifyUrl('https://x.io', mk(404)), 'notfound');
  assert.equal(await verifyUrl('https://x.io', mk(410)), 'notfound');
});
test('403/429/5xx -> inconclusive (not penalized)', async () => {
  assert.equal(await verifyUrl('https://x.io', mk(403)), 'inconclusive');
  assert.equal(await verifyUrl('https://x.io', mk(429)), 'inconclusive');
  assert.equal(await verifyUrl('https://x.io', mk(503)), 'inconclusive');
});
test('non-http / empty -> inconclusive', async () => {
  assert.equal(await verifyUrl('', mk(200)), 'inconclusive');
  assert.equal(await verifyUrl('ftp://x', mk(200)), 'inconclusive');
});
test('network throw -> inconclusive', async () => {
  assert.equal(await verifyUrl('https://x.io', async () => { throw new Error('net'); }), 'inconclusive');
});
test('findDeadUrlFields flags only definitively-notfound fields', async () => {
  const verdicts = { 'https://live.io':'ok', 'https://dead.io':'notfound', 'https://blocked.io':'inconclusive' };
  const fake = async (u) => verdicts[u];
  const dead = await findDeadUrlFields({ website:'https://live.io', github_url:'https://dead.io', twitter:'https://blocked.io' }, fake);
  assert.deepEqual(dead, ['github_url']);
});
