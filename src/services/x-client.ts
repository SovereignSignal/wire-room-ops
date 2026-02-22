/**
 * X (Twitter) API v2 posting client.
 *
 * Uses twitter-api-v2 with OAuth 1.0a (User Context) to post tweets.
 * Lazy client instantiation per wire — returns null if credentials are missing.
 */

import { TwitterApi } from 'twitter-api-v2';
import { config } from '../config';

// Cache instantiated clients per wire
const clients = new Map<string, TwitterApi>();

function getXCredentials(wire: string): { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string } | null {
  const wireConfig = (config.distribution.x as Record<string, { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string }>)[wire];
  if (!wireConfig) return null;

  const { apiKey, apiSecret, accessToken, accessTokenSecret } = wireConfig;
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) return null;

  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

function getClient(wire: string): TwitterApi | null {
  const cached = clients.get(wire);
  if (cached) return cached;

  const creds = getXCredentials(wire);
  if (!creds) return null;

  const client = new TwitterApi({
    appKey: creds.apiKey,
    appSecret: creds.apiSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessTokenSecret,
  });

  clients.set(wire, client);
  return client;
}

export async function postTweet(wire: string, text: string): Promise<{ tweetId: string; url: string } | null> {
  const client = getClient(wire);
  if (!client) {
    console.log(`[X] No credentials configured for wire "${wire}", skipping`);
    return null;
  }

  const result = await client.v2.tweet(text);
  const tweetId = result.data.id;
  // Derive URL from the wire's X handle — fallback to generic
  const handleMap: Record<string, string> = {
    crypto: 'CryptoGrantWire',
    ai: 'AIGrantWire',
    oss: 'OSSGrantWire',
  };
  const handle = handleMap[wire] || wire;
  const url = `https://x.com/${handle}/status/${tweetId}`;

  console.log(`[X] Posted tweet for wire "${wire}": ${url}`);
  return { tweetId, url };
}
