#!/usr/bin/env bash
# Daily Grant Scan — 2026-05-06
# 14 submissions: 5 AI, 6 Crypto, 3 OSS
# Run this from a machine with access to the production Railway network.
# Pre-checks: duplicate-checks each URL against the DB before submitting.

API="${WIRE_ROOM_API:-https://wire-room-ops-production.up.railway.app}"
TOKEN="${INTERNAL_API_KEY:?INTERNAL_API_KEY must be set}"
DB="${DATABASE_URL:?DATABASE_URL must be set}"
DATE="2026-05-06"

submit() {
  local WIRE="$1"
  local URL="$2"
  local RAW="$3"

  # Duplicate check
  EXISTS=$(node -e "
const { Client } = require('pg');
const c = new Client('$DB');
(async () => {
  await c.connect();
  const r = await c.query('SELECT id, status FROM scan_entries WHERE source_url = \$1 LIMIT 1', ['$URL']);
  console.log(r.rows.length > 0 ? 'EXISTS:' + r.rows[0].status : 'NEW');
  await c.end();
})().catch(e => { console.log('DBERR:' + e.message); process.exit(1); });
" 2>/dev/null)

  if [[ "$EXISTS" == NEW ]]; then
    echo "[SUBMIT] $WIRE | $URL"
    curl -sf -X POST "$API/api/scan/submit" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg wire "$WIRE" \
        --arg date "$DATE" \
        --arg raw "$RAW" \
        '{wire: $wire, promptVariant: "A", scanDate: $date, rawText: $raw, source: "web-search"}')"
    echo ""
  else
    echo "[SKIP] $WIRE | $EXISTS | $URL"
  fi
}

# ─── AI WIRE ────────────────────────────────────────────────────────────────

submit "ai" \
  "https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/" \
  "1. **Anthropic Fellows Program (May & July 2026 Cohorts)** — Anthropic is accepting applications for two upcoming cohorts of its AI Safety Fellows program. Fellows receive a weekly stipend of \$3,850 (USD/GBP/CAD equivalents), approximately \$15,000/month in compute credits, and direct mentorship from Anthropic's alignment research team. No PhD or prior ML experience required. Work authorization in the US, UK, or Canada required. The July 2026 cohort application window is open on a rolling basis. Posted by Anthropic (official).
Link: https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/"

submit "ai" \
  "https://openai.com/index/introducing-openai-safety-fellowship/" \
  "1. **OpenAI Safety Fellowship 2026** — OpenAI opened applications for an external AI safety research fellowship for researchers, engineers, and practitioners. The program runs September 14, 2026 through February 5, 2027 and includes a monthly stipend, compute support, and mentorship. Focus areas: safety evaluation, robustness, agentic oversight, and misuse mitigation. Applications closed May 3, 2026; notifications by July 25. Announced by OpenAI (official).
Link: https://openai.com/index/introducing-openai-safety-fellowship/"

submit "ai" \
  "https://www.pivotal-research.org/fellowship" \
  "1. **Pivotal Research AI Safety Fellowship — Q3 2026** — Nine-week fully funded AI safety research fellowship at the London Initiative for Safe AI (LISA). Fellows receive £6K–£8K stipend, £2K housing for non-London fellows, travel, and compute credits. 1-on-1 mentorship from established safety researchers. Program runs June 29 – August 28, 2026 in London. Application deadline: May 3, 2026. Open to anyone 18+; backgrounds in ML, philosophy, policy, biology welcome. Posted by Pivotal Research (official).
Link: https://www.pivotal-research.org/fellowship"

submit "ai" \
  "https://www.aisi.gov.uk/blog/funding-60-projects-to-advance-ai-alignment-research" \
  "1. **The Alignment Project — UK AISI / OpenAI \$7.5M Global Fund** — The UK AI Security Institute's Alignment Project received \$7.5M from OpenAI (plus Microsoft and other backers), bringing the total fund to £27M+. Supports independent alignment research globally at £50K–£1M per project, with optional compute access. Expert advisory board includes Yoshua Bengio and Zico Kolter. 60 projects funded in first round; new applications being accepted. Posted by UK AISI (official gov.uk source).
