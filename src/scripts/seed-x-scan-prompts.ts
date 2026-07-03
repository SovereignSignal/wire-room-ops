/**
 * Seed Watchtower Tier-2 x_search prompts — INACTIVE by construction.
 * These are v1 starters modeled on Sov's manual daily Grok scans (the
 * incumbent); tune against the summarizer channel's yield before activating.
 * Activate via the dashboard (Sources > Scan Prompts) once GROK_API_KEY is live.
 *
 * Usage: npx ts-node src/scripts/seed-x-scan-prompts.ts
 * Re-runnable: skips any label that already exists.
 */
import { getPool } from '../db';

const RETURN_FORMAT = `Return a numbered list. For each item: Name — one to two sentence description folding in date and amount — Deadline: YYYY-MM-DD or Rolling or None listed — Link: the primary announcement URL. Only include items announced in the last 48 hours. No preamble, no commentary.`;

const PROMPTS: Array<{ wire: string; label: string; prompt_text: string; sort_order: number }> = [
  {
    wire: 'crypto', sort_order: 1, label: 'watchtower-crypto-broad',
    prompt_text: `Search X for posts from the last 48 hours announcing crypto grant programs, ecosystem funds, RFPs, builder programs, hackathons with prize pools, retroactive funding rounds, or DAO treasury funding proposals. Prefer official accounts (foundations, DAOs, grant programs). Exclude token launches, price commentary, airdrop farming, and expired programs. ${RETURN_FORMAT}`,
  },
  {
    wire: 'crypto', sort_order: 2, label: 'watchtower-crypto-tight',
    prompt_text: `Search X for posts from the last 48 hours where a crypto foundation, DAO, or protocol announces funding builders can apply for, with an explicit amount OR an application link OR a deadline. Only official first-party announcements. ${RETURN_FORMAT}`,
  },
  {
    wire: 'ai', sort_order: 1, label: 'watchtower-ai-broad',
    prompt_text: `Search X for posts from the last 48 hours announcing AI research grants, AI safety funding, fellowships, compute credit programs, lab or foundation funds, or government AI funding calls. Prefer official lab, foundation, university, and government accounts. Exclude product launches, benchmarks, papers without funding, and hiring posts. ${RETURN_FORMAT}`,
  },
  {
    wire: 'ai', sort_order: 2, label: 'watchtower-ai-tight',
    prompt_text: `Search X for posts from the last 48 hours where an AI lab, foundation, or government program announces funding researchers or builders can apply for, with an explicit amount OR application link OR deadline. First-party sources only. ${RETURN_FORMAT}`,
  },
  {
    wire: 'oss', sort_order: 1, label: 'watchtower-oss-broad',
    prompt_text: `Search X for posts from the last 48 hours announcing open source funding: maintainer grants, OSS security funds, foundation grant rounds, fellowships, sustainability programs, or public goods funding for software. Prefer official foundation and program accounts. Exclude general OSS news with no funding route. ${RETURN_FORMAT}`,
  },
  {
    wire: 'oss', sort_order: 2, label: 'watchtower-oss-tight',
    prompt_text: `Search X for posts from the last 48 hours where an OSS foundation or funder announces money maintainers or projects can apply for, with an explicit amount OR application link OR deadline. First-party sources only. ${RETURN_FORMAT}`,
  },
];

async function main(): Promise<void> {
  const pool = getPool();
  let inserted = 0, skipped = 0;
  for (const p of PROMPTS) {
    const { rowCount } = await pool.query(
      `INSERT INTO scan_prompts (wire, label, prompt_text, tool_type, is_active, sort_order)
       SELECT $1, $2, $3, 'x_search', false, $4
       WHERE NOT EXISTS (SELECT 1 FROM scan_prompts WHERE label = $2)`,
      [p.wire, p.label, p.prompt_text, p.sort_order],
    );
    if (rowCount) inserted++; else skipped++;
  }
  console.log(`[SeedPrompts] ${inserted} inserted, ${skipped} already present. All rows is_active=false — activate via dashboard once GROK_API_KEY is set.`);
}

main().then(() => process.exit(0)).catch(err => { console.error('[SeedPrompts] FAILED:', err.message); process.exit(1); });
