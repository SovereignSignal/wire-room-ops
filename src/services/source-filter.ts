/**
 * Source filter — Gate 1 rejection of known Tier-3 aggregator domains.
 *
 * The agent playbook already says "skip aggregators" but nothing enforced it
 * on inbound URLs, so opportunity-aggregator scholarship/fellowship content
 * (opportunitydesk, afredac, menterprise, etc.) flowed straight into the queue
 * and defaulted to the crypto wire. This blocks those sources before they
 * cost a classification call.
 *
 * Deliberately conservative: only unambiguous aggregator domains. Borderline
 * sources are left to the classifier's domain-scope gate, which flags rather
 * than hard-blocks. Extend via the SOURCE_BLOCKLIST_EXTRA env var
 * (comma-separated domains).
 */

import { isIP } from 'node:net';
import { isBlockedHost } from '../utils/ssrf';

const DEFAULT_BLOCKED_DOMAINS = [
  // Opportunity aggregators (scholarships/fellowships listicles)
  'opportunitydesk.org',
  'opd.to',                       // opportunitydesk shortener
  'opportunitiesforyouth.org',
  'globalsouthopportunities.com',
  'afredac.net',
  'menterprise.africa',
  'mystudypals.com',
  'scholarshipbob.com',
  'scholarshipair.com',
  'scholarshipregion.com',
  'youthop.com',
  'oyaop.com',
  'oyaop.org',
  'afterschoolafrica.com',
  'scholarshippositions.com',
  'opportunitiescircle.com',
  'armacad.info',
];

let cachedExtra: string[] | null = null;
function extraBlocked(): string[] {
  if (cachedExtra) return cachedExtra;
  const raw = process.env.SOURCE_BLOCKLIST_EXTRA || '';
  cachedExtra = raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  return cachedExtra;
}

/** The full blocklist of aggregator domains (defaults + env extras). */
export function blockedDomains(): string[] {
  return [...DEFAULT_BLOCKED_DOMAINS, ...extraBlocked()];
}

/**
 * Hosts Parallel search should not retrieve. Kept off the Gate 1 list on
 * purpose: a human paste or another lane can still submit these, but Parallel
 * was buying the same aggregator and social pages every day.
 *
 * Ordered by how often they showed up in the 2026-10-10 feed review. Extend
 * this constant; do not fold it into SOURCE_BLOCKLIST_EXTRA.
 */
export const PARALLEL_EXCLUDE_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'web3grant.com',
  'web3grants.com',
  'fundsforngos.org',
  'profellow.com',
  'opportunityforafrica.org',
  'careerflora.com',
  'msmeafricaonline.com',
  'gate.com',
  'tradingview.com',
  'investing.com',
  'cryptonomist.ch',
  'binance.com',
  'webproxy.freebrowser.org',
  'giving.columbia.edu',
  'grants.watch',
  // 2026-10-11 live run: grant directories, plus a research-admin dictionary.
  'blockchainacademics.com',
  'grantedai.com',
  'inventya.com',
  'casrai.org',
];

/** Scholarship block list plus the Parallel-only hosts, de-duplicated. */
export function parallelExcludeDomains(): string[] {
  return [...new Set([...blockedDomains(), ...PARALLEL_EXCLUDE_DOMAINS])];
}

function hostMatchesList(host: string, list: string[]): boolean {
  return list.some(blocked => host === blocked || host.endsWith('.' + blocked));
}

/**
 * Aggregator or social host for Parallel extraction. Matches this list and the
 * global scholarship list, including subdomains (m.facebook.com).
 */
export function isParallelAggregatorHost(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = hostOf(url);
  if (!host) return false;
  return hostMatchesList(host, [...PARALLEL_EXCLUDE_DOMAINS, ...blockedDomains()]);
}

/** Normalize a URL to its registrable host (lowercased, no www). */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/\.+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns the matched blocked domain if the URL's host is (or is a subdomain
 * of) a blocked aggregator, else null.
 */
export function blockedSourceDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  const list = [...DEFAULT_BLOCKED_DOMAINS, ...extraBlocked()];
  for (const blocked of list) {
    if (host === blocked || host.endsWith('.' + blocked)) return blocked;
  }
  return null;
}

export type SourceLinkClass = 'missing' | 'invalid' | 'placeholder' | 'shortener' | 'tweet-only' | 'ok';

function hasPublicHostnameSyntax(host: string): boolean {
  if (isBlockedHost(host)) return false;
  if (isIP(host)) return true;
  if (host.length > 253 || !host.includes('.')) return false;
  return host.split('.').every(label => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

/**
 * Classify whether a source URL is publishable evidence or an intake marker.
 * Keep this shared: batch intake, raw processing, source sweep, and approval
 * must agree or placeholders can become queued entries merely by changing path.
 */
export function classifySourceLink(url: string | null | undefined): SourceLinkClass {
  const value = (url || '').trim();
  if (!value) return 'missing';
  if (/^scan:\/\//i.test(value)) return 'placeholder';
  // WHATWG URL accepts shorthand such as `https:example.com`; sources must use
  // explicit web URL syntax so every gate stores the same canonical shape.
  if (!/^https?:\/\/[^/]/i.test(value)) return 'invalid';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'invalid';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'invalid';
  if (parsed.username || parsed.password) return 'invalid';
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (!host) return 'invalid';
  if (host.endsWith('.')) return 'invalid';
  if (host === 'manual' && /^\/needs-source(?:\/|$)/i.test(parsed.pathname)) return 'placeholder';
  if (host === 't.me' && /^\/manual(?:\/|$)/i.test(parsed.pathname)) return 'placeholder';
  if (!hasPublicHostnameSyntax(host)) return 'invalid';
  if (['t.co', 'bit.ly', 'tinyurl.com', 'buff.ly', 'ow.ly'].includes(host)) return 'shortener';
  if (host === 'x.com' || host === 'twitter.com') return 'tweet-only';
  return 'ok';
}