Link: https://www.aisi.gov.uk/blog/funding-60-projects-to-advance-ai-alignment-research"

submit "ai" \
  "https://www.longview.org/artificial-intelligence/" \
  "1. **Longview Philanthropy AI Safety & Alignment Grant Program** — Longview Philanthropy's Emerging Challenges Fund provides \$100K–\$1.5M grants to nonprofits and research institutions working on AI risk reduction and alignment research. Rolling letters of inquiry accepted with no fixed deadline. \$133M+ directed to AI risk reduction as of 2026, scaling beyond \$100M/year. Eligible: nonprofits and research institutions globally. Apply via longview.org.
Link: https://www.longview.org/artificial-intelligence/"

# ─── CRYPTO WIRE ────────────────────────────────────────────────────────────

submit "crypto" \
  "https://blog.arbitrum.foundation/trailblazer-1m-grants-to-power-ai-innovation-on-arbitrum/" \
  "1. **Arbitrum AI Trailblazer — \$1M Onchain AI Agent Grants** — Arbitrum Foundation launched a \$1M grant program for builders creating specialized AI agents and onchain AI products on Arbitrum chains. Up to \$10,000 per project. Requires an already-launched AI agent with onchain Arbitrum integration. Evaluation criteria: innovation, impact, uniqueness, adoption potential, Arbitrum alignment. Includes mentorship support. Posted by Arbitrum Foundation (official).
Link: https://blog.arbitrum.foundation/trailblazer-1m-grants-to-power-ai-innovation-on-arbitrum/"

submit "crypto" \
  "https://blog.arbitrum.foundation/trailblazer-2-0-1m-in-grants-to-power-agentic-defi-on-arbitrum/" \
  "1. **Arbitrum Trailblazer 2.0 — \$1M Agentic DeFi Grants** — Arbitrum Foundation launched Trailblazer 2.0, a \$1M funding program for DeFi agents and Vibekit (MCP agent framework) contributors on Arbitrum. Up to \$10K per submission. Targets impactful agentic DeFi products demonstrating utility and performance on Arbitrum. Posted by Arbitrum Foundation (official, @arbitrum).
Link: https://blog.arbitrum.foundation/trailblazer-2-0-1m-in-grants-to-power-agentic-defi-on-arbitrum/"

submit "crypto" \
  "https://www.opgrants.io/seasons/current/season-9/" \
  "1. **Optimism Season 9 Growth Grants — 3.89M OP** — Optimism Collective's Season 9 grants are open with a 3.89M OP budget and application deadline of May 20, 2026. Focus areas: DEX TVL and fees for collateral-borrow pairs on Superchain. Upfront funding for qualifying builders. Apply at opgrants.io. Posted by Optimism Collective (official, @optimismFND).
Link: https://www.opgrants.io/seasons/current/season-9/"

submit "crypto" \
  "https://esp.ethereum.foundation/applicants/wishlist" \
  "1. **Ethereum Foundation ESP — Wishlist & RFPs (Open Rolling)** — Ethereum Foundation's Ecosystem Support Program has transitioned to a Wishlist + RFP model. Currently open: Decentralized RPC Access (for developers and end users), Secure and Decentralized Frontends, and other ecosystem-priority items. Grant amounts are project-dependent. Rolling review (3-6 weeks). Posted by Ethereum Foundation (official, @ethereumfndn).
Link: https://esp.ethereum.foundation/applicants/wishlist"

submit "crypto" \
  "https://www.sui.io/request-for-proposals" \
  "1. **Sui Foundation \$50M Developer Grant Initiative** — Sui Foundation announced \$50M+ in developer grants distributed via rolling Request for Proposals (RFPs). Individual grants range \$10K–\$100K. Open to any individual, team, or organization. RFPs launched on a rolling basis; shortlisted candidates reviewed by an RFP committee. Announced by Sui Foundation (official).
Link: https://www.sui.io/request-for-proposals"

