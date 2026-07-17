require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// DB integration test for resolveProgram's candidate-pull SQL: an alias-only
// match (candidate matches a program's alias but not its normalized_key,
// org, or URL) must surface through the SQL prefilter, or the JS scoring
// pass never gets a chance to see it. The fake-pool unit tests in
// program-identity.test.js hand-build the row set and so cannot catch a SQL
// prefilter bug — this test exercises the real query against real Postgres.
// Requires DATABASE_URL (CI provides Postgres).
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping program-identity DB tests: DATABASE_URL not set');
  process.exit(0);
}

const { getPool, closePool } = require('../src/db');
const { ensureProgramsTable, resolveProgram } = require('../src/services/program-identity');

test('resolveProgram: alias-only match surfaces through the SQL prefilter', async () => {
  const pool = getPool();
  await ensureProgramsTable();

  const pid = process.pid;
  const suffix = `Pid${pid}`;
  const aliasName = `Anthropic AI Safety Fellowship ${suffix}`;
  // normalized_key deliberately does NOT prefix-match the candidate below
  // (10th char 'f' vs the candidate's 'a') -- only the alias does, so a
  // match here proves the alias branch of the SQL prefilter, not the
  // normalized_key branch.
  const normalizedKey = `anthropicfellowsprogram${suffix.toLowerCase()}`;
  // Squashes to the same key as aliasName (the trailing "2027" is stripped
  // as year noise by normalizeProgramKey), so this is a clean alias-only
  // "key" pass once the row surfaces.
  const candidateName = `Anthropic AI Safety Fellowship ${suffix} 2027`;

  let programId;
  try {
    const inserted = await pool.query(
      `INSERT INTO programs (canonical_name, normalized_key, aliases)
       VALUES ($1, $2, $3) RETURNING id`,
      [`Anthropic Fellows Program ${suffix}`, normalizedKey, [aliasName]],
    );
    programId = inserted.rows[0].id;

    const match = await resolveProgram(pool, { name: candidateName });
    assert.ok(match, 'alias-only candidate must resolve to the program via the SQL prefilter');
    assert.equal(match.program.id, programId);
    assert.equal(match.pass, 'key', 'the JS scoring pass should recognize the alias as a key match');
  } finally {
    if (programId) {
      await pool.query(`DELETE FROM programs WHERE id = $1`, [programId]);
    }
  }
});

test.after(async () => {
  await closePool();
});
