import { Client, isFullPage } from '@notionhq/client';
import type { QueryDatabaseResponse, SearchResponse, PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { config } from '../config';
import { Wire } from '../types';

let notionClient: Client | null = null;

export function getNotionClient(): Client | null {
  if (!config.apis.notion.apiKey) {
    return null;
  }
  if (!notionClient) {
    notionClient = new Client({ auth: config.apis.notion.apiKey });
  }
  return notionClient;
}

export function isNotionConfigured(): boolean {
  return Boolean(config.apis.notion.apiKey);
}

export function isStagingConfigured(): boolean {
  return Boolean(config.apis.notion.apiKey && config.apis.notion.stagingOrgsDbId);
}

export interface NotionOrg {
  id: string;
  name: string;
  type?: string;
  wire?: string;
  tier?: string;
  sourceType?: string;
  twitter?: string;
  website?: string;
  lastSeen?: string;
  autoCreated?: boolean;
}

export interface CreateOrgParams {
  name: string;
  wire?: Wire;
  sourceType?: string;
  twitter?: string;
  website?: string;
}

export interface StagingOrg {
  id: string;
  name: string;
  wire?: string;
  sourceType?: string;
  firstSeen?: string;
  entryTitle?: string;
  entryUrl?: string;
  status?: 'Pending' | 'Approved' | 'Rejected';
}

export interface CreateStagingOrgParams {
  name: string;
  wire?: Wire;
  sourceType?: string;
  entryTitle?: string;
  entryUrl?: string;
}

const RATE_LIMIT_DELAY_MS = 350;
let requestQueue: Promise<unknown> = Promise.resolve();

async function rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    await sleep(RATE_LIMIT_DELAY_MS);
    return fn();
  });
  // Chain onto queue so next request waits for this one
  requestQueue = result.then(() => {}, () => {});
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function queryOrgsDatabase(nameFilter?: string): Promise<NotionOrg[]> {
  const client = getNotionClient();
  if (!client) return [];

  const filter = nameFilter
    ? {
        property: 'Name',
        title: { contains: nameFilter },
      }
    : undefined;

  try {
    const response = await rateLimitedRequest(() =>
      client.databases.query({
        database_id: config.apis.notion.orgsDbId,
        filter,
        page_size: 100,
      })
    );

    return response.results
      .filter((page): page is PageObjectResponse => isFullPage(page))
      .map(page => parseOrgPage(page));
  } catch (error) {
    console.error('Error querying Notion Orgs database:', error);
    return [];
  }
}

export async function getAllOrgs(): Promise<NotionOrg[]> {
  const client = getNotionClient();
  if (!client) return [];

  const allOrgs: NotionOrg[] = [];
  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    try {
      const response = await rateLimitedRequest(() =>
        client.databases.query({
          database_id: config.apis.notion.orgsDbId,
          start_cursor: startCursor,
          page_size: 100,
        })
      );

      allOrgs.push(
        ...response.results
          .filter((page): page is PageObjectResponse => isFullPage(page))
          .map(page => parseOrgPage(page))
      );
      hasMore = response.has_more;
      startCursor = response.next_cursor ?? undefined;
    } catch (error) {
      console.error('Error fetching all orgs from Notion:', error);
      break;
    }
  }

  return allOrgs;
}

