/**
 * Source Feeds — registry-driven grant/RFP ingester.
 *
 * Each source is config (method + endpoint + field mapping). A handler fetches the
 * source's container format (RSS/Atom, JSON REST, GraphQL, GitHub raw file, or a
 * Firecrawl scrape) and normalizes each record to a FeedItem {name, description, url,
 * amount, deadline, publishedAt}. The job layer (jobs/source-feeds.ts) filters to
 * net-new since a per-source watermark and pushes items through the existing intake
 * pipeline (precision pass -> dedup -> classifier -> queue) as scan_source='feed'.
 *
 * This lane is the answer to the forum audit: in 2026 most crypto grant INTAKE lives
 * on portals/aggregators (Karma GAP, foundation sites), not Discourse — and AI/OSS
 * funders announce on their own feeds. One wire-agnostic engine serves all three.
 *
 * Minimal-deps house style: the RSS/Atom parser is hand-rolled (no xml dependency).
 */

import { config } from '../config';
import { scrapeUrl } from './scraper';
import { getCachedProvider } from './api-provider';
import { logApiUsage } from './api-usage';

// --- Types ---

export type FeedMethod = 'rss' | 'rest_json' | 'graphql' | 'github_csv' | 'scrape';

export interface FeedSource {
  key: string;                 // stable id, used in watermark + submittedBy ('feed:<key>')
  name: string;                // human label
  wire: string;                // default wire; the classifier's scope gate can reassign
  method: FeedMethod;
  endpoint: string;
  enabled: boolean;
  // rest_json / graphql:
  httpMethod?: 'GET' | 'POST';
  body?: string;               // POST body (JSON) or GraphQL query
  headers?: Record<string, string>;
  itemsPath?: string;          // dot-path to the array of items in the JSON response
  // field mapping (dot-paths into each item) — rss/atom uses fixed fields, ignores this
  fields?: {
    name: string;
    description?: string;
    url: string;
    amount?: string;
    deadline?: string;
    date?: string;             // published/updated date field for net-new
  };
  urlPrefix?: string;          // prepended to relative urls (e.g. Atom <link href="/news/..">)
  // scrape: an instruction for the LLM extractor describing what opportunities to pull
  scrapePrompt?: string;
  maxItems?: number;           // safety cap per fetch (default 40)
  timeoutMs?: number;          // per-source fetch fuse; defaults to DEFAULT_TIMEOUT_MS
  // For rest_json/graphql sources whose shape needs URL construction, fallback chains,
  // unit conversion, or filtering that dot-path `fields` can't express. Return null to drop.
  extract?: (item: unknown) => FeedItem | null;
  // Title gating for news-heavy feeds: keep only titles matching titleAllow, and/or drop
  // titles matching titleBlock. Cuts org-news/blog posts at the source so only real
  // funding calls reach intake (the classifier alone lets NEWS-tagged announcements queue).
  titleAllow?: RegExp;
  titleBlock?: RegExp;
  // api_usage purpose override for scrape extraction (cost attribution)
  usagePurpose?: string;
}

export interface FeedItem {
  name: string;
  description: string;
  url: string;
  amount: string | null;
  deadline: string | null;
  publishedAt: string | null;  // ISO if known
}

// =====================================================================
// XML / RSS / Atom parsing (hand-rolled; handles both <item> and <entry>)
// =====================================================================

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2F;/gi, '/').replace(/&#038;|&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&#8217;|&#x2019;/gi, '’');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Extract the inner text of the first <name>...</name> in a block. */
function xmlTag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return decodeEntities(stripCdata(m[1])).trim();
}

/** Resolve a link from an RSS or Atom item. RSS: <link>url</link>. Atom: <link href=".."/>. */
function feedLink(block: string, urlPrefix?: string): string | null {
  let url = xmlTag(block, 'link');
  if (!url || /^\s*$/.test(url) || /^</.test(url)) {
    // Atom-style self-closing link(s); prefer rel="alternate" or no rel
    const links = [...block.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)];
    let chosen: string | null = null;
    for (const l of links) {
      const attrs = l[1];
      const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      const rel = attrs.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!rel || rel === 'alternate') { chosen = href; break; }
      if (!chosen) chosen = href;
    }
    url = chosen;
  }
  if (!url) return null;
  url = decodeEntities(url).trim();
  if (urlPrefix && /^\//.test(url)) url = urlPrefix.replace(/\/$/, '') + url;
  return url;
}

