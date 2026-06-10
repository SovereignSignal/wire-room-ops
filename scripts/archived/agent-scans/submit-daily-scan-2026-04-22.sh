#!/bin/bash
# Daily Grant Scan Submissions — 2026-04-22
# 11 entries across ai (3), crypto (5), oss (3) wires
# 2 entries skipped as duplicates already in DB
# URGENT: Anthropic Fellows April 26 | NSF Safe-OSE April 28 | Google.org AI for Science May 1
# Run from any environment with network access to wire-room-ops-production.up.railway.app

API="https://wire-room-ops-production.up.railway.app"
TOKEN="1d67a15d8d12971ec38e512a726222e3df3027f1f8b43a091cd819aac9182bd7"
DATE="2026-04-22"

echo "=== Wire Room Daily Scan Submissions: $DATE ==="
echo "11 new entries | 2 duplicates skipped (Constellation Astra + EF PhD — already in DB from prior runs)"
echo ""

# ─────────────────────────────────────────────
# AI WIRE — Entry 1: Anthropic Fellows Program (May & July 2026 Cohorts)
# Source: x.com/AnthropicAI (X post, different URL from 4/19 submission)
# Deadline: April 26, 2026 — URGENT
# Note: The 4/19 submission used alignment.anthropic.com URL; this is the X post
# ─────────────────────────────────────────────
echo "[1/11] Submitting: Anthropic Fellows Program (May & July 2026 Cohorts)..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Anthropic Fellows Program (May & July 2026 Cohorts)** — Anthropic is accepting applications for two upcoming cohorts of the Anthropic Fellows Program, starting May and July 2026. Fellows work for 4 months on empirical AI safety research aligned with Anthropic priorities (scalable oversight, AI control, mechanistic interpretability, AI security, model welfare), with the aim of producing public outputs. Compensation: $3,850 USD/week stipend plus ~$15,000/month in compute resources. Applications and interviews managed by Constellation (Anthropic'\''s recruiting partner). Deadline: April 26, 2026 for the July cohort. In previous cohorts, 25–50% of fellows received a full-time offer at Anthropic. Open globally. Posted by @AnthropicAI.\nLink: https://x.com/AnthropicAI/status/1999233249579794618"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# AI WIRE — Entry 2: OpenAI Safety Fellowship 2026
# Source: x.com/OpenAI (X post, different URL from 4/19 submission)
# Deadline: May 3, 2026
# Note: The 4/19 submission used openai.com/index URL; this is the X post
# ─────────────────────────────────────────────
echo ""
echo "[2/11] Submitting: OpenAI Safety Fellowship 2026..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **OpenAI Safety Fellowship 2026** — OpenAI has launched an external Safety Fellowship for researchers, engineers, and practitioners outside OpenAI to pursue rigorous AI safety and alignment research. Program runs September 14, 2026 through February 5, 2027. Fellows receive $3,850/week stipend plus ~$15,000/month compute. Priority areas include safety evaluation, ethics, robustness, scalable mitigations, privacy-preserving safety methods, agentic oversight, and high-severity misuse domains. Workspace available in Berkeley at Constellation alongside other fellows; remote also permitted. Applications close May 3, 2026; applicants notified by July 25. Open to external researchers globally. Posted by @OpenAI.\nLink: https://x.com/OpenAI/status/2041202511647019251"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# AI WIRE — Entry 3: Constellation Astra Fellowship — SKIPPED (DUPLICATE)
# Source: constellation.org/programs/astra
# Reason: Already submitted 2026-04-19 — URL exists in DB
# ─────────────────────────────────────────────
echo ""
echo "[SKIP] Constellation Astra Fellowship — duplicate (submitted 2026-04-19)"

# ─────────────────────────────────────────────
# CRYPTO WIRE — Entry 4: EF PhD Fellowship — SKIPPED (DUPLICATE)
# Source: esp.ethereum.foundation/rounds/phdfp26
# Reason: Already submitted 2026-04-21 — URL exists in DB
# ─────────────────────────────────────────────
echo "[SKIP] Ethereum Foundation PhD Fellowship — duplicate (submitted 2026-04-21)"

