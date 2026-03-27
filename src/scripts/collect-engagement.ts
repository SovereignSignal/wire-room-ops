/**
 * Engagement Metrics Collector
 *
 * Queries distribution_logs for published entries within an age window,
 * fetches X public_metrics via Twitter API v2, and stores results in
 * the engagement_metrics table.
 *
 * Usage:
 *   npx ts-node src/scripts/collect-engagement.ts --age-min=4 --age-max=8
 *
 * Requires X_BEARER_TOKEN env var.
 */

import { Pool } from 'pg';
import { config } from '../config';
import { sleep } from '../utils/async';

// ============================================================
// Pool
// ============================================================

function createPool(): Pool {
  return new Pool({
    connectionString: config.database.url,
    ssl: config.database.url.includes('localhost') ? false : {
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

// ============================================================
// Engagement Score
// ============================================================

interface PublicMetrics {
  impression_count: number;
  like_count: number;
  retweet_count: number;
  reply_count: number;
  quote_count: number;
  bookmark_count: number;
}

function computeEngagementScore(m: PublicMetrics): number {
  return Math.min(100,
    (m.like_count * 3) +
    (m.retweet_count * 5) +
    (m.reply_count * 4) +
    (m.quote_count * 6) +
    (m.bookmark_count * 2) +
    Math.log10(Math.max(1, m.impression_count)) * 2
  );
}

// ============================================================
// Twitter API v2
// ============================================================

interface TweetData {
  id: string;
  public_metrics?: PublicMetrics;
}

interface TwitterResponse {
  data?: TweetData[];
  errors?: Array<{ detail: string }>;
}

async function fetchTweetMetrics(tweetIds: string[], bearerToken: string): Promise<TweetData[]> {
  const ids = tweetIds.join(',');
  const url = `https://api.twitter.com/2/tweets?ids=${ids}&tweet.fields=public_metrics`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Engagement] Twitter API error ${response.status}: ${text}`);
    return [];
  }

  const json = await response.json() as TwitterResponse;

  if (json.errors) {
    for (const err of json.errors) {
      console.warn(`[Engagement] Twitter API warning: ${err.detail}`);
    }
  }

  return json.data || [];
}

// ============================================================
// Main Collection
// ============================================================

interface DistributionRow {
  entry_id: number;
  external_id: string;
  posted_at: Date;
  wire: string;
}

export async function collectXEngagement(pool: Pool, ageMinHours: number, ageMaxHours: number): Promise<number> {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) {
    console.error('[Engagement] X_BEARER_TOKEN not set, skipping X engagement collection');
    return 0;
  }

  // Find distributed entries within the age window
  const entries = await pool.query<DistributionRow>(`
    SELECT DISTINCT ON (dl.entry_id)
      dl.entry_id,
      dl.external_id,
      dl.created_at as posted_at,
      dl.wire
    FROM distribution_logs dl
    WHERE dl.channel = 'x'
      AND dl.status = 'success'
      AND dl.external_id IS NOT NULL
      AND dl.created_at BETWEEN NOW() - make_interval(hours => $1)
                             AND NOW() - make_interval(hours => $2)
  `, [ageMaxHours, ageMinHours]);

  if (entries.rows.length === 0) {
    console.log(`[Engagement] No X posts found in ${ageMinHours}-${ageMaxHours}h window`);
    return 0;
  }

  console.log(`[Engagement] Found ${entries.rows.length} X posts to check`);

  const batchSize = 100;
  let collected = 0;

  for (let i = 0; i < entries.rows.length; i += batchSize) {
    const batch = entries.rows.slice(i, i + batchSize);
    const tweetIds = batch.map(r => r.external_id);

    const tweets = await fetchTweetMetrics(tweetIds, bearerToken);

    for (const tweet of tweets) {
      const entry = batch.find(r => r.external_id === tweet.id);
      if (!entry || !tweet.public_metrics) continue;

      const m = tweet.public_metrics;
      const ageHours = (Date.now() - new Date(entry.posted_at).getTime()) / 3600000;
      const engagementScore = computeEngagementScore(m);

      try {
        await pool.query(`
          INSERT INTO engagement_metrics
            (entry_id, channel, wire, external_id, impressions, likes, retweets,
             replies, quotes, bookmarks, engagement_score, measured_at, post_age_hours)
          VALUES ($1, 'x', $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
          ON CONFLICT (entry_id, channel, measured_at) DO NOTHING
        `, [
          entry.entry_id, entry.wire, tweet.id,
          m.impression_count, m.like_count, m.retweet_count,
          m.reply_count, m.quote_count, m.bookmark_count,
          engagementScore, ageHours,
        ]);
        collected++;
      } catch (err) {
        console.error(`[Engagement] Failed to store metrics for entry ${entry.entry_id}:`, err);
      }
    }

    // Rate limiting: 1 second between batches
    if (i + batchSize < entries.rows.length) await sleep(1000);
  }

  return collected;
}

// ============================================================
// CLI Entry Point
// ============================================================

function parseArgs(): { ageMin: number; ageMax: number } {
  const args = process.argv.slice(2);
  let ageMin = 4;
  let ageMax = 8;

  for (const arg of args) {
    const [key, val] = arg.split('=');
    if (key === '--age-min') ageMin = parseInt(val, 10);
    if (key === '--age-max') ageMax = parseInt(val, 10);
  }

  return { ageMin, ageMax };
}

async function main() {
  const { ageMin, ageMax } = parseArgs();
  console.log(`[Engagement] Collecting X metrics for posts ${ageMin}-${ageMax}h old`);

  const pool = createPool();

  try {
    const count = await collectXEngagement(pool, ageMin, ageMax);
    console.log(`[Engagement] Collected ${count} metric records`);
  } catch (err) {
    console.error('[Engagement] Collection failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
