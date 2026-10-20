process.env.DEV_MODE = 'true';
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const {
  funderNameKeys, horizonTopicId, normalizeFunderName, repeatFunderLift, repeatFunderWindowDays,
  repeatFunderPayload, RepeatFunderHoldError, sameRepeatFunder,
} = require('../src/services/repeat-funder');

test('funder names collapse case and punctuation', () => {
  assert.equal(normalizeFunderName('  Btrust — Builder '), 'btrust builder');
});

test('Btrust Starter Grants shares a funder key with Btrust posts and tags', () => {
  const starter = funderNameKeys('Btrust Starter Grants', ['Btrust']);
  const builder = funderNameKeys('Btrust — Builder Grants', []);
  const education = funderNameKeys('Btrust: Education Grants', ['Btrust']);
  const other = funderNameKeys('Other Foundation Starter Grants', ['Other Foundation']);
  assert.ok(starter.includes('btrust'));
  assert.ok(builder.includes('btrust'));
  assert.ok(education.includes('btrust'));
  assert.equal(other.includes('btrust'), false);
  assert.equal(funderNameKeys('Crypto A', []).includes('crypto'), false);
  assert.equal(funderNameKeys('Crypto B', []).includes('crypto'), false);
});

test('the repeat window defaults to 30 days', () => {
  const previous = process.env.REPEAT_FUNDER_WINDOW_DAYS;
  delete process.env.REPEAT_FUNDER_WINDOW_DAYS;
  try {
    assert.equal(repeatFunderWindowDays(), 30);
    process.env.REPEAT_FUNDER_WINDOW_DAYS = '14';
    assert.equal(repeatFunderWindowDays(), 14);
    process.env.REPEAT_FUNDER_WINDOW_DAYS = 'nope';
    assert.equal(repeatFunderWindowDays(), 30);
  } finally {
    if (previous === undefined) delete process.env.REPEAT_FUNDER_WINDOW_DAYS;
    else process.env.REPEAT_FUNDER_WINDOW_DAYS = previous;
  }
});

test('each Horizon topic ID is its own funder', () => {
  const raise = {
    name: 'European Commission — HORIZON-RAISE-2026-01-01',
    description: 'Sent topic',
    orgId: 7,
    programId: 11,
    tags: ['European Commission'],
  };
  const bridging = {
    name: 'European Commission — HORIZON-BRIDGING-2027-01-13',
    sourceUrl: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/horizon-bridging-2027-01-13',
    description: 'Also mentions HORIZON-RAISE-2026-01-01 in the body',
    orgId: 7,
    programId: 11,
    tags: ['European Commission'],
  };
  assert.equal(horizonTopicId(raise), 'HORIZON-RAISE-2026-01-01');
  assert.equal(horizonTopicId(bridging), 'HORIZON-BRIDGING-2027-01-13');
  assert.equal(sameRepeatFunder(bridging, raise), false);
  assert.equal(sameRepeatFunder(bridging, {
    name: 'Update on HORIZON-BRIDGING-2027-01-13',
    orgId: 99,
  }), true);
});

test('a new program launch or a $1M+ pledge lifts the hold, and a liquidity incentive does not', () => {
  const prior = { name: 'Btrust — Builder Grants', tags: ['Btrust'] };
  assert.equal(sameRepeatFunder({ name: 'Btrust Starter Grants', tags: ['Btrust'] }, prior), true);
  assert.equal(repeatFunderLift({
    name: 'Btrust launches a new grants program',
    description: 'Applications are open.',
    tags: ['Btrust'],
  }), 'new_program_launch');
  assert.equal(repeatFunderLift({
    name: 'Btrust launches a liquidity incentive program',
    description: 'LP rewards for the new pool.',
    tags: ['Btrust'],
  }), null);
  assert.equal(repeatFunderLift({
    name: 'Btrust',
    description: 'The grants program launched in 2024.',
    tags: ['Btrust'],
  }), null);
  assert.equal(repeatFunderLift({
    name: 'Anthropic Public Benefit Fund',
    description: 'pledges $2,000,000 for public-interest research',
    amount: '$2,000,000',
    tags: ['Anthropic'],
  }), 'pledge_1m');
  assert.equal(repeatFunderLift({
    name: 'Anthropic Public Benefit Fund',
    description: '5% share commitment',
    amount: '5% share commitment',
    amountNumeric: 5,
    tags: ['Anthropic'],
  }), null);
  assert.equal(repeatFunderLift({
    name: 'Btrust pledges $50,000',
    amountNumeric: 50000,
    tags: ['Btrust'],
  }), null);
  assert.equal(repeatFunderLift({
    name: 'Btrust commits $1,000,000',
    amountNumeric: '1000000.00',
    tags: ['Btrust'],
  }), 'pledge_1m');
});