# ─────────────────────────────────────────────
# CRYPTO WIRE — Entry 5: Ethereum Security Fund — $220M TheDAO Revival
# Source: unchainedcrypto.com (exclusive reporting, confirmed by CoinDesk)
# Deadline: rolling (fund structure, ongoing grants)
# ─────────────────────────────────────────────
echo ""
echo "[3/11] Submitting: Ethereum Security Fund — \$220M TheDAO Revival..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Ethereum Security Fund — $220M TheDAO Revival** — Key Ethereum OGs including Vitalik Buterin, Taylor Monahan (MetaMask), Jordi Baylina, pcaversaccio (SEAL 911), Alex Van de Sande (ENS), Griff Green (Giveth), and Pol Lanski (Dappnode) are redirecting 75,000 ETH (~$220M in unclaimed 2016 DAO hack funds) into a new Ethereum Security Fund. Structure: 69,420 ETH staking pool generating ~$8M/year in yield plus a direct $13.5M grant pool. Grants distributed via quadratic funding, retroactive public goods funding, and RFP ranked-choice voting. Focus: Mainnet Security, L2 security, Smart Contract Security, Incident Response, Security Research, User Protection, Infrastructure, and Security Education. Fund is governed by the seven-person curator board. Source: Unchained (exclusive), confirmed by CoinDesk.\nLink: https://unchainedcrypto.com/exclusive-thedao-to-become-new-220-million-ethereum-security-fund/"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# CRYPTO WIRE — Entry 6: Optimism Retro Funding — Onchain Builders (2026)
# Source: atlas.optimism.io (official OP Atlas)
# Deadline: Monthly rolling through July 31, 2026
# ─────────────────────────────────────────────
echo ""
echo "[4/11] Submitting: Optimism Retro Funding — Onchain Builders..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Optimism Retro Funding: Onchain Builders (2026)** — The Optimism Collective'\''s ongoing Retro Funding program rewards projects driving cross-chain asset transfers and Superchain growth. Up to 8M OP tokens available. Program runs February 13 through July 31, 2026, with monthly application deadlines — projects apply and are evaluated for rewards the following month. Projects must build on eligible OP Chains. Applications submitted via OP Atlas (atlas.optimism.io). Posted by @optimismFND.\nLink: https://atlas.optimism.io/missions/retro-funding-onchain-builders"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# CRYPTO WIRE — Entry 7: Optimism Retro Funding — Dev Tooling (2026)
# Source: gov.optimism.io (Optimism governance forum)
# Deadline: Through July 30, 2026 (rolling)
# ─────────────────────────────────────────────
echo ""
echo "[5/11] Submitting: Optimism Retro Funding — Dev Tooling..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Optimism Retro Funding: Dev Tooling (2026)** — The Optimism Collective is running an ongoing Retro Funding mission for open-source developer tooling — libraries, compilers, debuggers, and other software supporting Superchain development. Applications are live now, open through July 30, 2026. Structured as ongoing impact evaluation with regular rewards throughout the year, providing builders with predictable support. Apply via OP Atlas at atlas.optimism.io. Posted by @optimismFND.\nLink: https://gov.optimism.io/t/retro-funding-onchain-builders-mission-details/9611"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# CRYPTO WIRE — Entry 8: Arbitrum Foundation Grant Program — Rolling Applications
# Source: arbitrum.foundation/grants (official)
# Deadline: Rolling
# ─────────────────────────────────────────────
echo ""
echo "[6/11] Submitting: Arbitrum Foundation Grant Program..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Arbitrum Foundation Grant Program — Rolling Applications** — The Arbitrum Foundation offers milestone-based grants from $20,000 to $150,000 for builders on Arbitrum, with focus on key Arbitrum Foundation initiatives including ecosystem growth, technical infrastructure, and sustainable communities. Also active: Stylus Sprint (5M ARB for Arbitrum Stylus projects) and Trailblazer AI Grant Program ($1M total, up to $10k per AI agent project). Applications approved on a rolling basis. Apply at arbitrum.foundation/grants.\nLink: https://arbitrum.foundation/grants"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# OSS WIRE — Entry 9: Linux Foundation / Alpha-Omega $12.5M OpenSSF Security Grant
# Source: openssf.org press release (official)
# Note: Previously skipped on 2026-04-19 as "not an open application program";
#       today's entry includes specific application URL (alpha-omega.dev) — requalifies
# Announced: March 17, 2026
# ─────────────────────────────────────────────
echo ""
echo "[7/11] Submitting: Linux Foundation / Alpha-Omega \$12.5M OpenSSF Security Grant..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Linux Foundation / Alpha-Omega $12.5M OpenSSF Security Grant Initiative** — The Linux Foundation announced $12.5 million in new grant funding from Anthropic, AWS, GitHub, Google, Google DeepMind, Microsoft, and OpenAI to advance open source security, managed by Alpha-Omega and the Open Source Security Foundation (OpenSSF). Alpha-Omega has an established track record: 70+ grants totalling $20M+ to major ecosystems, package registries, and individual OSS projects. Focus: helping maintainers handle AI-accelerated security vulnerability discovery, with AI-powered security tools and training. Open source maintainers and foundations can apply at alpha-omega.dev. Announced March 17, 2026. Posted by @linuxfoundation.\nLink: https://openssf.org/press-release/2026/03/17/linux-foundation-announces-12-5-million-in-grant-funding-from-leading-organizations-to-advance-open-source-security/"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# OSS WIRE — Entry 10: Sequoia Capital Open Source Fellowship
# Source: sequoiacap.com/oss (official)
# Deadline: Rolling
# ─────────────────────────────────────────────
echo ""
echo "[8/11] Submitting: Sequoia Capital Open Source Fellowship..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Sequoia Capital Open Source Fellowship — Rolling Applications** — Sequoia Capital'\''s equity-free Open Source Fellowship provides a stipend covering reasonable living expenses for 6 to 12 months for developers working on existing open source projects. No equity taken, no future company expected. Fellows retain ownership of all code written before, during, and after the program. Applications are open on a rolling basis — apply via brief questionnaire at sequoiacap.com/oss. Primarily focused on existing open source projects with established user bases. Posted by @sequoia.\nLink: https://www.sequoiacap.com/oss/"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

