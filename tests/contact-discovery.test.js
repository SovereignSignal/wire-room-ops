require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureDiscoveredContactsTable, recordDiscoveredContact, passesContactBar } = require('../src/services/contact-discovery');

function stubPool(){ const calls=[]; return { calls, query: async (sql,params)=>{calls.push({sql,params}); return {rows:[]};} }; }

test('ensureDiscoveredContactsTable creates table with unique (org_id, name_norm)', async () => {
  const pool=stubPool(); await ensureDiscoveredContactsTable(pool);
  assert.match(pool.calls[0].sql, /CREATE TABLE IF NOT EXISTS discovered_contacts/);
  assert.match(pool.calls[0].sql, /UNIQUE\s*\(\s*org_id\s*,\s*name_norm\s*\)/);
});
test('recordDiscoveredContact upserts idempotently', async () => {
  const pool=stubPool(); await recordDiscoveredContact(pool,{orgId:5,name:'Jane Doe',xHandle:'janedoe',notionPageId:'pg1'});
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO discovered_contacts/);
  assert.match(sql, /ON CONFLICT .* DO UPDATE/);
  assert.deepEqual(params, [5, 'jane doe', 'Jane Doe', 'janedoe', 'pg1']);
});
test('accepts a named person with role + handle + source', () => {
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Head of Grants', x_handle:'janedoe', profile_url:null, source:'https://org.com/team' }), true);
});
test('accepts a pseudonym/handle as the identity', () => {
  assert.equal(passesContactBar({ name:'orhun', role:'OSS maintainer (ratatui)', x_handle:'orhundev', profile_url:'https://github.com/orhun', source:'https://github.com/orhun' }), true);
});
test('accepts an independent individual with no org affiliation', () => {
  assert.equal(passesContactBar({ name:'Alex Example', role:'independent researcher / builder', x_handle:'alexexample', profile_url:null, source:'https://x.com/alexexample' }), true);
});
test('accepts profile_url with no X handle', () => {
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Founder', x_handle:null, profile_url:'https://linkedin.com/in/janedoe', source:'https://org.com' }), true);
});
test('rejects missing identity / role / source / name', () => {
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Founder', x_handle:null, profile_url:null, source:'https://o.com' }), false);
  assert.equal(passesContactBar({ name:'Jane Doe', role:'', x_handle:'j', profile_url:null, source:'https://o.com' }), false);
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Founder', x_handle:'j', profile_url:null, source:'' }), false);
  assert.equal(passesContactBar({ name:'', role:'Founder', x_handle:'j', profile_url:null, source:'https://o.com' }), false);
});
test('rejects organization / brand accounts parked as contacts', () => {
  assert.equal(passesContactBar({
    name: 'SuperDapp',
    role: 'Organization Account (Grants & Ecosystem)',
    x_handle: 'SuperDappAI',
    profile_url: 'https://x.com/SuperDappAI',
    source: 'https://superdapp.medium.com/post',
  }), false);
});
test('rejects pure bot / engagement-farm accounts (is_bot flag)', () => {
  assert.equal(passesContactBar({ name:'SashaVolkoff1', role:'crypto', x_handle:'sasha', profile_url:'https://x.com/sasha', source:'https://x.com/sasha', is_bot:true }), false);
});
