require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for the precision pass — pure functions, no DB/LLM needed.
// Covers the aggregator source blocklist (change #2) and the classifier's
// domain-scope prompt contract (changes #1 & #3). The LLM's actual in_scope
// judgment is integration-tested live, not here.

const { blockedSourceDomain, hostOf } = require('../src/services/source-filter');
const { buildClassificationPrompt } = require('../src/services/classifier');

test('blockedSourceDomain blocks known aggregators incl. subdomains', () => {
  // The exact domains that polluted the queue on 2026-06-12
  assert.equal(blockedSourceDomain('https://opportunitydesk.org/2026/06/10/embo-postdoctoral-fellowships-2026/'), 'opportunitydesk.org');
  assert.equal(blockedSourceDomain('https://opd.to/abc'), 'opd.to');
  assert.equal(blockedSourceDomain('https://afredac.net/some-fellowship'), 'afredac.net');
  assert.equal(blockedSourceDomain('https://menterprise.africa/program'), 'menterprise.africa');
  assert.equal(blockedSourceDomain('https://career.mystudypals.com/x'), 'mystudypals.com'); // subdomain → parent
  // subdomain of a blocked root
  assert.equal(blockedSourceDomain('https://www.opportunitydesk.org/x'), 'opportunitydesk.org');
  assert.equal(blockedSourceDomain('https://sub.afredac.net/x'), 'afredac.net');
});

test('blockedSourceDomain lets legitimate funder sources through', () => {
  assert.equal(blockedSourceDomain('https://nlnet.nl/commonsfund/'), null);
  assert.equal(blockedSourceDomain('https://www.sovereign.tech/programs/fund'), null);
  assert.equal(blockedSourceDomain('https://deepmind.google/blog/x'), null);
  assert.equal(blockedSourceDomain('https://esp.ethereum.foundation/'), null);
  assert.equal(blockedSourceDomain('https://os4science.org/funding_opportunity/os4ls/'), null);
  // wp.me is NOT blocked (too broad — left to the classifier's scope gate)
  assert.equal(blockedSourceDomain('https://wp.me/abc'), null);
});

test('blockedSourceDomain handles null/garbage safely', () => {
  assert.equal(blockedSourceDomain(null), null);
  assert.equal(blockedSourceDomain(undefined), null);
  assert.equal(blockedSourceDomain(''), null);
  assert.equal(blockedSourceDomain('not a url'), null);
  assert.equal(hostOf('https://www.example.com/x'), 'example.com');
});

test('classification prompt carries the domain-scope gate and in_scope/wire output', () => {
  const prompt = buildClassificationPrompt({
    name: 'EMBO Postdoctoral Fellowships 2026',
    description: 'Biology postdoc fellowship',
    source_url: 'https://opportunitydesk.org/x',
    wire: 'crypto',
  });
  // The scope gate must be present and must instruct in_scope=false for off-domain
  assert.match(prompt, /Domain Scope/i);
  assert.match(prompt, /in_scope/);
  assert.match(prompt, /off_domain/);
  // It must teach the model to correct a wrong wire, not keep it
  assert.match(prompt, /VERIFY and CORRECT/i);
  // The JSON example must include the new fields so the model returns them
  assert.match(prompt, /"in_scope":true,"wire":"oss"/);
});

test('classifier prompt carries GLM calibration guardrails + GRANT/NEWS boundary (2026-07-21 tune)', () => {
  const prompt = buildClassificationPrompt({
    name: 'Some Program',
    description: 'A program',
    source_url: 'https://example.org/grants',
    wire: 'ai',
  });
  // GRANT vs NEWS: an open application path forces GRANT even in news framing
  assert.match(prompt, /GRANT vs NEWS boundary/);
  assert.match(prompt, /applications are now open/);
  // Calibration guardrails against GLM penalty-stacking (measured: scores ran
  // ~12 pts colder than the Grok era, GRANT decided-precision 50%→40%)
  assert.match(prompt, /Do NOT stack penalties/);
  assert.match(prompt, /missing details are a source_check signal/);
  assert.match(prompt, /Organization newness alone is not a hype penalty/);
});