function toIso(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseFeed(xml: string, source: FeedSource): FeedItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) || [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const name = xmlTag(block, 'title');
    const url = feedLink(block, source.urlPrefix);
    if (!name || !url) continue;
    const rawDesc = xmlTag(block, 'description') || xmlTag(block, 'summary') || xmlTag(block, 'content') || '';
    const description = stripTags(rawDesc).slice(0, 600);
    const date = xmlTag(block, 'pubDate') || xmlTag(block, 'updated') || xmlTag(block, 'published') || xmlTag(block, 'dc:date');
    items.push({
      name: name.slice(0, 200),
      description: description || name,
      url,
      amount: null,
      deadline: null,
      publishedAt: toIso(date),
    });
  }
  return items;
}

// =====================================================================
// JSON dot-path mapping (for rest_json / graphql)
// =====================================================================

function getPath(obj: unknown, path?: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** First non-empty string value among the given dot-paths (fallback chain). */
function pick(item: unknown, ...paths: string[]): string | null {
  for (const p of paths) {
    const s = asStr(getPath(item, p));
    if (s && s.trim()) return s.trim();
  }
  return null;
}

const clip = (s: string, n = 600) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Map a JSON item array to FeedItems via a per-source extractor or dot-path fields. */
function mapItems(items: unknown[], source: FeedSource): FeedItem[] {
  const cap = source.maxItems || DEFAULT_MAX_ITEMS;
  if (source.extract) {
    const out: FeedItem[] = [];
    for (const it of items) {
      try {
        const fi = source.extract(it);
        if (fi && fi.name && fi.url) out.push(fi);
      } catch { /* skip malformed item */ }
      if (out.length >= cap) break;
    }
    return out;
  }
  return mapJsonItems(items, source).slice(0, cap);
}

function mapJsonItems(items: unknown[], source: FeedSource): FeedItem[] {
  const f = source.fields;
  if (!f) return [];
  const out: FeedItem[] = [];
  for (const it of items) {
    const name = asStr(getPath(it, f.name));
    let url = asStr(getPath(it, f.url));
    if (!name || !url) continue;
    if (source.urlPrefix && /^\//.test(url)) url = source.urlPrefix.replace(/\/$/, '') + url;
    const description = (asStr(getPath(it, f.description)) || name).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    out.push({
      name: name.slice(0, 200),
      description,
      url,
      amount: f.amount ? asStr(getPath(it, f.amount)) : null,
      deadline: f.deadline ? asStr(getPath(it, f.deadline)) : null,
      publishedAt: toIso(f.date ? asStr(getPath(it, f.date)) : null),
    });
  }
  return out;
}

// =====================================================================
// Fetch handlers (one per method)
// =====================================================================

const DEFAULT_MAX_ITEMS = 40;

export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * A feed fetch failure with a retry verdict attached. `transient` means a second
 * attempt could plausibly succeed (timeout, truncation, 5xx); permanent failures
 * (4xx, bad config) must not be retried — one of our methods calls a paid API.
 */
export class FeedFetchError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'FeedFetchError';
    this.transient = transient;
  }
}

/**
 * Read a JSON body without letting a truncated response masquerade as bad JSON.
 *
 * Compares BYTES, never UTF-16 code units: content-length is a byte count, and any
 * non-ASCII in the payload makes `text.length` smaller than the byte length on a
 * perfectly complete body. Comparing the two directly would report a false truncation
 * on every feed that mentions "Zürich".
 *
 * Chunked responses carry no content-length; there only the parse guard applies.
 */
export async function readJsonBody(r: Response): Promise<unknown> {
  const text = await r.text();
  const received = Buffer.byteLength(text, 'utf8');
  const header = r.headers.get('content-length');
  const expected = header ? Number(header) : null;
  if (expected && Number.isFinite(expected) && received < expected) {
    throw new FeedFetchError(`truncated body: got ${received} of ${expected} bytes`, true);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FeedFetchError(`invalid JSON (${received} bytes received)`, true);
  }
}

/**
 * Give a fetch failure a readable message and a retry verdict.
 * Unknown failures default to permanent — retrying something we do not
 * understand is how a bad config turns into doubled API spend.
 */
