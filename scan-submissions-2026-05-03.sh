#!/usr/bin/env bash
# Wire Room daily scan submissions — 2026-05-03
# Run from any machine with network access to wire-room-ops-production.up.railway.app
# 7 entries: 3 AI, 2 crypto, 2 OSS

API="https://wire-room-ops-production.up.railway.app"
TOKEN="1d67a15d8d12971ec38e512a726222e3df3027f1f8b43a091cd819aac9182bd7"
DATE="2026-05-03"

echo "=== Wire Room Scan Submissions: $DATE ==="
echo ""

# ── AI WIRE ───────────────────────────────────────────────────────────────────

echo "[1/7] Anthropic Fellows Program July 2026..."
curl -sf -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Anthropic Fellows Program — July 2026 Cohort** — Anthropic is opening applications for its July 2026 fellows cohort. Fellows conduct independent AI safety research alongside Anthropic researchers for four months. Stipend: $3,850/week USD ($2,310 GBP / $4,300 CAD). Compute support: up to $15,000/month. Close mentorship from Anthropic safety researchers. Open globally; no prior AI safety experience required. Deadline: May 3 2026 EOD PST. Posted by @AnthropicAI.\nLink: https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/"
  }' && echo " OK" || echo " FAILED"

echo "[2/7] OpenAI Safety Fellowship 2026..."
curl -sf -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **OpenAI Safety Fellowship 2026** — OpenAI launched an external fellowship for researchers, engineers, and practitioners to pursue high-impact safety and alignment research. Program runs September 14 2026 – February 5 2027. Monthly stipend, compute support, workspace in Berkeley alongside Constellation fellows, and ongoing OpenAI researcher mentorship. Priority areas: safety evaluation, robustness, scalable mitigations, agentic oversight, privacy-preserving safety methods, and high-severity misuse. Open to diverse backgrounds (CS, social science, cybersecurity, HCI). Applications close May 3 2026; notifications by July 25. Posted by @OpenAI.\nLink: https://openai.com/index/introducing-openai-safety-fellowship/"
  }' && echo " OK" || echo " FAILED"

echo "[3/7] Constellation Astra Fellowship 2026..."
curl -sf -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Constellation Astra Fellowship 2026–2027** — Constellation Institute flagship AI safety fellowship for the September 2026 – February 2027 cohort. Five-month full-time in-person program at Constellation'\''s Berkeley research center. Stipend: $8,400/month. Compute: $15,000/month per empirical research fellow. Research areas: alignment, AI control, model evaluations, and scalable oversight. No prior AI safety experience required; prior cohorts had 80%+ of alumni move to full-time safety roles at OpenAI, Anthropic, DeepMind, METR, and UK AISI. Deadline: May 3 2026 at 11:59pm AoE. Posted by @constellation_institute.\nLink: https://constellation.org/programs/astra"
  }' && echo " OK" || echo " FAILED"

# ── CRYPTO WIRE ───────────────────────────────────────────────────────────────

echo "[4/7] Ethereum Protocol Fellowship Cohort 7 (EPF7)..."
curl -sf -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Ethereum Protocol Fellowship Cohort 7 (EPF7)** — Ethereum Foundation re-launched the Ethereum Protocol Fellowship for its seventh cohort, running June–November 2026. Selected fellows receive monthly grants and structured mentorship to contribute to core Ethereum protocol development: client implementations (Geth, Erigon, Lighthouse), testing, specs, and core protocol research. Small cohort for deep engagement. Town hall: May 6 at 1500 UTC. Applications open until May 13 2026. Open to software engineers ready to contribute to open-source Ethereum. Posted by @EF_esp.\nLink: https://blog.ethereum.org/en/2026/04/30/epf-7"
  }' && echo " OK" || echo " FAILED"

echo "[5/7] Taiko Grant Program (rolling)..."
curl -sf -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Taiko Grant Program — $25M+ Rolling Fund** — Taiko Labs operates a rolling grants fund of $25M+ for builders on the Taiko L2 network. Individual grants can scale to $250K, with optional follow-on investment up to $250K in post-grant fundraising rounds. Focus areas: DeFi, AI, Real-World Assets, SocialFi, and Gaming. Smart contracts and front-end code must be open-source. Applications reviewed on rolling basis year-round by a Grants Council. Second round launched December 2025 with ~$30M additional allocation. Posted by Taiko Labs.\nLink: https://taiko.xyz/grant-program"
  }' && echo " OK" || echo " FAILED"

# ── OSS WIRE ──────────────────────────────────────────────────────────────────

