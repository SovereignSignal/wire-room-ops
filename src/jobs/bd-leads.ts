/**
 * Weekly BD leads job.
 *
 * Finds + qualifies + verifies BD opportunities from the last N days of
 * relationship_signal entries, dedups by org, and writes the verified ones into
 * the Notion "Leads" list in the operator's CRM as Status=Lead. FIND + QUALIFY ONLY:
 * never contacts anyone, never creates Opps. Folded into the daily-digest run
 * and gated to Wednesday by the scheduler — no new cron.
 */
import type { Pool } from 'pg';
import { qualifyOpportunities, BdCandidate, QualifiedOpportunity } from '../services/bd-qualifier';
import { verifyBdOpportunities, bdVerifyAvailable, isUsableBdVerification, BdVerifyInput, BdVerifyResult } from '../services/bd-verify';
import { writeLeadsToNotion, LeadRecord } from '../services/bd-leads-notion';
import { enabledRoleSources, fetchRoleSource, roleMatchesLane, pickFreshRoles, RolePosting } from '../services/bd-roles';
import { getAppState, setAppState } from '../db';

const LINE_LABEL: Record<string, string> = {
  grant_program_ops: 'Grants-ops',
  ops_sales_bd: 'Ops/Sales/BD',
  governance_ops: 'Governance',
};
const confRank = (c?: string | null): number => (c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0);

export interface BdLeadsResult {
  signals: number;
  shapeFit: number;
  verified: number;
  unique: number;
  /** roles lane (Phase B): fetched -> lane-fit -> net-new -> qualified */
  rolesFetched: number;
  rolesFresh: number;
  rolesQualified: number;
  created: number;
  skipped: number;
  message: string;
  /** the deduped verified leads (for the digest email's BD block) */
  leads: LeadRecord[];
}

const ROLES_WEEKLY_CAP = 10;

/**
 * Roles lane: fetch the ATS/RSS registry, taxonomy-filter titles, take
 * net-new per source (app_state watermark), qualify against OPERATOR_PROFILE, and
 * return LeadRecords. ATS data is fresh by construction, so roles skip the
 * Parallel verify stage. Watermarks are RETURNED, not written — the caller
 * persists them only after the Notion write succeeds (Phase-3 lesson).
 */