test('a hold error explains the priors', () => {
  const error = new RepeatFunderHoldError([{
    entryId: 42, held: true, windowDays: 30,
    priors: [{ entryId: 10, name: 'Btrust — Builder Grants', wire: 'crypto', externalId: '9001', sentAt: '2026-09-20T12:00:00.000Z' }],
  }]);
  const body = repeatFunderPayload(error);
  assert.equal(body.reason, 'repeat_funder');
  assert.equal(body.holds[0].priors[0].externalId, '9001');
  assert.equal(body.holds[0].priors[0].wire, 'crypto');
});

if (!process.env.DATABASE_URL) {
  console.log('Skipping repeat-funder DB tests: DATABASE_URL not set');
} else {
  const schema = `repeat_funder_${process.pid}_${Date.now()}`;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, options: '' });
  const db = require('../src/db');
  const pool = db.getPool();

  test.before(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query('CREATE TABLE scan_entries (LIKE public.scan_entries INCLUDING ALL)');
    await pool.query('ALTER TABLE scan_entries ALTER COLUMN id DROP DEFAULT');
    await pool.query('ALTER TABLE scan_entries ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY');
    await db.ensureDistributionTables();
    await db.ensureAppStateTable();
  });

  test.beforeEach(async (t) => {
    await pool.query('TRUNCATE scan_entries, distribution_channels, distribution_config, distribution_logs, publication_queue, app_state RESTART IDENTITY CASCADE');
    t.mock.method(require('../src/services/post-generator'), 'generatePosts', async () => ({
      tweet: 't', telegram: 'frozen', model: 'mock', checkResult: { ok: true, violations: [] }, verifierResult: { ok: true, unsupported: [] },
    }));
  });

  test.after(async () => {
    await db.closePool();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  async function entry(name, tags = ['Btrust']) {
    return (await pool.query(`INSERT INTO scan_entries
      (name, description, source_url, wire, wires, prompt_variant, scan_source, scan_date, status, classification, distributable, quality_score, tags)
      VALUES ($1, 'Fixture grant description long enough', $2, 'crypto', ARRAY['crypto'], 'A', 'manual-intake', CURRENT_DATE, 'approved', 'GRANT', false, 80, $3::text[])
      RETURNING *`,
      [name, `https://example.invalid/${encodeURIComponent(name)}`, tags])).rows[0];
  }

  async function posted(name, wire, externalId, daysAgo) {
    const row = await entry(name);
    await pool.query(`UPDATE scan_entries SET wire = $2, wires = ARRAY[$2] WHERE id = $1`, [row.id, wire]);
    await pool.query(
      `INSERT INTO distribution_logs (entry_id, channel, wire, status, external_id, sent_at)
       VALUES ($1, 'telegram', $2, 'success', $3, NOW() - ($4 || ' days')::interval)`,
      [row.id, wire, externalId, String(daysAgo)],
    );
    return row;
  }

  async function paceAndChannel() {
    const { PACE_STATE_KEY } = require('../src/services/distribution-pace');
    await db.setAppState(PACE_STATE_KEY, {
      enabled: true, intervalMinutes: 20, timezone: 'America/Los_Angeles',
      quietHours: null, dailyCap: null, paused: false,
    });
    await pool.query(`INSERT INTO distribution_channels (wire, channel, name, enabled, target_id, credentials)
      VALUES ('crypto', 'telegram', 'crypto', true, 'crypto-chat', '{"bot_token":"fixture"}')`);
  }

  test('three recent Btrust posts block a new Starter Grants entry, and an override books it', async () => {
    await paceAndChannel();
    const builder = await posted('Btrust — Builder Grants', 'crypto', '9001', 2);
    const education = await posted('Btrust: Education Grants', 'ai', '9002', 5);
    const ecosystem = await posted('Btrust Ecosystem Round', 'oss', '9003', 9);
    await posted('Btrust — Old Round', 'crypto', '8000', 40);
    const starter = await entry('Btrust Starter Grants');
    const other = await entry('Other Foundation Starter Grants', ['Other Foundation']);

    const { repeatFunderHolds, RepeatFunderHoldError } = require('../src/services/repeat-funder');
    const { enqueuePacedPublication } = require('../src/services/publication-queue');
    const holds = await repeatFunderHolds(pool, [starter.id, other.id]);
    const starterHold = holds.find(hold => hold.entryId === starter.id);
    const otherHold = holds.find(hold => hold.entryId === other.id);
    assert.equal(starterHold.held, true);
    assert.deepEqual(starterHold.priors.map(prior => prior.externalId).sort(), ['9001', '9002', '9003']);
    assert.equal(starterHold.priors.some(prior => prior.externalId === '8000'), false);
    assert.equal(otherHold.held, false);
    assert.ok(starterHold.priors.every(prior => prior.wire && prior.sentAt));
    assert.deepEqual(
      [builder.id, education.id, ecosystem.id].sort(),
      starterHold.priors.map(prior => prior.entryId).sort(),
    );

    await assert.rejects(
      enqueuePacedPublication(starter.id, { actor: 'agent:hedwig', reason: 'Book it.' }),
      (error) => {
        assert.ok(error instanceof RepeatFunderHoldError);
        assert.equal(error.statusCode, 409);
        assert.equal(repeatFunderPayload(error).reason, 'repeat_funder');
        return true;
      },
    );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM publication_queue WHERE entry_id = $1', [starter.id])).rows[0].n, 0);

    await assert.rejects(
      enqueuePacedPublication(starter.id, { actor: 'agent:hedwig', overrideRepeatFunder: true }),
      (error) => error instanceof RepeatFunderHoldError && error.statusCode === 400,
    );

    const booked = await enqueuePacedPublication(starter.id, {
      actor: 'agent:hedwig',
      reason: 'Starter Grants is a distinct round.',
      overrideRepeatFunder: true,
    });
    assert.ok(booked.availableAt);
    const stored = (await pool.query('SELECT status, post_text FROM publication_queue WHERE entry_id = $1', [starter.id])).rows[0];
    assert.equal(stored.status, 'queued');
    assert.equal(stored.post_text, 'frozen');
    const audit = (await pool.query('SELECT metadata FROM scan_entries WHERE id = $1', [starter.id])).rows[0].metadata;
    assert.equal(audit.repeat_funder_overrides.length, 1);
    assert.equal(audit.repeat_funder_overrides[0].actor, 'agent:hedwig');
    assert.equal(audit.repeat_funder_overrides[0].reason, 'Starter Grants is a distinct round.');
    assert.equal(audit.repeat_funder_overrides[0].priors.length, 3);
  });

  test('an approve that would publish is refused while the funder is inside the window', async () => {
    await posted('Btrust — Builder Grants', 'crypto', '9100', 1);
    const starter = await entry('Btrust Starter Grants');
    await pool.query(`UPDATE scan_entries SET status = 'queued', distributable = true WHERE id = $1`, [starter.id]);
    const { singleEntryAction } = require('../src/services/entry-actions');
    const { RepeatFunderHoldError } = require('../src/services/repeat-funder');
    await assert.rejects(
      singleEntryAction(starter.id, 'approve', { actor: 'user:test', reason: 'Publish it.' }),
      (error) => error instanceof RepeatFunderHoldError && error.statusCode === 409,
    );
    assert.equal((await pool.query('SELECT status FROM scan_entries WHERE id = $1', [starter.id])).rows[0].status, 'queued');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM publication_queue WHERE entry_id = $1', [starter.id])).rows[0].n, 0);
  });

  test('a HORIZON-RAISE send does not hold a different Horizon topic, and launch or pledge lifts do', async () => {
    const { repeatFunderHolds } = require('../src/services/repeat-funder');
    await posted('European Commission — HORIZON-RAISE-2026-01-01', 'ai', '125', 1);
    await posted('European Commission — HORIZON-BRIDGING-2027-01-12', 'ai', '126', 1);
    const bridging = await entry('European Commission — HORIZON-BRIDGING-2027-01-13', ['European Commission']);
    await pool.query(
      `UPDATE scan_entries SET description = $2, source_url = $3 WHERE id = $1`,
      [bridging.id, 'Forthcoming topic. The body cites HORIZON-RAISE-2026-01-01.', 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-BRIDGING-2027-01-13'],
    );
    const sameTopic = await entry('Update — HORIZON-BRIDGING-2027-01-12', ['European Commission']);
    const launch = await entry('Btrust launches a new grants program', ['Btrust']);
    const liquidity = await entry('Btrust launches a liquidity incentive program', ['Btrust']);
    const pledge = await entry('Anthropic commits $2,000,000', ['Anthropic']);
    await pool.query(
      `UPDATE scan_entries SET description = $2, amount = $3, amount_numeric = $4, amount_currency = 'USD' WHERE id = $1`,
      [pledge.id, 'Anthropic pledges $2,000,000 for public-interest research.', '$2,000,000', 2000000],
    );
    const smallPledge = await entry('Anthropic pledges $50,000', ['Anthropic']);
    await pool.query(
      `UPDATE scan_entries SET amount = $2, amount_numeric = $3, amount_currency = 'USD' WHERE id = $1`,
      [smallPledge.id, '$50,000', 50000],
    );
    await posted('Btrust — Builder Grants', 'crypto', '9001', 2);
    await posted('Anthropic — Public Benefit Fund', 'ai', '9002', 3);

    const holds = await repeatFunderHolds(pool, [bridging.id, sameTopic.id, launch.id, liquidity.id, pledge.id, smallPledge.id]);
    const held = Object.fromEntries(holds.map(hold => [hold.entryId, hold.held]));
    assert.equal(held[bridging.id], false);
    assert.equal(held[sameTopic.id], true);
    assert.equal(held[launch.id], false);
    assert.equal(held[liquidity.id], true);
    assert.equal(held[pledge.id], false);
    assert.equal(held[smallPledge.id], true);
  });
}