export async function searchOrgs(query: string): Promise<NotionOrg[]> {
  const client = getNotionClient();
  if (!client) return [];

  try {
    // First, try direct database query with name filter (more reliable)
    const dbResponse = await rateLimitedRequest(() =>
      client.databases.query({
        database_id: config.apis.notion.orgsDbId,
        filter: {
          property: 'Name',
          title: { contains: query },
        },
        page_size: 10,
      })
    );

    if (dbResponse.results.length > 0) {
      return dbResponse.results
        .filter((page): page is PageObjectResponse => isFullPage(page))
        .map(page => parseOrgPage(page));
    }

    // Fallback to global search if database query returns nothing
    const response = await rateLimitedRequest(() =>
      client.search({
        query,
        filter: { property: 'object', value: 'page' },
        page_size: 10,
      })
    );

    const orgsDbId = config.apis.notion.orgsDbId.replace(/-/g, '');
    const orgPages = response.results.filter((page): page is PageObjectResponse => {
      if (!isFullPage(page)) return false;
      const parentDbId = (page.parent as any)?.database_id?.replace(/-/g, '');
      return parentDbId === orgsDbId;
    });

    return orgPages.map(page => parseOrgPage(page));
  } catch (error) {
    console.error('Error searching Notion orgs:', error);
    return [];
  }
}

export async function createOrg(params: CreateOrgParams): Promise<NotionOrg | null> {
  const client = getNotionClient();
  if (!client) return null;

  const properties: any = {
    Name: {
      title: [{ text: { content: params.name } }],
    },
  };

  if (params.wire) {
    const wireValue = params.wire.toUpperCase();
    properties['Wire'] = { select: { name: wireValue } };
  }

  if (params.sourceType) {
    properties['Source Type'] = { select: { name: params.sourceType } };
  }

  if (params.twitter) {
    properties['Twitter'] = { url: params.twitter };
  }

  if (params.website) {
    properties['Website'] = { url: params.website };
  }

  properties['Auto-created'] = { checkbox: true };

  try {
    const response = await rateLimitedRequest(() =>
      client.pages.create({
        parent: { database_id: config.apis.notion.orgsDbId },
        properties,
      })
    );

    return parseOrgPage(response as PageObjectResponse);
  } catch (error) {
    console.error('Error creating org in Notion:', error);
    return null;
  }
}

export async function updateOrgLastSeen(
  orgId: string,
  entryRef?: string
): Promise<boolean> {
  const client = getNotionClient();
  if (!client) return false;

  const properties: any = {
    'Last Seen': { date: { start: new Date().toISOString().split('T')[0] } },
  };

  try {
    await rateLimitedRequest(() =>
      client.pages.update({
        page_id: orgId,
        properties,
      })
    );
    return true;
  } catch (error) {
    console.error('Error updating org last seen:', error);
    return false;
  }
}

function parseOrgPage(page: PageObjectResponse): NotionOrg {
  const props = page.properties as Record<string, any>;

  const getName = (): string => {
    const titleProp = props['Name'];
    if (titleProp?.title?.[0]?.plain_text) {
      return titleProp.title[0].plain_text;
    }
    return 'Unknown';
  };

  const getSelect = (key: string): string | undefined => {
    return props[key]?.select?.name;
  };

  const getUrl = (key: string): string | undefined => {
    return props[key]?.url;
  };

  const getDate = (key: string): string | undefined => {
    return props[key]?.date?.start;
  };

  const getCheckbox = (key: string): boolean => {
    return props[key]?.checkbox === true;
  };

  return {
    id: page.id,
    name: getName(),
    type: getSelect('Type'),
    wire: getSelect('Wire'),
    tier: getSelect('Tier'),
    sourceType: getSelect('Source Type'),
    twitter: getUrl('Twitter'),
    website: getUrl('Website'),
    lastSeen: getDate('Last Seen'),
    autoCreated: getCheckbox('Auto-created'),
  };
}