async function collectRoleLeads(): Promise<{
  fetched: number; fresh: number; qualified: number;
  leads: LeadRecord[];
  pendingSeen: Array<{ key: string; urls: string[] }>;
  sourceErrors: number;
}> {
  const sources = enabledRoleSources();
  const settled = await Promise.allSettled(sources.map(s => fetchRoleSource(s)));

  let fetched = 0;
  let sourceErrors = 0;
  const freshAll: RolePosting[] = [];
  const pendingSeen: Array<{ key: string; urls: string[] }> = [];

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const r = settled[i];
    if (r.status === 'rejected') {
      sourceErrors++;
      console.warn(`[BdRoles] ${src.key} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
      continue;
    }
    const laneFit = r.value.filter(p => roleMatchesLane(p.title));
    fetched += laneFit.length;
    let prevSeen: string[] | null = null;
    try {
      const state = await getAppState<{ urls: string[] }>(`bd:roles:seen:${src.key}`);
      prevSeen = state && Array.isArray(state.urls) ? state.urls : null;
    } catch { prevSeen = null; }
    const picked = pickFreshRoles(laneFit, prevSeen);
    freshAll.push(...picked.fresh);
    pendingSeen.push({ key: src.key, urls: picked.seenUrls });
    if (picked.firstRunCapped) console.log(`[BdRoles] ${src.key}: first run capped to newest ${picked.fresh.length}`);
  }

  if (freshAll.length === 0) return { fetched, fresh: 0, qualified: 0, leads: [], pendingSeen, sourceErrors };

  // Qualify roles with the same OPERATOR_PROFILE screen (synthetic ids local to this batch)
  const candidates: BdCandidate[] = freshAll.map((p, idx) => ({
    id: idx + 1,
    name: `ROLE OPENING: ${p.title} @ ${p.org}`,
    description: [p.location, p.comp, p.publishedAt ? `posted ${p.publishedAt.slice(0, 10)}` : null].filter(Boolean).join(' · ') || 'open role',
    wire: p.lane,
    source_url: p.url,
    classification: 'ROLE',
  }));
  const shape = await qualifyOpportunities(candidates);
  const byId = new Map(shape.map(r => [r.id, r]));
  const qualified = freshAll
    .map((p, idx) => ({ p, s: byId.get(idx + 1) }))
    .filter((x): x is { p: RolePosting; s: QualifiedOpportunity } => Boolean(x.s?.qualified))
    .sort((a, b) => (b.s.confidence || 0) - (a.s.confidence || 0))
    .slice(0, ROLES_WEEKLY_CAP);

  const leads: LeadRecord[] = qualified.map(({ p, s }) => ({
    lead: `${p.org} — ${p.title} (role)`.slice(0, 200),
    source: p.url,
    notes: `[${LINE_LABEL[s.fit_line] || s.fit_line} role · ${p.lane} · ats] ${[p.location, p.comp].filter(Boolean).join(' · ') || 'open role'}`,
    body: `Open role at ${p.org}: ${p.title}\n${p.location || ''}${p.comp ? ` · ${p.comp}` : ''}\nWhy it fits: ${s.pain || s.reason}\nPosting: ${p.url}`,
  }));

  return { fetched, fresh: freshAll.length, qualified: qualified.length, leads, pendingSeen, sourceErrors };
}

export async function runBdLeads(pool: Pool, opts: { days?: number } = {}): Promise<BdLeadsResult> {
  const days = opts.days ?? 7;
  const out: BdLeadsResult = { signals: 0, shapeFit: 0, verified: 0, unique: 0, rolesFetched: 0, rolesFresh: 0, rolesQualified: 0, created: 0, skipped: 0, message: '', leads: [] };

  // ── Lane 1: org relationship signals (qualify -> Parallel verify) ──────
  const { rows } = await pool.query(
    `SELECT id, name, description, wire, source_url, classification
     FROM scan_entries
     WHERE COALESCE(metadata->'curator'->>'route', metadata->>'operator_route') = 'relationship_signal'
       AND status IN ('queued', 'approved')
       AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
     ORDER BY created_at DESC`,
    [days],
  );
  const candidates: BdCandidate[] = rows.map((r: Record<string, unknown>) => ({
    id: r.id as number, name: r.name as string, description: r.description as string | null,
    wire: r.wire as string | null, source_url: r.source_url as string | null, classification: r.classification as string | null,
  }));
  out.signals = candidates.length;

  let signalLeads: LeadRecord[] = [];
  if (candidates.length) {
    // Stage 1 — shape-screen
    const shape = await qualifyOpportunities(candidates);
    const shapeById = new Map<number, QualifiedOpportunity>(shape.map(r => [r.id, r]));
    const pass = candidates.filter(c => shapeById.get(c.id)?.qualified);
    out.shapeFit = pass.length;

    // Stage 2 — verify against live sources (drops stale / confabulated)
    if (pass.length && bdVerifyAvailable()) {
      const vinputs: BdVerifyInput[] = pass.map(c => ({ id: c.id, name: c.name, org: shapeById.get(c.id)?.org || null, url: c.source_url }));
      const vres = await verifyBdOpportunities(vinputs);
      const vById = new Map<number, BdVerifyResult>();
      for (const v of vres) if (v) vById.set(v.id, v);
      const verified = pass.filter(c => isUsableBdVerification(vById.get(c.id) || null));
      out.verified = verified.length;

      // Dedup by org, keep highest verification confidence
      const byOrg = new Map<string, { rec: LeadRecord; conf: string }>();
      for (const c of verified) {
        const s = shapeById.get(c.id)!;
        const v = vById.get(c.id)!;
        const org = (s.org || c.name).trim();
        const line = LINE_LABEL[s.fit_line] || s.fit_line;
        const rec: LeadRecord = {
          lead: `${org} — ${line.toLowerCase()} opportunity`.slice(0, 200),
          source: v.citationUrl || c.source_url || '',
          notes: `[${line} · ${c.wire || '?'} · ${v.confidence || 'low'}] ${v.status_summary || s.why_now}`,
          body: `Verified: ${v.status_summary || ''}\nOriginal signal: ${c.name}\nConfidence: ${v.confidence || 'low'} · Last activity: ${v.last_activity || 'unknown'}`,
        };
        const key = org.toLowerCase();
        const cur = byOrg.get(key);
        if (!cur || confRank(v.confidence) > confRank(cur.conf)) byOrg.set(key, { rec, conf: v.confidence || 'low' });
      }
      signalLeads = Array.from(byOrg.values()).map(x => x.rec);
      out.unique = signalLeads.length;
    } else if (pass.length) {
      console.warn('[BdLeads] parallel key unavailable — shape-fit signals not verified, not surfaced');
    }
  }

  // ── Lane 2: role openings (Phase B — fresh by construction, no verify) ─
  let roleLeads: LeadRecord[] = [];
  let pendingRoleSeen: Array<{ key: string; urls: string[] }> = [];
  try {
    const roles = await collectRoleLeads();
    out.rolesFetched = roles.fetched;
    out.rolesFresh = roles.fresh;
    out.rolesQualified = roles.qualified;
    roleLeads = roles.leads;
    pendingRoleSeen = roles.pendingSeen;
    if (roles.sourceErrors > 0) console.warn(`[BdRoles] ${roles.sourceErrors} role sources errored this run`);
  } catch (e) {
    console.error('[BdLeads] roles lane failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  const leads = [...signalLeads, ...roleLeads];
  out.leads = leads;

  if (!leads.length) {
    out.message = `no leads this run (signals ${out.signals}→${out.shapeFit}→${out.verified}; roles ${out.rolesFetched} lane-fit→${out.rolesFresh} fresh→${out.rolesQualified} qualified)`;
    return out;
  }

  // Write to the Notion Leads list (dedups by Source URL across weeks)
  const w = await writeLeadsToNotion(leads);
  out.created = w.created;
  out.skipped = w.skipped;

  // Persist role watermarks ONLY after a clean write — items marked seen
  // before durable persistence get silently lost (the Phase-3 feeds lesson).
  if (w.configured && w.errors === 0) {
    for (const p of pendingRoleSeen) {
      try { await setAppState(`bd:roles:seen:${p.key}`, { urls: p.urls, lastRun: new Date().toISOString() }); }
      catch (err) { console.warn(`[BdRoles] failed to persist seen-state ${p.key}:`, err instanceof Error ? err.message : err); }
    }
  } else if (pendingRoleSeen.length) {
    console.warn('[BdRoles] Notion write not clean — role watermarks NOT advanced (items will retry next run)');
  }

  out.message = w.configured
    ? `signals ${out.signals}→${out.shapeFit}→${out.verified}→${out.unique}; roles ${out.rolesFetched}→${out.rolesFresh} fresh→${out.rolesQualified}; ${w.message}`
    : w.message;
  return out;
}
