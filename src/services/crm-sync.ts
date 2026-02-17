import { Wire } from '../types';
import { createOrg, searchOrgs, updateOrgLastSeen, NotionOrg, isNotionConfigured } from './notion';
import { findOrgMatch, addToCache, refreshCache, getCacheStats } from './org-cache';

export interface TeleSumEntry {
  id: number;
  title?: string;
  summary?: string;
  category?: string;
  orgs: string[];
  amounts: string[];
  source?: {
    url?: string;
    name?: string;
    type?: string;
  };
  published_at: string;
  wire?: Wire;
}

export interface SyncResult {
  orgName: string;
  action: 'matched' | 'created' | 'skipped' | 'error';
  notionOrgId?: string;
  notionOrgName?: string;
  reason?: string;
}

export interface EntrySyncResult {
  entryId: number;
  entryTitle?: string;
  orgsProcessed: SyncResult[];
}

const RELEVANT_CATEGORIES = [
  'Funding & Grants',
  'Announcements',
  'Partnerships',
  'Governance',
  'Treasury',
];

function isRelevantCategory(category?: string): boolean {
  if (!category) return false;
  const normalized = category.toLowerCase();
  return RELEVANT_CATEGORIES.some(c => normalized.includes(c.toLowerCase()));
}

function extractTwitterUrl(sourceUrl?: string): string | undefined {
  if (!sourceUrl) return undefined;
  const url = sourceUrl.toLowerCase();
  if (url.includes('twitter.com') || url.includes('x.com')) {
    return sourceUrl;
  }
  return undefined;
}

function extractWebsiteUrl(sourceUrl?: string, sourceType?: string): string | undefined {
  if (!sourceUrl) return undefined;
  const url = sourceUrl.toLowerCase();
  if (url.includes('twitter.com') || url.includes('x.com')) {
    return undefined;
  }
  if (['blog', 'forum', 'governance', 'substack', 'mirror', 'medium'].includes(sourceType || '')) {
    return sourceUrl;
  }
  return sourceUrl;
}

function inferSourceType(sourceType?: string): string | undefined {
  const mapping: Record<string, string> = {
    twitter: 'Social',
    forum: 'Forum',
    blog: 'Blog',
    governance: 'Governance',
    substack: 'Newsletter',
    mirror: 'Blog',
    medium: 'Blog',
    github: 'Code',
    discord: 'Social',
    news: 'News',
  };
  return sourceType ? mapping[sourceType] : undefined;
}

export async function syncOrgFromEntry(
  orgName: string,
  entry: TeleSumEntry
): Promise<SyncResult> {
  if (!orgName || orgName.trim().length < 2) {
    return { orgName, action: 'skipped', reason: 'Name too short' };
  }

  const match = await findOrgMatch(orgName);

  if (match) {
    await updateOrgLastSeen(match.orgId);
    return {
      orgName,
      action: 'matched',
      notionOrgId: match.orgId,
      notionOrgName: match.orgName,
    };
  }

  const searchResults = await searchOrgs(orgName);
  if (searchResults.length > 0) {
    const bestMatch = searchResults[0];
    addToCache(bestMatch);
    await updateOrgLastSeen(bestMatch.id);
    return {
      orgName,
      action: 'matched',
      notionOrgId: bestMatch.id,
      notionOrgName: bestMatch.name,
      reason: 'Found via Notion search',
    };
  }

  const twitterUrl = extractTwitterUrl(entry.source?.url);
  const websiteUrl = extractWebsiteUrl(entry.source?.url, entry.source?.type);

  const newOrg = await createOrg({
    name: orgName,
    wire: entry.wire,
    sourceType: inferSourceType(entry.source?.type),
    twitter: twitterUrl,
    website: websiteUrl,
  });

  if (newOrg) {
    addToCache(newOrg);
    return {
      orgName,
      action: 'created',
      notionOrgId: newOrg.id,
      notionOrgName: newOrg.name,
    };
  }

  return {
    orgName,
    action: 'error',
    reason: 'Failed to create org in Notion',
  };
}

export async function syncEntry(
  entry: TeleSumEntry,
  options: { filterByCategory?: boolean } = {}
): Promise<EntrySyncResult> {
  const result: EntrySyncResult = {
    entryId: entry.id,
    entryTitle: entry.title,
    orgsProcessed: [],
  };

  if (options.filterByCategory && !isRelevantCategory(entry.category)) {
    return result;
  }

  if (!entry.orgs || entry.orgs.length === 0) {
    return result;
  }

  const uniqueOrgs = [...new Set(entry.orgs)];

  for (const orgName of uniqueOrgs) {
    const syncResult = await syncOrgFromEntry(orgName, entry);
    result.orgsProcessed.push(syncResult);
  }

  return result;
}

export async function syncEntries(
  entries: TeleSumEntry[],
  options: {
    filterByCategory?: boolean;
    onProgress?: (current: number, total: number) => void;
  } = {}
): Promise<{
  results: EntrySyncResult[];
  stats: {
    entriesProcessed: number;
    orgsMatched: number;
    orgsCreated: number;
    orgsSkipped: number;
    orgsErrored: number;
  };
}> {
  if (!isNotionConfigured()) {
    console.warn('Notion API not configured, skipping CRM sync');
    return {
      results: [],
      stats: { entriesProcessed: 0, orgsMatched: 0, orgsCreated: 0, orgsSkipped: 0, orgsErrored: 0 },
    };
  }

  await refreshCache();

  const results: EntrySyncResult[] = [];
  let orgsMatched = 0;
  let orgsCreated = 0;
  let orgsSkipped = 0;
  let orgsErrored = 0;

  for (let i = 0; i < entries.length; i++) {
    if (options.onProgress) {
      options.onProgress(i + 1, entries.length);
    }

    const result = await syncEntry(entries[i], { filterByCategory: options.filterByCategory });
    results.push(result);

    for (const orgResult of result.orgsProcessed) {
      switch (orgResult.action) {
        case 'matched':
          orgsMatched++;
          break;
        case 'created':
          orgsCreated++;
          break;
        case 'skipped':
          orgsSkipped++;
          break;
        case 'error':
          orgsErrored++;
          break;
      }
    }
  }

  const cacheStats = getCacheStats();
  console.log(`CRM sync complete. Cache: ${cacheStats.orgCount} orgs, ${cacheStats.aliasCount} aliases`);

  return {
    results,
    stats: {
      entriesProcessed: entries.length,
      orgsMatched,
      orgsCreated,
      orgsSkipped,
      orgsErrored,
    },
  };
}

export async function fetchTeleSumEntries(
  baseUrl: string,
  options: {
    dateFrom?: Date;
    dateTo?: Date;
    category?: string;
    wire?: Wire;
    limit?: number;
  } = {}
): Promise<TeleSumEntry[]> {
  const params = new URLSearchParams();

  if (options.dateFrom) {
    params.set('date_from', options.dateFrom.toISOString());
  }
  if (options.dateTo) {
    params.set('date_to', options.dateTo.toISOString());
  }
  if (options.category) {
    params.set('category', options.category);
  }
  if (options.wire) {
    params.set('wire', options.wire);
  }
  params.set('per_page', String(options.limit || 100));

  const url = `${baseUrl}/api/entries/?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Tele-Sum API error: ${response.status}`);
    }
    const data = (await response.json()) as { entries?: TeleSumEntry[] };
    return data.entries || [];
  } catch (error) {
    console.error('Error fetching Tele-Sum entries:', error);
    return [];
  }
}