export function classifyFetchError(err: unknown, timeoutMs: number): FeedFetchError {
  if (err instanceof FeedFetchError) return err;
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new FeedFetchError(`timeout after ${Math.round(timeoutMs / 1000)}s`, true);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/^HTTP 5\d\d/.test(msg)) return new FeedFetchError(msg, true);
  return new FeedFetchError(msg, false);
}

async function httpGet(url: string, headers?: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': 'wire-room-ops/feeds', Accept: '*/*', ...(headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
}

async function fetchRss(source: FeedSource): Promise<FeedItem[]> {
  const r = await httpGet(source.endpoint, source.headers, source.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  return parseFeed(xml, source).slice(0, source.maxItems || DEFAULT_MAX_ITEMS);
}

async function fetchRestJson(source: FeedSource): Promise<FeedItem[]> {
  const init: RequestInit = {
    method: source.httpMethod || 'GET',
    headers: { 'User-Agent': 'wire-room-ops/feeds', Accept: 'application/json', 'Content-Type': 'application/json', ...(source.headers || {}) },
    signal: AbortSignal.timeout(source.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    redirect: 'follow',
  };
  if (source.httpMethod === 'POST' && source.body) init.body = source.body;
  const r = await fetch(source.endpoint, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await readJsonBody(r);
  const items = getPath(data, source.itemsPath) ?? data;
  if (!Array.isArray(items)) throw new Error(`itemsPath "${source.itemsPath}" is not an array`);
  return mapItems(items, source);
}

async function fetchGraphql(source: FeedSource): Promise<FeedItem[]> {
  const r = await fetch(source.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(source.headers || {}) },
    body: JSON.stringify({ query: source.body }),
    signal: AbortSignal.timeout(source.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await readJsonBody(r);
  const items = getPath(data, source.itemsPath);
  if (!Array.isArray(items)) throw new Error(`itemsPath "${source.itemsPath}" not an array in GraphQL response`);
  return mapItems(items, source);
}

async function fetchGithubCsv(source: FeedSource): Promise<FeedItem[]> {
  const r = await httpGet(source.endpoint, source.headers, source.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim());
  const f = source.fields;
  if (!f) return [];
  const col = (name?: string) => (name ? header.indexOf(name) : -1);
  const ci = { name: col(f.name), url: col(f.url), description: col(f.description), amount: col(f.amount), deadline: col(f.deadline), date: col(f.date) };
  const out: FeedItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = ci.name >= 0 ? (row[ci.name] || '').trim() : '';
    const url = ci.url >= 0 ? (row[ci.url] || '').trim() : '';
    if (!name || !url) continue;
    out.push({
      name: name.slice(0, 200),
      description: (ci.description >= 0 ? row[ci.description] : name || '').trim().slice(0, 600),
      url,
      amount: ci.amount >= 0 ? (row[ci.amount] || null) : null,
      deadline: ci.deadline >= 0 ? (row[ci.deadline] || null) : null,
      publishedAt: toIso(ci.date >= 0 ? row[ci.date] : null),
    });
  }
  return out.slice(0, source.maxItems || DEFAULT_MAX_ITEMS);
}

/** Minimal CSV parser (handles quoted fields with commas + escaped quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Scrape a portal page with Firecrawl, then LLM-extract opportunities. */
async function fetchScrape(source: FeedSource): Promise<FeedItem[]> {
  const scraped = await scrapeUrl(source.endpoint);
  if (!scraped.success || !scraped.content) throw new Error(`scrape failed: ${scraped.error || 'no content'}`);
  return llmExtractOpportunities(scraped.content.slice(0, 16000), source);
}

const SCRAPE_SCHEMA_HINT = `[{"name":"<program/RFP name>","description":"<one sentence: what it funds + who can apply>","url":"<application/details URL, absolute>","amount":"<$ or null>","deadline":"<date/Rolling/null>"}]`;

async function llmExtractOpportunities(markdown: string, source: FeedSource): Promise<FeedItem[]> {
  const provider = getCachedProvider('grok');
  const model = provider?.default_model || 'grok-4.20-beta-0309-non-reasoning';
  const apiKey = provider?.api_key;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  if (!apiKey) return [];
  const prompt = `From the following ${source.name} page content, extract every CURRENTLY-OPEN funding opportunity (grant program, RFP, ecosystem fund, fellowship, bounty round) that a builder could apply to. ${source.scrapePrompt || ''}\n\nReturn ONLY a JSON array (no prose, no fences):\n${SCRAPE_SCHEMA_HINT}\nUse absolute URLs (prefix ${source.urlPrefix || source.endpoint} for relative links). If none are clearly open, return [].\n\nPAGE CONTENT:\n${markdown}`;
  const start = Date.now();
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 6000, temperature: 0.1 }),
    });
    if (!r.ok) {
      logApiUsage({ provider: 'grok', model, purpose: source.usagePurpose || 'feed-scrape-extract', wire: source.wire, duration_ms: Date.now() - start, success: false, error_message: String(r.status) });
      throw new Error(`extract HTTP ${r.status}`);
    }
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    logApiUsage({ provider: 'grok', model, purpose: source.usagePurpose || 'feed-scrape-extract', wire: source.wire, duration_ms: Date.now() - start, tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens });
    const content = data.choices?.[0]?.message?.content || '';
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    const arr = JSON.parse(s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o: { name?: unknown; url?: unknown }) => o && typeof o.name === 'string' && typeof o.url === 'string')
      .map((o: { name: string; description?: string; url: string; amount?: string; deadline?: string }) => ({
        name: o.name.slice(0, 200),
        description: (o.description || o.name).slice(0, 600),
        url: o.url,
        amount: typeof o.amount === 'string' && /\d/.test(o.amount) ? o.amount : null,
        deadline: typeof o.deadline === 'string' && o.deadline.toLowerCase() !== 'null' ? o.deadline.slice(0, 50) : null,
        publishedAt: null,
      }))
      .slice(0, source.maxItems || DEFAULT_MAX_ITEMS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Feeds] scrape-extract failed for ${source.key}: ${msg}`);
    return [];
  }
}

/** Ensure a usable absolute http(s) URL; returns null for un-fixable values. */
function ensureHttp(url: string): string | null {
  const u = (url || '').trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/\//.test(u)) return 'https:' + u;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return 'https://' + u; // bare domain/path
  return null;
}

/** Dispatch a source to its handler, then normalize URLs. Throws on fetch/parse failure. */
export async function fetchSource(source: FeedSource): Promise<FeedItem[]> {
  let items: FeedItem[];
  switch (source.method) {
    case 'rss': items = await fetchRss(source); break;
    case 'rest_json': items = await fetchRestJson(source); break;
    case 'graphql': items = await fetchGraphql(source); break;
    case 'github_csv': items = await fetchGithubCsv(source); break;
    case 'scrape': items = await fetchScrape(source); break;
    default: throw new Error(`unknown method ${source.method}`);
  }
  return items
    .map(it => { const url = ensureHttp(it.url); return url ? { ...it, url } : null; })
    .filter((it): it is FeedItem => it !== null)
    .filter(it => !source.titleBlock || !source.titleBlock.test(it.name))
    .filter(it => !source.titleAllow || source.titleAllow.test(it.name));
}

// =====================================================================
// The seed registry — verified machine-readable sources first.
// Populated/expanded from the grant-source-registry audit workflow.
// =====================================================================

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Grants.gov keyword "artificial intelligence" pulls federal grants where AI is merely a
// TOOL applied to an unrelated field (medicine, agriculture, diplomacy) — off the AI beat.
// Drop those at the source; genuine AI-research grants (NSF, DARPA, DOE) pass through.
const GRANTS_GOV_OFFBEAT_TITLE = /\b(clinical|biomedical|medical|health|disease|patient|cancer|glucose|diabet|cardio|neuro(?!morphic)|rehabilitation|assistive|nursing|surg|therap|veterinar|agricultur|crop|farm|wildlife|fisher|nutrition|maternal|opioid|addiction|poverty|housing)\b/i;
const GRANTS_GOV_OFFBEAT_AGENCY = /U\.S\. Mission|Department of State|USAID|U\.S\. Agency for International|National Institutes of Health|Health and Human Services|Centers for Disease/i;

// Grants.gov search2 takes ONE keyword per call; we run several and let intake-level
// URL dedup (same oppId → same detail URL) collapse cross-keyword repeats.
function grantsGovSource(key: string, keyword: string): FeedSource {
  return {
    key,
    name: `Grants.gov — ${keyword}`,
    wire: 'ai',
    method: 'rest_json',
    endpoint: 'https://api.grants.gov/v1/api/search2',
    httpMethod: 'POST',
    body: JSON.stringify({ rows: 100, keyword, oppStatuses: 'forecasted|posted' }),
    itemsPath: 'data.oppHits',
    enabled: true,
    extract: (it) => {
      const name = pick(it, 'title', 'opportunityTitle');
      const id = pick(it, 'id', 'number', 'opportunityNumber');
      if (!name || !id) return null;
      const agency = pick(it, 'agencyName', 'agency', 'agencyCode') || '';
      if (GRANTS_GOV_OFFBEAT_TITLE.test(name) || GRANTS_GOV_OFFBEAT_AGENCY.test(agency)) return null;
      const num = pick(it, 'number', 'opportunityNumber') || '';
      const status = pick(it, 'oppStatus') || '';
      return {
        name: name.slice(0, 200),
        description: clip([agency, num && `#${num}`, status && `(${status})`].filter(Boolean).join(' ') || name),
        url: `https://www.grants.gov/search-results-detail/${id}`,
        amount: null,
        deadline: pick(it, 'closeDate', 'responseDate'),
        publishedAt: toIso(pick(it, 'openDate', 'postingDate')),
      };
    },
  };
}

