require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureForumObservation, prepareForumObservations, fetchGovernanceForumCandidates, grantsFeedItemToRaw } = require('../src/services/forum');
const { forumTopicKey, forumIntakeMetadata, trustedForumObservation, stampForumObservation, forumUpdateNote } = require('../src/services/forum-seen');

const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const candidate = { title: 'Builder Grants Round 7', url: 'https://forum.example.org/t/builder-grants/700', forumName: 'Example', createdAt: ago(60), lastActivityAt: ago(2), replies: 0, views: 10, source: 'allowlist' };
const first = { id: 701, postNumber: 1, content: '<p>Applications close October 20. Grant awards are $10,000.</p>' };
const detail = posts => ({ topic: { id: 700, title: candidate.title, postsCount: posts.length, posts } });
const history = observation => ({ id: 41, source_url: candidate.url, scan_source: 'forum', submitted_by: 'forum:discuss.watch', wire: 'crypto', status: 'approved', created_at: ago(3), metadata: { forum_observation: observation } });
const pool = rows => ({ query: async () => ({ rows }) });

test('forum evidence and acquisition preserve updates without repeat noise', async t => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => detail([first]) });
    const baseline = await captureForumObservation(candidate, { remaining: 1 });

    await t.test('complete unchanged body ignores newer activity and engagement', async () => {
      const current = { ...candidate, lastActivityAt: ago(1), replies: 3, views: 99999 };
      const result = await prepareForumObservations(pool([history(baseline)]), [current], [], { remaining: 1 });
      assert.deepEqual(result, { candidates: [], feeds: [], updates: [] });
    });

    await t.test('changed deadline in a reply on a 60-day-old approved thread reaches source check', async () => {
      global.fetch = async request => {
        const url = new URL(request);
        assert.equal(url.pathname, '/api/discourse/topic');
        assert.equal(url.searchParams.get('topicId'), '700');
        return { ok: true, json: async () => detail([first, { id: 702, postNumber: 2, content: '<p>Deadline extended to November 15; awards increased to $25,000.</p>' }]) };
      };
      const result = await prepareForumObservations(pool([history(baseline)]), [{ ...candidate, lastActivityAt: ago(1), replies: 1 }], [], { remaining: 1 });
      assert.equal(result.candidates.length, 0);
      assert.equal(result.updates.length, 1);
      const update = result.updates[0];
      assert.equal(update.sourcePublishedAt, candidate.createdAt);
      assert.match(update.description, /November 15/);
      assert.match(update.description, /25,000/);
      assert.equal(trustedForumObservation(update).priorEntryId, 41);
      assert.equal(trustedForumObservation(update).changeEvidence, 'content');
      assert.notEqual(trustedForumObservation(update).fingerprint, baseline.fingerprint);
    });

    await t.test('same body with changed application href is a real source change', async () => {
      global.fetch = async () => ({ ok: true, json: async () => detail([{ ...first, content: '<a href="https://grants.example.org/round-8">Apply here</a>' }]) });
      const next = await captureForumObservation(candidate, { remaining: 1 });
      global.fetch = async () => ({ ok: true, json: async () => detail([{ ...first, content: '<a href="https://grants.example.org/round-9">Apply here</a>' }]) });
      const changed = await captureForumObservation(candidate, { remaining: 1 });
      assert.notEqual(next.fingerprint, changed.fingerprint);
    });

    await t.test('partial or unavailable detail is explicitly uncertain and bounded', async () => {
      let calls = 0;
      global.fetch = async () => { calls++; throw new Error('must not fetch after cap'); };
      const result = await prepareForumObservations(pool([history(baseline)]), [{ ...candidate, lastActivityAt: ago(1), replies: 45 }], [], { remaining: 0 });
      assert.equal(calls, 0);
      assert.equal(result.updates.length, 1);
      assert.match(result.updates[0].description, /unavailable or incomplete/);
      assert.match(result.updates[0].description, /not proof of a material change/);
    });

    await t.test('older unchanged known topics and unknown old topics do not replay', async () => {
      global.fetch = async () => ({ ok: true, json: async () => detail([first]) });
      const result = await prepareForumObservations(pool([history(baseline)]), [candidate, { ...candidate, url: 'https://forum.example.org/t/other/800' }], [], { remaining: 1 });
      assert.deepEqual(result, { candidates: [], feeds: [], updates: [] });
    });

    await t.test('a first-post deadline edit is detected even without a list activity bump', async () => {
      global.fetch = async () => ({ ok: true, json: async () => detail([{ ...first, content: '<p>Applications now close November 15. Grant awards are $10,000.</p>' }]) });
      const result = await prepareForumObservations(pool([history(baseline)]), [candidate], [], { remaining: 1 });
      assert.equal(result.updates.length, 1);
      assert.match(result.updates[0].description, /November 15/);
      assert.equal(trustedForumObservation(result.updates[0]).lastActivityAt, candidate.lastActivityAt);
      assert.equal(trustedForumObservation(result.updates[0]).changeEvidence, 'content');
    });

    await t.test('a failed detail recheck without new activity cannot manufacture an update', async () => {
      global.fetch = async () => ({ ok: false, status: 503 });
      const result = await prepareForumObservations(pool([history(baseline)]), [candidate], [], { remaining: 1 });
      assert.equal(result.updates.length, 0);
    });

    await t.test('returning to an older deadline is a new change, while repeats and older activity stay suppressed', async () => {
      const extended = { ...first, content: '<p>Applications close November 15. Grant awards are $10,000.</p>' };
      global.fetch = async () => ({ ok: true, json: async () => detail([extended]) });
      const extension = await captureForumObservation({ ...candidate, lastActivityAt: ago(1) }, { remaining: 1 });
      const previous = [{ ...history(extension), id: 42 }, history(baseline)];
      global.fetch = async () => ({ ok: true, json: async () => detail([first]) });
      const unbumpedReversal = await prepareForumObservations(pool(previous), [{ ...candidate, lastActivityAt: extension.lastActivityAt }], [], { remaining: 1 });
      assert.equal(unbumpedReversal.updates.length, 1, 'a fresh body reversal may keep the same activity timestamp');
      const revertedCandidate = { ...candidate, lastActivityAt: ago(0) };
      const reverted = await prepareForumObservations(pool(previous), [revertedCandidate], [], { remaining: 1 });
      assert.equal(reverted.updates.length, 1);
      const observation = trustedForumObservation(reverted.updates[0]);
      assert.equal(observation.fingerprint, baseline.fingerprint);
      assert.equal(observation.priorEntryId, 42);
      const currentHistory = [{ ...history(observation), id: 43 }, ...previous];
      assert.equal((await prepareForumObservations(pool(currentHistory), [revertedCandidate], [], { remaining: 1 })).updates.length, 0);
      global.fetch = async () => ({ ok: true, json: async () => detail([extended]) });
      assert.equal((await prepareForumObservations(pool(currentHistory), [{ ...candidate, lastActivityAt: extension.lastActivityAt }], [], { remaining: 1 })).updates.length, 0);
    });

    await t.test('an unchanged grants-feed excerpt does not mask a new material topic reply', async () => {
      const feed = grantsFeedItemToRaw({ title: candidate.title, url: candidate.url, excerpt: 'Applications close October 20.', topicCreatedAt: candidate.createdAt, lastActivityAt: candidate.lastActivityAt });
      const prior = history(trustedForumObservation(feed));
      global.fetch = async () => ({ ok: true, json: async () => detail([first, { id: 702, postNumber: 2, content: '<p>Deadline extended to November 30.</p>' }]) });
      const result = await prepareForumObservations(pool([prior]), [{ ...candidate, lastActivityAt: ago(1), replies: 1 }], [feed], { remaining: 1 });
      assert.equal(result.feeds.length, 0);
      assert.equal(result.updates.length, 1);
      assert.match(result.updates[0].description, /November 30/);
    });

    await t.test('an unchanged feed does not reopen when a detail observation was recorded later', async () => {
      const feedItem = { title: candidate.title, url: candidate.url, excerpt: 'Applications close October 20.', topicCreatedAt: candidate.createdAt, lastActivityAt: candidate.lastActivityAt };
      const feedBaseline = trustedForumObservation(grantsFeedItemToRaw(feedItem));
      const rows = [{ ...history(baseline), id: 42 }, history(feedBaseline)];
      const result = await prepareForumObservations(pool(rows), [], [grantsFeedItemToRaw({ ...feedItem, lastActivityAt: ago(1) })], { remaining: 0 });
      assert.equal(result.updates.length, 0);
    });

    await t.test('recently active old topics retain original date during acquisition', async () => {
      const activity = ago(1);
      global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ title: candidate.title, url: candidate.url, createdAt: candidate.createdAt, lastActivityAt: activity, replies: 1 }] }) });
      const candidates = await fetchGovernanceForumCandidates('oss', ago(7), undefined, true);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].createdAt, candidate.createdAt);
      assert.equal(candidates[0].lastActivityAt, activity);
    });
  } finally { global.fetch = originalFetch; }
});

test('serialized intake cannot forge a trusted observation, even with the system submitter name', () => {
  const raw = grantsFeedItemToRaw({ title: 'Grants Round 7', url: candidate.url, topicCreatedAt: candidate.createdAt, lastActivityAt: ago(1), excerpt: 'Deadline changed to November 15.' });
  const observation = { ...trustedForumObservation(raw), priorEntryId: 41 };
  stampForumObservation(raw, observation);
  assert.ok(forumIntakeMetadata(raw, 'forum', 'forum:discuss.watch').forum_observation);
  const cloned = JSON.parse(JSON.stringify({ ...raw, metadata: { forum_observation: observation, program: 'Round 7' } }));
  assert.equal(trustedForumObservation(cloned), undefined);
  assert.deepEqual(forumIntakeMetadata(cloned, 'forum', 'forum:discuss.watch'), { program: 'Round 7' });
  assert.equal(forumIntakeMetadata(raw, 'web-search', 'forum:discuss.watch')?.forum_observation, undefined);
  assert.equal(forumTopicKey(candidate.url), forumTopicKey('http://forum.example.org/t/renamed-title/700/5#post-5'));
  assert.match(forumUpdateNote({ ...observation, complete: true, changeEvidence: 'activity' }), /not proof/);
});