function parseStagingOrgPage(page: PageObjectResponse): StagingOrg {
  const props = page.properties as Record<string, any>;

  const getName = (): string => {
    const titleProp = props['Name'];
    if (titleProp?.title?.[0]?.plain_text) {
      return titleProp.title[0].plain_text;
    }
    return 'Unknown';
  };

  const getSelect = (key: string): string | undefined => {
    return props[key]?.select?.name;
  };

  const getUrl = (key: string): string | undefined => {
    return props[key]?.url;
  };

  const getDate = (key: string): string | undefined => {
    return props[key]?.date?.start;
  };

  const getText = (key: string): string | undefined => {
    const prop = props[key];
    if (prop?.rich_text?.[0]?.plain_text) {
      return prop.rich_text[0].plain_text;
    }
    return undefined;
  };

  return {
    id: page.id,
    name: getName(),
    wire: getSelect('Wire'),
    sourceType: getSelect('Source Type'),
    firstSeen: getDate('First Seen'),
    entryTitle: getText('Entry Title'),
    entryUrl: getUrl('Entry URL'),
    status: getSelect('Status') as StagingOrg['status'],
  };
}

export async function createStagingOrg(params: CreateStagingOrgParams): Promise<StagingOrg | null> {
  const client = getNotionClient();
  if (!client || !config.apis.notion.stagingOrgsDbId) return null;

  const properties: any = {
    Name: {
      title: [{ text: { content: params.name } }],
    },
    'First Seen': {
      date: { start: new Date().toISOString().split('T')[0] },
    },
    Status: {
      select: { name: 'Pending' },
    },
  };

  if (params.wire) {
    const wireValue = params.wire.toUpperCase();
    properties['Wire'] = { select: { name: wireValue } };
  }

  if (params.sourceType) {
    properties['Source Type'] = { select: { name: params.sourceType } };
  }

  if (params.entryTitle) {
    properties['Entry Title'] = {
      rich_text: [{ text: { content: params.entryTitle.slice(0, 2000) } }],
    };
  }

  if (params.entryUrl) {
    properties['Entry URL'] = { url: params.entryUrl };
  }

  try {
    const response = await rateLimitedRequest(() =>
      client.pages.create({
        parent: { database_id: config.apis.notion.stagingOrgsDbId },
        properties,
      })
    );

    return parseStagingOrgPage(response as PageObjectResponse);
  } catch (error) {
    console.error('Error creating staging org in Notion:', error);
    return null;
  }
}

export async function getStagingOrgs(status?: 'Pending' | 'Approved' | 'Rejected'): Promise<StagingOrg[]> {
  const client = getNotionClient();
  if (!client || !config.apis.notion.stagingOrgsDbId) return [];

  const filter = status
    ? {
        property: 'Status',
        select: { equals: status },
      }
    : undefined;

  try {
    const allOrgs: StagingOrg[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      const response = await rateLimitedRequest(() =>
        client.databases.query({
          database_id: config.apis.notion.stagingOrgsDbId,
          filter,
          start_cursor: startCursor,
          page_size: 100,
        })
      );

      allOrgs.push(
        ...response.results
          .filter((page): page is PageObjectResponse => isFullPage(page))
          .map(page => parseStagingOrgPage(page))
      );
      hasMore = response.has_more;
      startCursor = response.next_cursor ?? undefined;
    }

    return allOrgs;
  } catch (error) {
    console.error('Error fetching staging orgs from Notion:', error);
    return [];
  }
}

export async function checkStagingOrgExists(name: string): Promise<boolean> {
  const client = getNotionClient();
  if (!client || !config.apis.notion.stagingOrgsDbId) return false;

  const normalizedName = name.toLowerCase().trim();

  try {
    // Use contains filter for case-insensitive matching
    const response = await rateLimitedRequest(() =>
      client.databases.query({
        database_id: config.apis.notion.stagingOrgsDbId,
        filter: {
          property: 'Name',
          title: { contains: name },
        },
        page_size: 20,
      })
    );

    // Check for exact match (case-insensitive)
    return response.results.some((page) => {
      if (!isFullPage(page)) return false;
      const props = (page as PageObjectResponse).properties as Record<string, any>;
      const pageName = props['Name']?.title?.[0]?.plain_text?.toLowerCase().trim();
      return pageName === normalizedName;
    });
  } catch (error) {
    console.error('Error checking staging org exists:', error);
    return false;
  }
}