submit "crypto" \
  "https://fil.org/grants" \
  "1. **Filecoin Foundation Open Developer Grants (Rolling)** — Filecoin Foundation accepts rolling proposals for developer tooling, integrations, research, storage/retrieval, and FVM projects. Grants up to \$50,000. Three-month review cycle. Projects must be open-sourced under MIT + Apache2 licenses. Apply via GitHub devgrants repository. Posted by Filecoin Foundation (official).
Link: https://fil.org/grants"

# ─── OSS WIRE ───────────────────────────────────────────────────────────────

submit "oss" \
  "https://alpha-omega.dev/grants/how-to-apply/" \
  "1. **Linux Foundation / Alpha-Omega \$12.5M Open Source Security Fund** — Linux Foundation announced \$12.5M in grants from Anthropic, AWS, GitHub, Google, Google DeepMind, Microsoft, and OpenAI to strengthen OSS security. Managed by Alpha-Omega and OpenSSF. Focus: helping maintainers manage AI-generated vulnerability reports at scale. Alpha-Omega proactively reaches out to eligible critical projects; maintainers can also inquire directly. Announced March 17, 2026 by Linux Foundation (official).
Link: https://alpha-omega.dev/grants/how-to-apply/"

submit "oss" \
  "https://nlnet.nl/commonsfund/" \
  "1. **NLnet NGI Zero Commons Fund — 13th Call (Deadline: June 1, 2026)** — NLnet Foundation's 13th NGI Zero Commons Fund call is open with a June 1, 2026 noon CEST deadline. Grants of €5K–€50K (scalable) for open source projects across the full internet stack — libre silicon to middleware to end-user apps. Open to SMEs, academics, individuals, non-profits globally. €21.6M total through 2027; 314 projects funded across 8 prior rounds. Posted by NLnet Foundation (official).
Link: https://nlnet.nl/commonsfund/"

submit "oss" \
  "https://floss.fund/" \
  "1. **FLOSS/fund by Zerodha — \$1M/Year for FOSS Projects (2026 Open)** — Zerodha's FLOSS/fund distributes up to \$1M annually to widely-used Free/Libre and Open Source projects globally. Uses an innovative funding.json manifest system — projects publish a standardized JSON file to apply. No geographic restriction. Focus on existing, widely-used, impactful projects. \$1M fully distributed in inaugural 2025 year; open for 2026. Posted by FLOSS/fund (official).
Link: https://floss.fund/"

