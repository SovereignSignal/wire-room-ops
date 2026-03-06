/**
 * Twitter/X posting via twitter-api-v2.
 * Credentials are passed in (from distribution_config JSONB per wire).
 */

import { TwitterApi } from 'twitter-api-v2';

export interface XCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

interface TweetResult {
  id: string;
  url: string;
}

export async function postTweet(
  text: string,
  credentials: XCredentials
): Promise<TweetResult | null> {
  try {
    const client = new TwitterApi({
      appKey: credentials.appKey,
      appSecret: credentials.appSecret,
      accessToken: credentials.accessToken,
      accessSecret: credentials.accessSecret,
    });

    const result = await client.v2.tweet(text);
    const tweetId = result.data.id;

    // Build the tweet URL — we don't have the handle readily so use x.com/i/status
    return {
      id: tweetId,
      url: `https://x.com/i/status/${tweetId}`,
    };
  } catch (error) {
    console.error('[X] Tweet failed:', error);
    return null;
  }
}
