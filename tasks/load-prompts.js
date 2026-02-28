#!/usr/bin/env node
/**
 * load-prompts.js — Load all 9 scan prompts into wire-room-ops database
 * 
 * Usage:
 *   DATABASE_URL="postgresql://..." node tasks/load-prompts.js
 * 
 * Get DATABASE_URL from Railway dashboard → wire-room-ops → Variables
 * Run from the wire-room-ops repo root.
 */

const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable required');
  console.error('   Get it from Railway → wire-room-ops → Variables tab');
  console.error('   Usage: DATABASE_URL="postgresql://..." node tasks/load-prompts.js');
  process.exit(1);
}

const prompts = [
  {
    wire: 'crypto',
    variant: 'A',
    label: 'Crypto A — Action Scan',
    sortOrder: 0,
    toolType: 'x_search',
    promptText: `Scan X for crypto grant and funding announcements from the last 7 days. Run each query separately, deduplicate, and return everything that looks like a real program or funding announcement.

Queries:
1. "grants round" OR "grants program" OR "ecosystem fund"
2. "retro funding" OR "retroactive funding" OR "public goods funding"
3. crypto "developer grants" OR "builder grants" OR "bounty program"
4. crypto OR DAO "grants council" OR "grants committee"
5. crypto grants "apply" OR "deadline" OR "applications open"
6. crypto OR web3 "grant applications" OR "funding available" OR "accepting proposals"
7. "hackathon" crypto OR web3 OR blockchain "prize" OR "register" OR "submit"

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, "follow me" / "DM me" / "check my bio" / "giveaway" / "airdrop" / "whitelist" / "free mint", VC fundraising (Series A/B/C), job postings, generic commentary with no specific program.

Do NOT over-filter. If it looks like it might be a real program or funding announcement, include it. The operator does final filtering.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'crypto',
    variant: 'B',
    label: 'Crypto B — Landscape Scan',
    sortOrder: 1,
    toolType: 'x_search',
    promptText: `Scan X for crypto grant ecosystem activity from the last 7 days. This scan tracks specific ecosystems and programs by name, plus catches funding results and awards. Run each query separately, deduplicate, return everything relevant.

Queries:
1. Optimism grants OR "retro funding" OR "growth grants"
2. Arbitrum grants OR STIP OR LTIPP
3. "Uniswap Foundation" OR "Uniswap grants"
4. "ENS DAO" grants OR funding
5. Gitcoin grants OR "grants round"
6. "Ethereum Foundation" grants OR ESP
7. Polygon OR Scroll OR Filecoin OR Celo grants OR "ecosystem fund"
8. Aave OR Compound OR MakerDAO OR Lido grants OR treasury
9. "Protocol Guild" OR Stacks OR RGB grants OR bounty
10. crypto OR blockchain grant "awarded" OR "received" OR "funded" OR "selected"
11. crypto "treasury proposal" OR "budget approved" OR "funding allocated"

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, token price discussion, trading or chart analysis, VC raises, job postings, anything older than 7 days.

Do NOT over-filter. A tweet saying "Retro Funding Round 7 results are out" or "just received an Arbitrum grant" is exactly what we want even if it doesn't say "apply." Include borderline cases. The operator filters.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'crypto',
    variant: 'C',
    label: 'Crypto C — Open Sweep',
    sortOrder: 2,
    toolType: 'x_search',
    promptText: `Scan X broadly for any crypto grant, ecosystem fund, or public goods funding activity from the last 7 days that a grants professional should know about.

Do not limit yourself to specific programs or organizations. Search organically across X for:

- New grant programs or funds launching from any org, known or unknown
- Funding announcements from protocols, DAOs, or foundations not commonly covered
- Emerging ecosystems or chains announcing builder incentives for the first time
- Public goods funding experiments or new funding models
- Grant program retrospectives, results, or post-mortems
- Any organization distributing money to builders, developers, or researchers in crypto
- New grant councils, committees, or steward elections being announced
- Cross-chain or multi-ecosystem funding initiatives
- Lesser known L1s and L2s launching grant programs

Do not use a fixed query list. Search organically using your understanding of the crypto grants landscape. Think about what a well-connected grants professional would want to know this week that they might not already be tracking.

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, "follow me" / "DM me" / "giveaway" / "airdrop" / "whitelist" / "free mint", VC fundraising (Series A/B/C), job postings, token price or trading discussion, anything older than 7 days.

Cast the widest possible net. The operator will filter. If you find something from an org or program not previously on our radar, that is especially valuable. Flag anything that feels new or emerging.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'ai',
    variant: 'A',
    label: 'AI A — Action Scan',
    sortOrder: 0,
    toolType: 'x_search',
    promptText: `Scan X for AI and machine learning funding opportunities from the last 7 days. Fellowships, grants, hackathons, compute programs, accelerators, government funding. Run each query separately, deduplicate, return everything relevant.

Queries:
1. "AI fellowship" OR "ML fellowship" OR "research fellowship" AI
2. "compute credits" OR "compute grant" OR "GPU grant" OR "API credits"
3. "AI hackathon" OR "LLM hackathon" OR "AI challenge" OR "ML competition"
4. "AI accelerator" OR "ML accelerator" OR "AI incubator"
5. "AI safety" grant OR funding OR fellowship
6. "AI grant" OR "machine learning grant"
7. AI OR "machine learning" grant OR fellowship "apply" OR "deadline" OR "applications open"
8. AI OR "artificial intelligence" "open call" OR "request for proposals" OR "RFP"
9. "AI scholarship" OR "AI residency" OR "AI research program"
10. AI "prize" OR "award" OR "competition" submit OR register OR apply

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, medical or clinical or nursing fellowships, VC fundraising, job postings ("we're hiring"), product launches, stock or earnings discussion, generic AI commentary with no specific program, anything older than 7 days.

Do NOT over-filter. The AI space is active right now. If a post mentions any kind of AI funding opportunity, fellowship, hackathon, or program, include it. The operator does final filtering.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'ai',
    variant: 'B',
    label: 'AI B — Landscape Scan',
    sortOrder: 1,
    toolType: 'x_search',
    promptText: `Scan X for AI funding activity from the last 7 days. This scan covers government and institutional AI programs, regional AI funding, corporate research programs, and AI funding results. Run each query separately, deduplicate, return everything relevant.

Queries:
1. DARPA AI OR "artificial intelligence" OR "machine learning" program OR award OR solicitation
2. NSF AI OR "artificial intelligence" grant OR award OR funding
3. "EU" OR "European" AI grant OR fellowship OR program OR funding
4. "UK" AI fellowship OR grant OR program OR research
5. "India" AI fellowship OR grant OR hackathon OR challenge
6. "AI residency" OR "AI postdoc" OR "visiting researcher" AI
7. "compute credits" OR "GPU access" OR "cloud credits" AI OR research OR startup
8. "AI safety" OR "alignment" grant OR funded OR fellowship OR program
9. AI OR "machine learning" grant "awarded" OR "received" OR "funded" OR "results"
10. AI fellowship OR scholarship "fully funded" OR "deadline" OR "apply"
11. "responsible AI" OR "AI ethics" grant OR fellowship OR funding
12. "AI for good" OR "AI for health" OR "AI for education" grant OR program OR challenge

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, medical or clinical or nursing fellowships, VC fundraising, job postings, product launches, stock or earnings discussion, generic AI commentary with no specific program, anything older than 7 days.

Do NOT over-filter. This scan catches what the Action Scan misses: government programs, regional opportunities, research positions, and funding outcomes. Include borderline cases. The operator filters.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'ai',
    variant: 'C',
    label: 'AI C — Open Sweep',
    sortOrder: 2,
    toolType: 'x_search',
    promptText: `Scan X broadly for any AI or machine learning funding, fellowship, grant, hackathon, compute program, or research funding activity from the last 7 days that someone tracking AI funding should know about.

Do not limit yourself to specific programs or organizations. Search organically across X for:

- New AI funding programs from any organization, government, or foundation
- Fellowship or scholarship announcements from universities, labs, or nonprofits
- Compute credit or GPU access programs from any provider
- AI hackathons, challenges, or competitions with prizes from any organizer
- Government AI funding from any country, not just US
- Corporate AI research programs, residencies, or grants from any company
- AI safety and alignment funding from any source
- New AI accelerators or incubators opening applications
- Philanthropic or nonprofit AI funding initiatives
- Regional AI funding programs (Africa, Asia, Europe, Latin America, Middle East)
- Any organization offering money, compute, or resources to people building or researching AI

Do not use a fixed query list. Search organically. The AI funding landscape is expanding fast and new programs launch constantly. Think about what someone running an AI grants newsletter would want to know this week.

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, medical or clinical fellowships, VC fundraising with no grant component, job postings ("we're hiring"), product launches, stock or earnings discussion, generic AI commentary with no specific program or funding, anything older than 7 days.

Cast the widest possible net. The operator will filter. If you find programs or funders not commonly discussed in Western tech circles, that is especially valuable.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'oss',
    variant: 'A',
    label: 'OSS A — Action Scan',
    sortOrder: 0,
    toolType: 'x_search',
    promptText: `Scan X for open source software funding opportunities from the last 7 days. Foundation grants, maintainer funding, corporate OSS programs, security audit funding, fellowships, hackathons. Run each query separately, deduplicate, return everything relevant.

Queries:
1. "open source" grant OR funding OR fellowship OR sponsorship
2. "maintainer" funding OR grant OR stipend
3. "FOSS" OR "free software" grant OR funding OR bounty
4. "open source" "apply" OR "deadline" OR "applications open" grant OR fellowship
5. "open source" bounty OR "bug bounty" OR "security audit"
6. "GSoC" OR "Google Summer of Code" OR "Outreachy" OR "Season of Docs"
7. "open source" hackathon OR sprint OR "contributor event"
8. "NGI" OR "Next Generation Internet" grant OR funding
9. "open source" "maintainer support" OR "developer funding" OR "contributor funding"
10. "digital public goods" OR "public digital infrastructure" grant OR funding

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, pure crypto grants with no OSS component, pure AI grants with no OSS component, VC fundraising, job postings, product launches, proprietary software, anything older than 7 days.

Do NOT over-filter. OSS volume on X is naturally lower than crypto or AI. A week with 5 to 10 results is a good week. If it touches open source funding in any way, include it.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'oss',
    variant: 'B',
    label: 'OSS B — Landscape Scan',
    sortOrder: 1,
    toolType: 'x_search',
    promptText: `Scan X for open source funding ecosystem activity from the last 7 days. This scan tracks specific OSS funders and foundations by name, plus catches grants awarded, projects funded, and maintainer funding news. Run each query separately, deduplicate, return everything relevant.

Queries:
1. "Sovereign Tech Fund" OR "STF"
2. "NLnet" OR "NLnet Foundation"
3. "Open Technology Fund" OR "OTF"
4. "OpenSSF" OR "Alpha-Omega" OR "OSTIF"
5. "Linux Foundation" grant OR funding OR travel OR scholarship
6. "NumFOCUS" OR "Software Freedom Conservancy"
7. "Mozilla Foundation" OR "Ford Foundation" open source
8. "GitHub Sponsors" OR "FOSS Fund" OR "Open Collective" open source
9. open source OR FOSS "funded by" OR "grant from" OR "received funding"
10. open source OR FOSS OR maintainer "awarded" OR "selected" OR "accepted" grant OR fellowship
11. "Sovereign Tech" OR NLnet OR OTF OR OpenSSF funded OR project OR audit

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, pure crypto grants, pure AI grants, VC fundraising, job postings, product launches, proprietary software, anything older than 7 days.

Do NOT over-filter. OSS funding orgs don't post on X every day. But when NLnet announces a new batch of funded projects or Sovereign Tech Fund tweets about a grant, that is high value signal. Include anything mentioning these orgs in a funding context. The operator filters.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
  {
    wire: 'oss',
    variant: 'C',
    label: 'OSS C — Open Sweep',
    sortOrder: 2,
    toolType: 'x_search',
    promptText: `Scan X broadly for any open source software funding, grants, sponsorships, maintainer support, or related activity from the last 7 days that someone tracking OSS funding should know about.

Do not limit yourself to specific foundations or programs. Search organically across X for:

- New OSS grant programs from any foundation, company, or government
- Maintainer funding stories: someone receiving funding, launching a sponsor page, or getting corporate backing
- Corporate open source programs or contributions from any company
- Open source security funding, audit programs, or vulnerability bounties from any source
- OSS hackathons, sprints, or contributor events
- Government open source mandates or funding from any country
- New fiscal sponsorship arrangements or Open Collective campaigns
- Open source sustainability discussions that reference specific funding
- University or research institution open source funding programs
- Digital public goods or public digital infrastructure funding
- Open data, open hardware, or open science funding with software components
- Any organization putting money toward open source development or maintenance

Do not use a fixed query list. Search organically. OSS funding is spread across many small and mid-size organizations, and new sources appear regularly. Think about what someone running an OSS grants newsletter would want to know this week.

Last 7 days only.

Exclude: replies, retweets without context, posts under 80 characters, engagement farming, pure crypto grants with no OSS component, pure AI grants with no OSS component, VC fundraising, job postings, product launches, proprietary software, anything older than 7 days.

Cast the widest possible net. The operator will filter. OSS funding volume on X is lower than other verticals, so every real signal matters. If you find a funder or program that is not well known, that is especially valuable.

For each result:
[Account] — [Short description]
[Full tweet text]
[Post URL]
[Date]`,
  },
];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Ensure scan_prompts table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS scan_prompts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wire TEXT NOT NULL,
        label TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        response_format TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        variant TEXT,
        tool_type TEXT NOT NULL DEFAULT 'x_search',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Check existing prompts
    const { rows: existing } = await client.query('SELECT label FROM scan_prompts');
    const existingLabels = new Set(existing.map(r => r.label));
    console.log(`\nExisting prompts: ${existing.length}`);
    if (existing.length > 0) {
      existing.forEach(r => console.log(`  - ${r.label}`));
    }

    let inserted = 0;
    let skipped = 0;

    for (const p of prompts) {
      if (existingLabels.has(p.label)) {
        console.log(`⏭️  Skipping (already exists): ${p.label}`);
        skipped++;
        continue;
      }

      await client.query(
        `INSERT INTO scan_prompts (wire, label, prompt_text, response_format, is_active, sort_order, variant, tool_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p.wire, p.label, p.promptText, '', true, p.sortOrder, p.variant, p.toolType]
      );
      console.log(`✅ Loaded: ${p.label}`);
      inserted++;
    }

    console.log(`\n✅ Done. ${inserted} prompts loaded, ${skipped} skipped.`);
    console.log('\nNext step: Open the dashboard and verify all 9 prompts appear in Prompt Management.');
    console.log('Then test one: POST /api/scan/prompts/:id/test (takes 60-90s)');

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