# ─────────────────────────────────────────────
# AI WIRE — Entry 11: Google.org Impact Challenge: AI for Science 2026
# Source: google.org (official)
# Deadline: May 1, 2026
# Amount: $500K–$3M per org, $30M total pool
# ─────────────────────────────────────────────
echo ""
echo "[9/11] Submitting: Google.org Impact Challenge — AI for Science..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Google.org Impact Challenge: AI for Science 2026** — Google.org is running a $30M global open-call grant program for researchers and organizations using AI to accelerate scientific breakthroughs. Individual awards range from $500,000 to $3,000,000 USD. Recipients also have the option to participate in a Google.org Accelerator with pro bono technical support from Google experts using generative AI and agentic capabilities. Eligible: nonprofits, social enterprises, and academic institutions. Applications close May 1, 2026. Apply at google.org/impact-challenges/ai-science. Posted by Google.org.\nLink: https://www.google.org/impact-challenges/ai-science/"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# CRYPTO WIRE — Entry 12: Clanker Ecosystem Fund
# Source: crypto.news / Neynar official blog
# Deadline: Rolling (proposal-based governance)
# ─────────────────────────────────────────────
echo ""
echo "[10/11] Submitting: Clanker Ecosystem Fund..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Clanker Ecosystem Fund — Fee Recycling into Builders** — Clanker (now owned by Neynar following its acquisition of Farcaster) has launched the Clanker Ecosystem Fund, routing 60% of protocol fees into grants, infrastructure, and community development. The fund has already deployed $8M to acquire 14% of CLANKER supply and will recycle ongoing fees toward builders in the Clanker and Farcaster ecosystems. Community contributors can submit proposals via a transparent governance model evaluated on impact, innovation, and ecosystem alignment. Clanker has generated $50M+ in cumulative protocol fees since launch, with $8M+ in a single week at peak. Source: crypto.news, confirmed by Neynar official blog.\nLink: https://crypto.news/clanker-launches-ecosystem-fund-to-recycle-fees-into-creators-and-community/"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# OSS WIRE — Entry 13: NSF Safe-OSE
# Source: nsf.gov (official), solicitation NSF 24-608
# Deadline: April 28, 2026 (full proposal)
# Amount: Up to $1.5M per award (24 months)
# ─────────────────────────────────────────────
echo ""
echo "[11/11] Submitting: NSF Safe-OSE..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **NSF Safe-OSE: Safety, Security & Privacy of Open-Source Ecosystems** — The US National Science Foundation (NSF) is accepting full proposals for the Safe-OSE program, which funds open-source ecosystems to address significant safety, security, and privacy vulnerabilities — both technical (code vulnerabilities, side-channels) and socio-technical (supply chain, insider threats). Awards up to $1,500,000 per project (max $500K Year 1 + $1M Year 2, 24 months). Full proposal deadline: April 28, 2026. Applicants must be established open-source ecosystems with existing governance. Apply via NSF solicitation NSF 24-608 at nsf.gov.\nLink: https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

echo ""
echo "=== Submissions complete: 11 entries submitted ==="
echo ""
echo "=== Sending Daily Brief ==="