// EA Forum and LessWrong share the same Forum-Magnum GraphQL API (same query shape, different host).
// Resolved tag IDs (2026-06-28):
//   ea-forum funding-opportunities           be4pBryMKxLhkmgvE
//   ea-forum opportunities-to-take-action    z8qFsGt5iXyZiLbjN
//   lesswrong grants-and-fundraising-opportunities  Z6DgiCrMtpSNxwuYW
function forumMagnumSource(key: string, name: string, host: string, tagId: string): FeedSource {
  return {
    key,
    name,
    wire: 'ai',
    method: 'graphql',
    endpoint: `${host}/graphql`,
    headers: { 'User-Agent': BROWSER_UA },
    body: `query { posts(input:{terms:{view:"tagById",tagId:"${tagId}",sortedBy:"new",limit:30}}){ results{ _id title pageUrl postedAt baseScore contents{ plaintextDescription } } } }`,
    itemsPath: 'data.posts.results',
    enabled: true,
    extract: (it) => {
      const name = pick(it, 'title');
      const url = pick(it, 'pageUrl');
      if (!name || !url) return null;
      return {
        name: name.slice(0, 200),
        description: clip(pick(it, 'contents.plaintextDescription') || name),
        url, amount: null, deadline: null,
        publishedAt: toIso(pick(it, 'postedAt')),
      };
    },
  };
}

