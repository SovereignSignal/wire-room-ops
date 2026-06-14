require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseContactsResponse } = require('../src/services/contact-discovery');

test('parseContactsResponse parses a valid array including is_bot flag', () => {
  const input = JSON.stringify([
    {
      name: 'Alice Grant',
      role: 'Head of Ecosystem Grants',
      x_handle: 'alicegrant',
      profile_url: 'https://github.com/alicegrant',
      source: 'https://example.org/team',
      is_bot: false,
    },
    {
      name: 'BotSpam999',
      role: 'crypto promoter',
      x_handle: 'botspam',
      profile_url: 'https://x.com/botspam',
      source: 'https://x.com/botspam',
      is_bot: true,
    },
  ]);

  const out = parseContactsResponse(input);
  assert.equal(out.length, 2);

  assert.equal(out[0].name, 'Alice Grant');
  assert.equal(out[0].role, 'Head of Ecosystem Grants');
  assert.equal(out[0].x_handle, 'alicegrant');
  assert.equal(out[0].profile_url, 'https://github.com/alicegrant');
  assert.equal(out[0].source, 'https://example.org/team');
  assert.equal(out[0].is_bot, false);

  assert.equal(out[1].name, 'BotSpam999');
  assert.equal(out[1].is_bot, true);
});

test('parseContactsResponse coerces empty strings to null', () => {
  const input = JSON.stringify([
    {
      name: 'orhun',
      role: 'OSS maintainer',
      x_handle: '',
      profile_url: 'https://github.com/orhun',
      source: 'https://github.com/orhun',
      is_bot: false,
    },
  ]);

  const out = parseContactsResponse(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].x_handle, null); // empty string → null
  assert.equal(out[0].name, 'orhun');
});

test('parseContactsResponse strips markdown fences and extracts array', () => {
  const input = '```json\n[{"name":"Vitalik Buterin","role":"protocol developer","x_handle":"VitalikButerin","profile_url":"https://vitalik.ca","source":"https://vitalik.ca","is_bot":false}]\n```';

  const out = parseContactsResponse(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Vitalik Buterin');
});

test('parseContactsResponse returns [] on non-JSON / junk', () => {
  assert.deepEqual(parseContactsResponse('not json at all'), []);
  assert.deepEqual(parseContactsResponse(''), []);
  assert.deepEqual(parseContactsResponse('{"key": "value"}'), []); // object not array
});

test('parseContactsResponse drops items with no name', () => {
  const input = JSON.stringify([
    { name: '', role: 'something', x_handle: 'h', source: 'https://x.com' },
    { name: 'Valid Person', role: 'builder', x_handle: 'vp', profile_url: 'https://github.com/vp', source: 'https://github.com/vp', is_bot: false },
  ]);

  const out = parseContactsResponse(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Valid Person');
});
