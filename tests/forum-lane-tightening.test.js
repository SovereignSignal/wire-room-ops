require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');

const { captureForumObservation, prepareForumObservations, grantsFeedItemToRaw } = require('../src/services/forum');
const { forumPriorReviewable, forumPostChanged, trustedForumObservation } = require('../src/services/forum-seen');

const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const candidate = { title: 'Delegate Incentive Program October', url: 'https://forum.example.org/t/dip-october/900', forumName: 'Example', createdAt: ago(40), lastActivityAt: ago(3), replies: 0, views: 10, source: 'allowlist' };
const opening = { id: 901, postNumber: 1, content: '<p>Delegates are paid monthly from the incentive budget.</p>' };
const reply = { id: 902, postNumber: 2, content: '<p>When will September payouts arrive?</p>' };
const detail = posts => ({ topic: { id: 900, title: candidate.title, postsCount: posts.length, posts } });
const row = (observation, status, id = 51) => ({
  id, source_url: candidate.url, scan_source: 'forum', submitted_by: 'forum:discuss.watch', wire: 'crypto', status, created_at: ago(3),
  metadata: observation ? { forum_observation: observation } : {},
});
const pool = rows => ({ query: async () => ({ rows }) });
const withReply = { ...candidate, lastActivityAt: ago(1), replies: 1 };

test('a changed topic returns to review only when wanted or when the post itself changed', async t => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => detail([opening]) });
    const baseline = await captureForumObservation(candidate, { remaining: 1 });
    assert.match(baseline.postFingerprint, /^[a-f0-9]{64}$/);

    await t.test('a new reply on a declined thread is dropped', async () => {
      global.fetch = async () => ({ ok: true, json: async () => detail([opening, reply]) });
      const result = await prepareForumObservations(pool([row(baseline, 'declined')]), [withReply], [], { remaining: 1 });
      assert.deepEqual(result, { candidates: [], feeds: [], updates: [] });
    });

    await t.test('the same reply on a queued or approved thread still reaches source check', async () => {
      global.fetch = async () => ({ ok: true, json: async () => detail([opening, reply]) });
      for (const status of ['queued', 'approved']) {
        const result = await prepareForumObservations(pool([row(baseline, status)]), [withReply], [], { remaining: 1 });
        assert.equal(result.updates.length, 1, status);
        assert.equal(trustedForumObservation(result.updates[0]).priorEntryId, 51);
      }
    });

    await t.test('an edited opening post reopens a declined or archived thread', async () => {
      const edited = { ...opening, content: '<p>Round 2 grants are open: apply by November 30 for up to $20,000.</p>' };
      global.fetch = async () => ({ ok: true, json: async () => detail([edited, reply]) });
      for (const status of ['declined', 'archived']) {
        const result = await prepareForumObservations(pool([row(baseline, status)]), [withReply], [], { remaining: 1 });
        assert.equal(result.updates.length, 1, status);
        assert.match(result.updates[0].description, /November 30/);
      }
    });

    await t.test('an older snapshot with no opening-post baseline spends no detail read on a declined thread', async () => {
      const legacy = { ...baseline };
      delete legacy.postFingerprint;
      let calls = 0;
      global.fetch = async () => { calls++; return { ok: true, json: async () => detail([opening, reply]) }; };
      const budget = { remaining: 1 };
      for (const prior of [row(legacy, 'declined'), row(null, 'declined')]) {
        const result = await prepareForumObservations(pool([prior]), [withReply], [], budget);
        assert.equal(result.updates.length, 0);
      }
      assert.equal(calls, 0);
      assert.equal(budget.remaining, 1);
    });

    await t.test('the newest decision wins and duplicate rows carry no decision', () => {
      assert.equal(forumPriorReviewable([row(baseline, 'approved', 50), row(baseline, 'declined', 52)]), false);
      assert.equal(forumPriorReviewable([row(baseline, 'declined', 50), row(baseline, 'queued', 52)]), true);
      assert.equal(forumPriorReviewable([row(baseline, 'approved', 50), row(baseline, 'duplicate', 52)]), true);
      assert.equal(forumPriorReviewable([row(baseline, 'deduped', 52)]), false);
      assert.equal(forumPriorReviewable([]), false);
    });
  } finally { global.fetch = originalFetch; }
});

test('grants-feed updates follow the same rule', async t => {
  const item = { title: 'Builder Grants Round 7', url: candidate.url, excerpt: 'Applications close October 20.', status: 'open', topicCreatedAt: ago(40), lastActivityAt: ago(3) };
  const feedBaseline = trustedForumObservation(grantsFeedItemToRaw(item));

  await t.test('changed post fields reopen a declined topic', async () => {
    const next = grantsFeedItemToRaw({ ...item, excerpt: 'Deadline extended to November 15.', lastActivityAt: ago(1) });
    assert.equal(forumPostChanged(trustedForumObservation(next), [row(feedBaseline, 'declined')]), true);
    const result = await prepareForumObservations(pool([row(feedBaseline, 'declined')]), [], [next], { remaining: 0 });
    assert.equal(result.updates.length, 1);
  });

  await t.test('a first feed sighting of a declined topic is not a post change', async () => {
    const next = grantsFeedItemToRaw({ ...item, lastActivityAt: ago(1) });
    for (const prior of [row(null, 'declined'), row({ ...feedBaseline, evidence: 'activity_only', fingerprint: 'a'.repeat(64) }, 'declined')]) {
      const result = await prepareForumObservations(pool([prior]), [], [next], { remaining: 0 });
      assert.equal(result.updates.length, 0);
    }
    const wanted = await prepareForumObservations(pool([row(null, 'approved')]), [], [next], { remaining: 0 });
    assert.equal(wanted.updates.length, 1);
  });
});
