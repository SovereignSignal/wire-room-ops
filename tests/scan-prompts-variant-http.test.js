process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:***@127.0.0.1:1/x';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app-id';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-app-secret';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const { PROMPT_VARIANTS } = require('../src/types/intake');

const originals = {
  getAllFeeds: db.getAllFeeds,
  createScanPrompt: db.createScanPrompt,
  updateScanPrompt: db.updateScanPrompt,
};

const createCalls = [];
const updateCalls = [];

db.getAllFeeds = async () => [{ key: 'ai' }];
db.createScanPrompt = async (input) => {
  createCalls.push(input);
  return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...input };
};
db.updateScanPrompt = async (id, updates) => {
  updateCalls.push({ id, updates });
  return { id, ...updates };
};

const { scanPromptRouter } = require('../src/routes/scan-prompts');

const app = express();
app.use(express.json());
app.use('/api/scan/prompts', scanPromptRouter);

const PROMPT_ID = '11111111-1111-4111-8111-111111111111';
let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  Object.assign(db, originals);
});

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function createBody(variant) {
  return {
    wire: 'ai',
    label: 'variant route test',
    promptText: 'Find current grants.',
    variant,
  };
}

const invalidVariants = ['s', ' S ', 'Z', 1, true, [], {}];

test('POST and PUT reject every noncanonical variant with 400 before persistence', async () => {
  for (const variant of invalidVariants) {
    const createCount = createCalls.length;
    const created = await request('POST', '/api/scan/prompts', createBody(variant));
    assert.equal(created.status, 400, `POST should reject ${JSON.stringify(variant)}`);
    assert.match(created.body.error, /^variant must be one of:/);
    assert.equal(createCalls.length, createCount, 'invalid POST must not call createScanPrompt');

    const updateCount = updateCalls.length;
    const updated = await request('PUT', `/api/scan/prompts/${PROMPT_ID}`, { variant });
    assert.equal(updated.status, 400, `PUT should reject ${JSON.stringify(variant)}`);
    assert.match(updated.body.error, /^variant must be one of:/);
    assert.equal(updateCalls.length, updateCount, 'invalid PUT must not call updateScanPrompt');
  }
});

test('POST and PUT accept every canonical prompt variant, including S', async () => {
  assert.deepEqual(PROMPT_VARIANTS, ['A', 'B', 'C', 'W', 'P', 'N', 'S']);

  for (const variant of PROMPT_VARIANTS) {
    const created = await request('POST', '/api/scan/prompts', createBody(variant));
    assert.equal(created.status, 200, `POST should accept ${variant}`);
    assert.equal(createCalls.at(-1).variant, variant);

    const updated = await request('PUT', `/api/scan/prompts/${PROMPT_ID}`, { variant });
    assert.equal(updated.status, 200, `PUT should accept ${variant}`);
    assert.equal(updateCalls.at(-1).updates.variant, variant);
  }
});

test('POST preserves null and empty backward compatibility by omitting variant from persistence', async () => {
  for (const variant of [null, '']) {
    const response = await request('POST', '/api/scan/prompts', createBody(variant));
    assert.equal(response.status, 200, `POST should allow ${JSON.stringify(variant)}`);
    assert.equal(createCalls.at(-1).variant, undefined);
  }
});

test('PUT clears null and empty variants by persisting null', async () => {
  for (const variant of [null, '']) {
    const response = await request('PUT', `/api/scan/prompts/${PROMPT_ID}`, { variant });
    assert.equal(response.status, 200, `PUT should allow ${JSON.stringify(variant)}`);
    assert.equal(updateCalls.at(-1).updates.variant, null);
  }
});