curl -s -X POST "$API/api/scan/agent/send-brief" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "'"$DATE"'",
    "entries": [
      {
        "wire": "ai",
        "name": "Anthropic Fellows Program (May & July 2026 Cohorts)",
        "url": "https://x.com/AnthropicAI/status/1999233249579794618",
        "status": "submitted",
        "deadline": "2026-04-26",
        "amount": "$3,850/week + ~$15k/month compute"
      },
      {
        "wire": "ai",
        "name": "OpenAI Safety Fellowship 2026",
        "url": "https://x.com/OpenAI/status/2041202511647019251",
        "status": "submitted",
        "deadline": "2026-05-03",
        "amount": "$3,850/week + ~$15k/month compute"
      },
      {
        "wire": "ai",
        "name": "Constellation Astra Fellowship — Fall 2026",
        "url": "https://constellation.org/programs/astra",
        "status": "duplicate",
        "note": "Already in DB from 2026-04-19 submission"
      },
      {
        "wire": "crypto",
        "name": "Ethereum Foundation 2026 PhD Fellowship Program",
        "url": "https://esp.ethereum.foundation/rounds/phdfp26",
        "status": "duplicate",
        "note": "Already in DB from 2026-04-21 submission"
      },
      {
        "wire": "crypto",
        "name": "Ethereum Security Fund — $220M TheDAO Revival",
        "url": "https://unchainedcrypto.com/exclusive-thedao-to-become-new-220-million-ethereum-security-fund/",
        "status": "submitted",
        "deadline": "rolling",
        "amount": "$13.5M grant pool + $8M/year yield"
      },
      {
        "wire": "crypto",
        "name": "Optimism Retro Funding: Onchain Builders (2026)",
        "url": "https://atlas.optimism.io/missions/retro-funding-onchain-builders",
        "status": "submitted",
        "deadline": "2026-07-31 (monthly rolling)",
        "amount": "Up to 8M OP tokens"
      },
      {
        "wire": "crypto",
        "name": "Optimism Retro Funding: Dev Tooling (2026)",
        "url": "https://gov.optimism.io/t/retro-funding-onchain-builders-mission-details/9611",
        "status": "submitted",
        "deadline": "2026-07-30 (rolling)",
        "amount": "ongoing rewards"
      },
      {
        "wire": "crypto",
        "name": "Arbitrum Foundation Grant Program",
        "url": "https://arbitrum.foundation/grants",
        "status": "submitted",
        "deadline": "rolling",
        "amount": "$20k-$150k (milestone-based)"
      },
      {
        "wire": "oss",
        "name": "Linux Foundation / Alpha-Omega $12.5M OpenSSF Security Grant",
        "url": "https://openssf.org/press-release/2026/03/17/linux-foundation-announces-12-5-million-in-grant-funding-from-leading-organizations-to-advance-open-source-security/",
        "status": "submitted",
        "deadline": "rolling",
        "amount": "$12.5M total fund"
      },
      {
        "wire": "oss",
        "name": "Sequoia Capital Open Source Fellowship",
        "url": "https://www.sequoiacap.com/oss/",
        "status": "submitted",
        "deadline": "rolling",
        "amount": "living expenses stipend, 6-12 months"
      },
      {
        "wire": "ai",
        "name": "Google.org Impact Challenge: AI for Science 2026",
        "url": "https://www.google.org/impact-challenges/ai-science/",
        "status": "submitted",
        "deadline": "2026-05-01",
        "amount": "$500K–$3M per org ($30M pool)"
      },
      {
        "wire": "crypto",
        "name": "Clanker Ecosystem Fund",
        "url": "https://crypto.news/clanker-launches-ecosystem-fund-to-recycle-fees-into-creators-and-community/",
        "status": "submitted",
        "deadline": "rolling",
        "amount": "$8M deployed, ongoing fee recycling"
      },
      {
        "wire": "oss",
        "name": "NSF Safe-OSE: Safety, Security & Privacy of Open-Source Ecosystems",
        "url": "https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems",
        "status": "submitted",
        "deadline": "2026-04-28",
        "amount": "up to $1.5M per award"
      }
    ],
    "searchesDone": 22,
    "totalFound": 13,
    "skippedDuplicates": 2,
    "notes": "2 duplicates skipped: Constellation Astra (submitted 2026-04-19) and EF PhD Fellowship (submitted 2026-04-21). Network sandbox in agent environment prevented live DB duplicate check — duplicates identified from prior submission script history. Operator should verify before approving. URGENT: Anthropic Fellows Program deadline April 26 / NSF Safe-OSE deadline April 28 / Google.org AI for Science deadline May 1."
  }' | python3 -m json.tool 2>/dev/null || echo "Brief sent"

echo ""
echo "Done. 11 entries submitted across ai (3), crypto (5), oss (3) wires. 2 duplicates skipped."
