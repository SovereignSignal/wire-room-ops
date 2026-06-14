/**
 * Queue dedup review (read-only): find QUEUED entries that match something already
 * decided (approved/declined/archived/duplicate) by normalized URL or squashed name.
 * Run: railway run npx ts-node src/scripts/queue-dedup-review.ts
 */
import { getPool } from '../db';

async function main() {
  const pool = getPool();
  const { rows } = await pool.query(`
    WITH q AS (
      SELECT id, name, source_url, wire, scan_source, created_at,
             lower(regexp_replace(coalesce(name,''), '[^a-zA-Z0-9]', '', 'g')) AS sq_name,
             lower(rtrim(coalesce(source_url,''), '/')) AS norm_url
      FROM scan_entries WHERE status = 'queued'
    ),
    decided AS (
      SELECT id, name, status, created_at,
             lower(regexp_replace(coalesce(name,''), '[^a-zA-Z0-9]', '', 'g')) AS sq_name,
             lower(rtrim(coalesce(source_url,''), '/')) AS norm_url
      FROM scan_entries WHERE status IN ('approved','declined','archived','duplicate')
    )
    SELECT DISTINCT ON (q.id)
      q.id AS q_id, q.name AS q_name, q.wire, q.scan_source,
      d.status AS prior_status, d.name AS prior_name, d.created_at::date AS prior_date,
      CASE WHEN q.norm_url = d.norm_url AND q.norm_url <> '' THEN 'URL' ELSE 'name' END AS match
    FROM q JOIN decided d
      ON (q.norm_url = d.norm_url AND q.norm_url <> '')
      OR (length(q.sq_name) > 8 AND q.sq_name = d.sq_name)
    ORDER BY q.id, (CASE WHEN q.norm_url = d.norm_url THEN 0 ELSE 1 END),
             (CASE d.status WHEN 'approved' THEN 0 WHEN 'declined' THEN 1 WHEN 'duplicate' THEN 2 ELSE 3 END)
  `);

  const total = (await pool.query(`SELECT count(*) FROM scan_entries WHERE status='queued'`)).rows[0].count;
  console.log(`\n=== Queue dedup review: ${rows.length} of ${total} queued entries match a prior decision ===\n`);
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.prior_status] = (byStatus[r.prior_status] || 0) + 1;
    console.log(`  #${r.q_id} [${String(r.wire).padEnd(6)}] ${String(r.q_name).slice(0, 52).padEnd(52)} ${r.match.padEnd(4)} -> prior ${r.prior_status} (${r.prior_date})`);
  }
  console.log(`\n  by prior status: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  ids: ${rows.map(r => r.q_id).join(',')}`);

  if (process.argv.includes('--apply') && rows.length) {
    const ids = rows.map(r => r.q_id);
    const res = await pool.query(
      `UPDATE scan_entries SET status='duplicate', actioned_by='system:dedup-review',
         action_reason='re-queue of a prior decided entry (cleared in dedup review)'
       WHERE id = ANY($1::int[]) AND status='queued'`, [ids]);
    console.log(`\n  Cleared ${res.rowCount} re-queued duplicates (status queued->duplicate, reversible).`);
  } else if (rows.length) {
    console.log(`\n  (dry-run — re-run with --apply to mark these duplicate)`);
  }
  console.log('');
  await pool.end();
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
