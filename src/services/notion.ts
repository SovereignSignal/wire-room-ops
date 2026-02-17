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

const RATE_LIMIT_DELAY_MS = 350;
let lastRequestTime = 0;

async function rateLimitedRequest<T>(fn: () => Promise<T>): Promise<Awaited<T>> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_DELAY_MS) {
    await sleep(RATE_LIMIT_DELAY_MS - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
  const result = await fn();
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
