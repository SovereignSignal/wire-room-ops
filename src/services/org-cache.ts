import { getAllOrgs, NotionOrg } from './notion';

interface OrgAlias {
  normalizedName: string;
  orgId: string;
  orgName: string;
}

interface OrgCache {
  aliases: Map<string, OrgAlias>;
  orgsById: Map<string, NotionOrg>;
  lastRefreshed: Date | null;
}

const cache: OrgCache = {
  aliases: new Map(),
  orgsById: new Map(),
  lastRefreshed: null,
};

const CACHE_TTL_MS = 30 * 60 * 1000;

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function generateAliases(orgName: string): string[] {
  const aliases: string[] = [normalizeName(orgName)];

  const variations = [
    orgName.replace(/\s+(Foundation|Labs?|Protocol|DAO|Grants?\s*Council|Network)$/i, ''),
    orgName.replace(/^The\s+/i, ''),
  ];

  for (const v of variations) {
    const normalized = normalizeName(v);
    if (normalized && !aliases.includes(normalized)) {
      aliases.push(normalized);
    }
  }

  const knownAliases: Record<string, string[]> = {
    optimism: ['op', 'optimismfoundation', 'optimismgrantscouncil'],
    arbitrum: ['arb', 'arbitrumfoundation', 'arbitrumdao'],
    uniswap: ['uni', 'uniswapfoundation', 'uniswaplabs'],
    ethereum: ['eth', 'ethereumfoundation'],
    polygon: ['matic', 'polygonlabs'],
    aave: ['aavegrants', 'aavecompanies'],
  };

  const baseNormalized = normalizeName(orgName);
  for (const [base, extraAliases] of Object.entries(knownAliases)) {
    if (baseNormalized === base || extraAliases.includes(baseNormalized)) {
      for (const alias of [base, ...extraAliases]) {
        if (!aliases.includes(alias)) {
          aliases.push(alias);
        }
      }
    }
  }

  return aliases;
}

export async function refreshCache(): Promise<void> {
  console.log('Refreshing org cache from Notion...');
  const orgs = await getAllOrgs();

  cache.aliases.clear();
  cache.orgsById.clear();

  for (const org of orgs) {
    cache.orgsById.set(org.id, org);

    const aliases = generateAliases(org.name);
    for (const alias of aliases) {
      if (!cache.aliases.has(alias)) {
        cache.aliases.set(alias, {
          normalizedName: alias,
          orgId: org.id,
          orgName: org.name,
        });
      }
    }
  }

  cache.lastRefreshed = new Date();
  console.log(`Org cache refreshed: ${orgs.length} orgs, ${cache.aliases.size} aliases`);
}

export async function ensureCacheLoaded(): Promise<void> {
  if (!cache.lastRefreshed) {
    await refreshCache();
    return;
  }

  const cacheAge = Date.now() - cache.lastRefreshed.getTime();
  if (cacheAge > CACHE_TTL_MS) {
    await refreshCache();
  }
}

export interface OrgMatch {
  orgId: string;
  orgName: string;
  matchedAlias: string;
  confidence: 'exact' | 'alias';
}

export async function findOrgMatch(name: string): Promise<OrgMatch | null> {
  await ensureCacheLoaded();

  const normalized = normalizeName(name);
  const aliasMatch = cache.aliases.get(normalized);

  if (aliasMatch) {
    return {
      orgId: aliasMatch.orgId,
      orgName: aliasMatch.orgName,
      matchedAlias: aliasMatch.normalizedName,
      confidence: normalized === normalizeName(aliasMatch.orgName) ? 'exact' : 'alias',
    };
  }

  return null;
}

export function addToCache(org: NotionOrg): void {
  cache.orgsById.set(org.id, org);

  const aliases = generateAliases(org.name);
  for (const alias of aliases) {
    if (!cache.aliases.has(alias)) {
      cache.aliases.set(alias, {
        normalizedName: alias,
        orgId: org.id,
        orgName: org.name,
      });
    }
  }
}

export function getCacheStats(): { orgCount: number; aliasCount: number; lastRefreshed: Date | null } {
  return {
    orgCount: cache.orgsById.size,
    aliasCount: cache.aliases.size,
    lastRefreshed: cache.lastRefreshed,
  };
}

export function getOrgById(id: string): NotionOrg | undefined {
  return cache.orgsById.get(id);
}