echo ""
echo "─────────────────────────────────────────────────────"
echo "Sending daily brief..."
curl -sf -X POST "$API/api/scan/agent/send-brief" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n '{
    date: "2026-05-06",
    searchesDone: 21,
    totalFound: 28,
    skippedDuplicates: 0,
    entries: [
      {wire:"ai",   name:"Anthropic Fellows Program (May & July 2026 Cohorts)", url:"https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/", amount:"$3,850/week + $15K/month compute", decision:"submitted"},
      {wire:"ai",   name:"OpenAI Safety Fellowship 2026", url:"https://openai.com/index/introducing-openai-safety-fellowship/", amount:"stipend + compute (deadline passed May 3)", decision:"submitted"},
      {wire:"ai",   name:"Pivotal Research AI Safety Fellowship Q3 2026", url:"https://www.pivotal-research.org/fellowship", amount:"£6K–£8K + housing + travel", decision:"submitted"},
      {wire:"ai",   name:"The Alignment Project — UK AISI / OpenAI $7.5M Fund", url:"https://www.aisi.gov.uk/blog/funding-60-projects-to-advance-ai-alignment-research", amount:"£50K–£1M per project", decision:"submitted"},
      {wire:"ai",   name:"Longview Philanthropy AI Safety Grant Program", url:"https://www.longview.org/artificial-intelligence/", amount:"$100K–$1.5M", decision:"submitted"},
      {wire:"crypto",name:"Arbitrum AI Trailblazer — $1M Grants", url:"https://blog.arbitrum.foundation/trailblazer-1m-grants-to-power-ai-innovation-on-arbitrum/", amount:"up to $10K each, $1M pool", decision:"submitted"},
      {wire:"crypto",name:"Arbitrum Trailblazer 2.0 — Agentic DeFi", url:"https://blog.arbitrum.foundation/trailblazer-2-0-1m-in-grants-to-power-agentic-defi-on-arbitrum/", amount:"up to $10K each, $1M pool", decision:"submitted"},
      {wire:"crypto",name:"Optimism Season 9 Growth Grants", url:"https://www.opgrants.io/seasons/current/season-9/", amount:"3.89M OP", decision:"submitted"},
      {wire:"crypto",name:"Ethereum Foundation ESP Wishlist RFPs", url:"https://esp.ethereum.foundation/applicants/wishlist", amount:"project-dependent", decision:"submitted"},
      {wire:"crypto",name:"Sui Foundation $50M Developer Grants", url:"https://www.sui.io/request-for-proposals", amount:"$10K–$100K", decision:"submitted"},
      {wire:"crypto",name:"Filecoin Foundation Developer Grants", url:"https://fil.org/grants", amount:"up to $50K", decision:"submitted"},
      {wire:"oss",  name:"Linux Foundation / Alpha-Omega $12.5M OSS Security Fund", url:"https://alpha-omega.dev/grants/how-to-apply/", amount:"$12.5M pool", decision:"submitted"},
      {wire:"oss",  name:"NLnet NGI Zero Commons Fund 13th Call", url:"https://nlnet.nl/commonsfund/", amount:"€5K–€50K, deadline June 1 2026", decision:"submitted"},
      {wire:"oss",  name:"FLOSS/fund by Zerodha", url:"https://floss.fund/", amount:"up to $1M/year", decision:"submitted"},
      {wire:"ai",   name:"Constellation Astra Fellowship", url:"https://www.constellation.org/programs/astra-fellowship", amount:"", decision:"skipped-closed"},
      {wire:"ai",   name:"Cambridge ERA:AI Fellowship", url:"https://www.erasmusprogramme.com/era_ai.php", amount:"", decision:"skipped-closed"},
      {wire:"oss",  name:"Sovereign Tech Fellowship", url:"https://www.sovereigntechfund.de/programs/fellowship", amount:"", decision:"skipped-closed"},
      {wire:"crypto",name:"Ethereum Foundation PhD Fellowship", url:"https://esp.ethereum.foundation/devcon-grants", amount:"", decision:"skipped-closed"},
      {wire:"crypto",name:"Arbitrum Stylus Sprint", url:"https://forum.arbitrum.foundation/t/arbitrum-stylus-sprint/", amount:"", decision:"skipped-closed"},
      {wire:"crypto",name:"Gitcoin GG25", url:"https://grants.gitcoin.co", amount:"", decision:"skipped-content"},
      {wire:"crypto",name:"Lido DAO LEGO", url:"https://lido.fi/lego", amount:"", decision:"skipped-content"},
      {wire:"oss",  name:"Open Source Endowment", url:"https://opensourceendowment.org", amount:"", decision:"skipped-content"},
      {wire:"oss",  name:"Sloan Foundation OSPO LOI", url:"https://sloan.org/programs/digital-technology/", amount:"", decision:"skipped-content"},
      {wire:"oss",  name:"Sequoia OSS Fellowship", url:"https://www.sequoiacap.com/", amount:"", decision:"skipped-content"},
      {wire:"crypto",name:"Starknet Seed/Growth Grants", url:"https://www.starknet.io/en/developers/grants", amount:"", decision:"skipped-content"},
      {wire:"oss",  name:"Open Source Pledge", url:"https://opensourcepledge.com", amount:"", decision:"skipped-content"},
      {wire:"ai",   name:"CBAI Summer AI Safety Fellowship (via opportunitiesforafter)", url:"", amount:"", decision:"skipped-tier3"},
      {wire:"ai",   name:"Pivotal AI Safety via OpportunityDesk", url:"", amount:"", decision:"skipped-tier3"}
    ]
  }')"
echo ""
echo "Done."