export const SOURCE_REGISTRY: FeedSource[] = [
  // =================== CRYPTO ===================
  {
    // Cross-ecosystem grant-program registry. The crown jewel: ~62 active grant
    // programs across ecosystems, public, no auth. Mixes in student hackathons → cut
    // type=hackathon/vcfund here; the classifier handles the rest.
    key: 'karma-gap',
    name: 'Karma GAP — Grant Registry',
    wire: 'crypto',
    method: 'rest_json',
    endpoint: 'https://gapapi.karmahq.xyz/registry?status=active&limit=500',
    itemsPath: 'programs',
    enabled: true,
    maxItems: 120,
    // This API returns 200 + content-encoding: gzip + content-length: 0 + an EMPTY body
    // when the client sends Accept-Encoding: gzip, which Node's fetch does by default.
    // Asking for identity encoding returns the full ~268KB payload. Server-side defect;
    // this is the client-side workaround. Verified 2026-07-30.
    headers: { 'Accept-Encoding': 'identity' },
    // 268KB — by far the largest payload in the registry. Generous fuse for a slow
    // uncompressed transfer; this was NOT the cause of the July 2026 outage (see the
    // Accept-Encoding note below).
    timeoutMs: 45000,
    extract: (it) => {
      const type = (asStr(getPath(it, 'type')) || '').toLowerCase();
      if (type === 'hackathon' || type === 'vcfund') return null;
      const name = pick(it, 'name', 'metadata.title');
      const programId = pick(it, 'programId', '_id');
      const url = pick(it, 'metadata.applicationUrl', 'submissionUrl', 'metadata.website', 'metadata.socialLinks.grantsSite')
        || (programId ? `https://gap.karmahq.xyz/funding-map/${programId}` : null);
      if (!name || !url) return null;
      let deadline = pick(it, 'metadata.endsAt');
      if (!deadline) { const ts = getPath(it, 'deadline.$timestamp.t'); if (typeof ts === 'number' && ts > 0) deadline = new Date(ts * 1000).toISOString(); }
      const amount = pick(it, 'metadata.programBudgetNumeric', 'metadata.programBudget');
      return {
        name: name.slice(0, 200),
        description: clip(pick(it, 'metadata.description', 'metadata.shortDescription') || name),
        url,
        amount: amount && /\d/.test(amount) ? amount : null,
        deadline,
        publishedAt: toIso(pick(it, 'createdAt', 'approvedAt')),
      };
    },
  },
  {
    // Quadratic-funding matching rounds = the grant opportunities (not donation causes).
    key: 'giveth-qf',
    name: 'Giveth — QF Rounds',
    wire: 'crypto',
    method: 'graphql',
    endpoint: 'https://mainnet.serve.giveth.io/graphql',
    body: 'query { qfRounds { id name slug description allocatedFundUSD beginDate endDate isActive } }',
    itemsPath: 'data.qfRounds',
    enabled: true,
    extract: (it) => {
      const name = pick(it, 'name', 'title');
      const slug = pick(it, 'slug');
      if (!name || !slug) return null;
      const endDate = pick(it, 'endDate');
      if (endDate && Date.parse(endDate) && Date.parse(endDate) < Date.now()) return null; // skip ended rounds
      return {
        name: name.slice(0, 200),
        description: clip(pick(it, 'description') || name),
        url: `https://giveth.io/qf/${slug}`,
        amount: pick(it, 'allocatedFundUSD'),
        deadline: endDate,
        publishedAt: null,
      };
    },
  },
  {
    // Avalanche Retro9000 funding rounds (ingest 'rounds', not applicant 'submissions').
    key: 'avax-retro9000',
    name: 'Avalanche — Retro9000',
    wire: 'crypto',
    method: 'rest_json',
    endpoint: 'https://api-retro-9000.avax.network/api/rounds?status=ACTIVE&page=1&perPage=50',
    itemsPath: 'data',
    enabled: true,
    extract: (it) => {
      const name = pick(it, 'name');
      const id = pick(it, 'id');
      if (!name) return null;
      const amtNum = pick(it, 'potential_reward.amount');
      const cur = pick(it, 'potential_reward.currency');
      const amount = amtNum ? `${amtNum} ${cur || ''}`.trim() : pick(it, 'potential_reward');
      return {
        name: name.slice(0, 200),
        description: clip(pick(it, 'description') || name),
        url: id ? `https://retro9000.avax.network/?round=${id}` : 'https://retro9000.avax.network/',
        amount,
        deadline: pick(it, 'submission_ends_at'),
        publishedAt: toIso(pick(it, 'created_at')),
      };
    },
  },
  // =================== AI ===================
  // US federal grants, AI-scoped. Three keyword variants share the same extract logic via
  // the grantsGovSource factory; intake-level URL dedup collapses cross-keyword repeats.
  grantsGovSource('grants-gov-ai', 'artificial intelligence'),
  grantsGovSource('grants-gov-ml', 'machine learning'),
  grantsGovSource('grants-gov-fm', 'foundation models'),
  {
    // Direct API is Vercel-bot-blocked; Firecrawl renders the page and bypasses it.
    // Using /causes/ai-safety (primary); /about/regranting also tried — both yield ~1 aggregate
    // regranting item per run rather than a rich discrete-opportunity list. Flagged for
    // verification review; enabled so the regranting signal is captured even if thin.
    key: 'manifund',
    name: 'Manifund — AI Safety Grants',
    wire: 'ai',
    method: 'scrape',
    endpoint: 'https://manifund.org/causes/ai-safety',
    urlPrefix: 'https://manifund.org',
    scrapePrompt: 'Extract active grant/regranting opportunities and open projects seeking funding on this AI-safety page. Use each project/program URL (manifund.org/projects/<slug> or /about/regranting).',
    enabled: true,
  },
  // EA Forum and LessWrong: three Forum-Magnum GraphQL sources via the forumMagnumSource factory.
  // Two EA Forum tags + one LessWrong tag broaden coverage beyond the single funding tag.
  forumMagnumSource('ea-forum-funding', 'EA Forum — Funding Opportunities', 'https://forum.effectivealtruism.org', 'be4pBryMKxLhkmgvE'),
  forumMagnumSource('ea-forum-opportunities', 'EA Forum — Opportunities/RFPs', 'https://forum.effectivealtruism.org', 'z8qFsGt5iXyZiLbjN'),
  { ...forumMagnumSource('lesswrong-funding', 'LessWrong — Funding/Opportunities', 'https://www.lesswrong.com', 'Z6DgiCrMtpSNxwuYW'), enabled: false }, // skip: no clean LW funding tag — tag returns general research posts, not active calls
  {
    key: 'fli-grants',
    name: 'Future of Life Institute — Grant Programs',
    wire: 'ai',
    method: 'rss',
    endpoint: 'https://futureoflife.org/grant-program/feed/',
    enabled: true,
    titleBlock: /^\d{4}\s+grants$/i, // drop "2023 Grants" / "2024 Grants" retrospective recaps
  },
  // =================== OSS ===================
  {
    key: 'nlnet-news',
    name: 'NLnet / NGI — News & Open Calls',
    wire: 'oss',
    method: 'rss',
    endpoint: 'https://nlnet.nl/feed.atom',
    urlPrefix: 'https://nlnet.nl',
    enabled: true,
    // NLnet's feed is mostly org news; calls are titled "Apply for funding…" / "open call".
    titleAllow: /apply for funding|open call|call for proposal|request for proposal|grants? (are |is )?open|funding (round|is open|available)/i,
  },
  {
    key: 'otf-news',
    name: 'Open Technology Fund — RFPs',
    wire: 'oss',
    method: 'rss',
    endpoint: 'https://www.opentech.fund/feed/',
    enabled: true,
    // OTF RFPs are titled "Request for Proposals: …"; the rest is blog/news.
    titleAllow: /request for proposal|\bRFP\b|open call|call for|fellowship|funding (round|opportunit)/i,
  },
  {
    key: 'otf-funds',
    name: 'Open Technology Fund — Funds & Open Calls',
    wire: 'oss',
    method: 'scrape',
    endpoint: 'https://www.opentech.fund/funds/',
    urlPrefix: 'https://www.opentech.fund',
    scrapePrompt: "Include each named OTF fund/program currently accepting applications (e.g. Internet Freedom Fund, Rapid Response Fund, FOSS Sustainability Fund). Use each fund's own page URL.",
    enabled: true,
  },
  // =================== OWN-SITE FUNDERS ===================
  {
    key: 'coefficient-giving', name: 'Coefficient Giving — Grants', wire: 'ai',
    method: 'scrape', endpoint: 'https://coefficientgiving.org/apply-for-funding/', urlPrefix: 'https://coefficientgiving.org',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: true,
  },
  // =================== PHASE 2b — STAGED AI SOURCES (verification gate) ===================
  {
    key: 'aisafety-funding',
    name: 'AISafety.com — Funding Opportunities',
    wire: 'ai',
    method: 'scrape',
    endpoint: 'https://www.aisafety.com/funding',
    urlPrefix: 'https://www.aisafety.com',
    scrapePrompt: 'Extract each currently-open AI safety grant, fellowship, or funding opportunity a researcher or org can apply to; use each opportunity\'s own application/details URL.',
    enabled: true, // verified 2026-06-28: 16 discrete items (Schmidt Sciences, SFF, Longview, Leo Gao, …)
  },
  {
    key: 'ea-opportunities',
    name: 'EA Opportunities — Grants & RFPs',
    wire: 'ai',
    method: 'scrape',
    endpoint: 'https://www.eaopportunities.org/',
    urlPrefix: 'https://www.eaopportunities.org',
    scrapePrompt: 'Extract each currently-open grant, fellowship, or funding opportunity a builder or researcher can apply to; use each opportunity\'s own application/details URL.',
    enabled: false, // skip: eaopportunities.org domain does not resolve (DNS failure 2026-06-28)
  },
  {
    key: 'eu-funding-tenders',
    name: 'EU Funding & Tenders — AI Open Calls',
    wire: 'ai',
    method: 'rest_json',
    endpoint: 'https://api.tech.ec.europa.eu/search-api/prod/rest/search',
    enabled: false, // skip: F&T SEDIA search API shape not resolved in bounded effort (multipart/form body, non-standard response envelope)
    // itemsPath/extract UNVERIFIED — SEDIA API needs a multipart/form request + response-shape work before enabling; do not flip enabled:true until resolved
    extract: (_it: unknown) => null,
  },
  {
    key: 'sam-gov',
    name: 'SAM.gov — AI Opportunities',
    wire: 'ai',
    method: 'rest_json',
    endpoint: 'https://api.sam.gov/opportunities/v2/search',
    enabled: false, // skip: needs SAM_GOV_API_KEY (not configured)
    // headers: { 'X-Api-Key': process.env.SAM_GOV_API_KEY || '' },
    itemsPath: 'opportunitiesData',
    extract: (_it: unknown) => null,
  },
  // =================== OWN-SITE FUNDERS (continued) ===================
  {
    key: 'longview', name: 'Longview — Grants', wire: 'ai',
    method: 'scrape', endpoint: 'https://www.longview.org/funds/', urlPrefix: 'https://www.longview.org',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: true,
  },
  {
    key: 'sff', name: 'Survival and Flourishing Fund — Grants', wire: 'ai',
    method: 'scrape', endpoint: 'https://survivalandflourishing.fund/', urlPrefix: 'https://survivalandflourishing.fund',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: true,
  },
  {
    key: 'ai2050', name: 'AI2050 — Grants', wire: 'ai',
    method: 'scrape', endpoint: 'https://ai2050.schmidtsciences.org/', urlPrefix: 'https://ai2050.schmidtsciences.org',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: true,
  },
  {
    key: 'cohere-labs', name: 'Cohere Labs — Research Grants', wire: 'ai',
    method: 'scrape', endpoint: 'https://cohere.com/research/grants', urlPrefix: 'https://cohere.com',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: true,
  },
  {
    key: 'openai-forms', name: 'OpenAI — Grant Forms', wire: 'ai',
    method: 'scrape', endpoint: 'https://openai.com/form/', urlPrefix: 'https://openai.com',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: false, // skip: Firecrawl returned no discrete items (page is a form index, not a grants listing)
  },
  {
    key: 'sovereign-tech', name: 'Sovereign Tech Agency — Programs', wire: 'oss',
    method: 'scrape', endpoint: 'https://www.sovereign.tech/programs', urlPrefix: 'https://www.sovereign.tech',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: true,
  },
  {
    key: 'futo-grants', name: 'FUTO — Grants', wire: 'oss',
    method: 'scrape', endpoint: 'https://futo.org/grants/', urlPrefix: 'https://futo.org',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: false, // skip: Firecrawl returned no discrete items (page may be JS-heavy or grants currently closed)
  },
  {
    key: 'freebsd-foundation', name: 'FreeBSD Foundation — Grants', wire: 'oss',
    method: 'scrape', endpoint: 'https://freebsdfoundation.org/our-work/grants/', urlPrefix: 'https://freebsdfoundation.org',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: true,
  },
  {
    key: 'open-source-collective', name: 'Open Source Collective — Funding', wire: 'oss',
    method: 'scrape', endpoint: 'https://oscollective.org/', urlPrefix: 'https://oscollective.org',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: false, // skip: only returns a single fiscal-hosting application form (opencollective.com/opensource/apply), not discrete grant opportunities
  },
  {
    key: 'github-sponsors', name: 'GitHub Sponsors — Explore', wire: 'oss',
    method: 'scrape', endpoint: 'https://github.com/sponsors/explore', urlPrefix: 'https://github.com',
    scrapePrompt: 'Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program\'s own application/details URL.',
    enabled: false, // skip: Firecrawl returned no discrete items (page is JS-rendered browse UI, not a grants listing)
  },
];

export function getEnabledSources(wire?: string): FeedSource[] {
  return SOURCE_REGISTRY.filter(s => s.enabled && (!wire || s.wire === wire));
}
