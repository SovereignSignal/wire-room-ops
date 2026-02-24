/**
 * X (Twitter) API v2 posting client.
 *
 * Uses twitter-api-v2 with OAuth 1.0a (User Context) to post tweets.
 * Lazy client instantiation per wire — returns null if credentials are missing.
 */

import { TwitterApi } from 'twitter-api-v2';

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

// Cache instantiated clients per wire
const clients = new Map<string, TwitterApi>();

export function clearClientCache(wire: string): void {
  clients.delete(wire);
}

function getClient(wire: string, creds: XCredentials): TwitterApi {
  const cached = clients.get(wire);
  if (cached) return cached;

  const client = new TwitterApi({
    appKey: creds.apiKey,
    appSecret: creds.apiSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessTokenSecret,
  });

  clients.set(wire, client);
  return client;
}

export async function postTweet(
  wire: string,
  text: string,
  creds?: XCredentials,
  handle?: string,
): Promise<{ tweetId: string; url: string } | null> {
  if (!creds || !creds.apiKey || !creds.apiSecret || !creds.accessToken || !creds.accessTokenSecret) {
    console.log(`[X] No credentials configured for wire "${wire}", skipping`);
    return null;
  }

  const client = getClient(wire, creds);
  const result = await client.v2.tweet(text);
  const tweetId = result.data.id;
  const xHandle = handle || wire;
  const url = `https://x.com/${xHandle}/status/${tweetId}`;

  console.log(`[X] Posted tweet for wire "${wire}": ${url}`);
  return { tweetId, url };
}