echo "[6/7] Alpha-Omega / OpenSSF Open Grants..."
curl -sf -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Alpha-Omega / OpenSSF Open Grants Program — $12.5M 2026 Infusion** — Linux Foundation'\''s Alpha-Omega project operates a rolling open grants program for critical OSS security work, now backed by a $12.5M commitment (March 2026) from Anthropic, AWS, GitHub, Google, Google DeepMind, Microsoft, and OpenAI. Grants fund security audits, hardening, maintainer-centric AI security tooling, and sustainable security infrastructure for widely-used open-source projects. 70+ grants totaling $20M+ awarded to date. Applications accepted on rolling basis. Applicants describe project criticality, security posture, desired outcomes, and implementation plan. Monthly public progress reports required. Posted by @TheOpenSSF and @linuxfoundation.\nLink: https://alpha-omega.dev/grants/how-to-apply/"
  }' && echo " OK" || echo " FAILED"

echo "[7/7] NLnet NGI Zero Commons Fund — 13th Call..."
curl -sf -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **NLnet NGI Zero Commons Fund — 13th Open Call** — NLnet Foundation'\''s NGI Zero Commons Fund opened its 13th call on April 1 2026. Grants of €5,000–€50,000 (scalable significantly for proven potential) for digital commons, internet infrastructure, and OSS tools improving privacy, security, and openness. EU-backed with €21.6M total budget through 2027. Open to SMEs, academics, non-profits, communities, and individuals globally. All software/hardware must be released under libre/open licenses. Previous calls funded 57+ projects across distributed systems, security, privacy, and open standards. Deadline: June 1 2026 at 12:00 CEST. Posted by @nlnet.\nLink: https://nlnet.nl/commonsfund/"
  }' && echo " OK" || echo " FAILED"

echo ""
echo "=== Sending daily brief ==="

curl -sf -X POST "$API/api/scan/agent/send-brief" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "'"$DATE"'",
    "searchesDone": 18,
    "totalFound": 15,
    "skippedDuplicates": 0,
    "entries": [
      {
        "wire": "ai",
        "name": "Anthropic Fellows Program — July 2026 Cohort",
        "source_url": "https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/",
        "amount": "$3,850/week + $15k/month compute",
        "deadline": "2026-05-03",
        "notes": "Deadline TODAY. Top-tier Tier 1 source."
      },
      {
        "wire": "ai",
        "name": "OpenAI Safety Fellowship 2026",
        "source_url": "https://openai.com/index/introducing-openai-safety-fellowship/",
        "amount": "Monthly stipend + compute",
        "deadline": "2026-05-03",
        "notes": "Deadline TODAY. Official @OpenAI program."
      },
      {
        "wire": "ai",
        "name": "Constellation Astra Fellowship 2026–2027",
        "source_url": "https://constellation.org/programs/astra",
        "amount": "$8,400/month + $15k/month compute",
        "deadline": "2026-05-03",
        "notes": "Deadline TODAY. Tier 1 AI safety org."
      },
      {
        "wire": "crypto",
        "name": "Ethereum Protocol Fellowship Cohort 7 (EPF7)",
        "source_url": "https://blog.ethereum.org/en/2026/04/30/epf-7",
        "amount": "Monthly grant, 6 months",
        "deadline": "2026-05-13",
        "notes": "Official EF, fresh announcement Apr 30."
      },
      {
        "wire": "crypto",
        "name": "Taiko Grant Program — Rolling Fund",
        "source_url": "https://taiko.xyz/grant-program",
        "amount": "Up to $250K per grant",
        "deadline": "Rolling",
        "notes": "$25M+ fund, rolling applications."
      },
      {
        "wire": "oss",
        "name": "Alpha-Omega / OpenSSF Open Grants — $12.5M Infusion",
        "source_url": "https://alpha-omega.dev/grants/how-to-apply/",
        "amount": "Varies, project-based",
        "deadline": "Rolling",
        "notes": "Backed by Big Tech coalition, open rolling."
      },
      {
        "wire": "oss",
        "name": "NLnet NGI Zero Commons Fund — 13th Call",
        "source_url": "https://nlnet.nl/commonsfund/",
        "amount": "€5,000–€50,000+",
        "deadline": "2026-06-01",
        "notes": "EU-backed, currently open, 57+ projects funded."
      }
    ],
    "skipped": [
      "Pivotal Research Fellowship — below top-tier threshold",
      "UK AISI Alignment Project — applications currently closed",
      "Optimism Retro Funding — retroactive format",
      "Arbitrum Open House London — hackathon prize format",
      "Arbitrum Stylus Sprint — application period closed",
      "EF PhD Fellowship — deadline passed Apr 22",
      "Sovereign Tech Fellowship — deadline passed Apr 6",
      "NSF Safe-OSE — deadline passed Apr 28"
    ]
  }' && echo "Brief sent OK" || echo "Brief FAILED"

echo ""
echo "Done. 7 entries submitted across ai (3), crypto (2), oss (2)."
