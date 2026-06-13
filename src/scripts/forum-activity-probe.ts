/**
 * Forum activity probe — measures REAL recent grant-signal per allowlist forum.
 * Read-only against discuss.watch (no DB, no Grok, no secrets). Outputs compact JSON
 * for the allowlist-audit workflow to reason over. Run: npx ts-node src/scripts/forum-activity-probe.ts
 */

import { sleep } from '../utils/async';

const BASE = process.env.DISCUSS_WATCH_API_URL || 'https://discuss-dot-watch-production.up.railway.app/api/v1';

// The current crypto GOVERNANCE_ALLOWLIST (forum.ts), lowercased discuss.watch names.
const FORUMS = [
  'arbitrum', 'optimism', 'zksync era', 'polygon', 'starknet', 'mantle',
  'linea', 'scroll', 'taiko', 'mode network', 'celo', 'gnosis', 'celestia',
  'cosmos hub', 'near protocol', 'polkadot', 'cardano', 'solana', 'avalanche',
  'aptos', 'stacks', 'berachain', 'monad', 'story protocol',
  'gitcoin', 'ens', 'octant', 'the graph',
  'aave', 'compound', 'sky (makerdao)', 'curve finance', 'balancer',
  'lido finance', 'eigenlayer', 'cow protocol', 'morpho', 'yearn finance',
  'dydx', 'gmx', 'ethereum magicians', 'ethereum research',
];

const GRANT_RE = /grant|fund|rfp|bounty|hackathon|ecosystem|treasury|retro|public good|incubat|accelerat|fellowship|stipend|allocation|sponsor|wishlist|questbook|delegate program|builder/i;
const SINCE_DAYS = 90;

async function fetchForum(forum: string): Promise<Array<{ title?: string; createdAt?: string }>> {
  const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString().split('T')[0];
  const params = new URLSearchParams({ category: 'crypto', forums: forum, sort: 'new', limit: '50', since });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${BASE}/discussions?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await sleep(9000); continue; }
      if (!r.ok) return [];
      const d = await r.json() as { data?: Array<{ title?: string; createdAt?: string }> };
      return d.data || [];
    } catch { await sleep(2000); }
  }
  return [];
}

async function main() {
  const ageCut = Date.now() - SINCE_DAYS * 86400000;
  const out: Array<Record<string, unknown>> = [];
  for (const forum of FORUMS) {
    const items = await fetchForum(forum);
    const recent = items.filter(i => i.createdAt && new Date(i.createdAt).getTime() >= ageCut);
    const grant = recent
      .filter(i => i.title && GRANT_RE.test(i.title))
      .map(i => ({ t: (i.title || '').slice(0, 90), d: (i.createdAt || '').slice(0, 10) }));
    out.push({ forum, total_recent_90d: recent.length, grant_signal_count: grant.length, latest_grant: grant[0]?.d || null, grant_titles: grant.slice(0, 8) });
    process.stderr.write(`  ${forum}: ${recent.length} recent, ${grant.length} grant-ish\n`);
    await sleep(3500);
  }
  console.log(JSON.stringify(out));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
