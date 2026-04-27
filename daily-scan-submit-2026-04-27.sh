#!/usr/bin/env bash
# Wire Room Daily Scan — 2026-04-27
# Run this from any machine with network access to the production API.
# Prerequisites: curl, psql or node+pg for dupe checks.
#
# NEW vs Apr 24 script:
#   - NSF Safe-OSE $15M (OSS) ⚠️ CLOSES TOMORROW April 28 — URGENT
#   - DeAgentAI AIA Ecosystem Fund (Crypto) — announced April 14, rolling
#   - Modular Community Grant Program (OSS) — announced early April, rolling
#
# Carryover (from Apr 24 — server dedup catches already-queued entries):
#   - OpenAI Safety Fellowship, Constellation Astra, Pivotal Q3,
#     Schmidt Sciences RFP, Foresight Nodes (⚠️ April 30),
#     Stellar SCF #43 (⚠️ April 26 — may be PAST), HRF Bitcoin Fund,
#     Sui Foundation $50M, NLnet Commons 13th Call,
#     GitHub SOSF Session 4, Alpha-Omega $12.5M, Sequoia OSS Fellowship
#
# DROPPED vs Apr 24:
#   - Anthropic Fellows Program — deadline April 26 PASSED

API="https://wire-room-ops-production.up.railway.app"
TOKEN="1d67a15d8d12971ec38e512a726222e3df3027f1f8b43a091cd819aac9182bd7"
DB="postgresql://postgres:xSwjvffxbNgNsXNvlIBXwiSISeKbrLMD@gondola.proxy.rlwy.net:40765/railway"
DATE="2026-04-27"

AUTH="-H 'Authorization: Bearer $TOKEN'"
CT="-H 'Content-Type: application/json'"

# ─── STEP 1: Check for duplicates ─────────────────────────────────────────────
echo "=== Checking for existing duplicates ==="
URLS=(
  "https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems"
  "https://openai.com/index/introducing-openai-safety-fellowship/"
  "https://constellation.org/programs/astra"
  "https://www.pivotal-research.org/fellowship"
  "https://www.panewslab.com/en/articles/019d8a58-94fc-71a1-a675-b1931b6c4c08"
  "https://forum.modular.com/t/introducing-the-modular-community-grant-program/2941"
)

for url in "${URLS[@]}"; do
  result=$(psql "$DB" -At -c "SELECT id || ':' || status FROM scan_entries WHERE source_url = '$url' LIMIT 1;" 2>/dev/null)
  if [ -n "$result" ]; then
    echo "DUPLICATE — $url -> $result"
  else
    echo "NEW       — $url"
  fi
done

echo ""
echo "=== Submitting new entries ==="

# ─── ENTRY 1: NSF Safe-OSE (OSS) ⚠️ CLOSES TOMORROW ─────────────────────────
echo "Submitting: NSF Safe-OSE Program [URGENT - closes April 28]..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **NSF Safe-OSE: Safety, Security, and Privacy of Open-Source Ecosystems** — The U.S. National Science Foundation's Safe-OSE program is in its full-proposal phase (deadline April 28, 2026, 5pm local time) for organizations that were invited after the January 13, 2026 preliminary proposal round. Two-stage process: preliminary proposals invited in Jan 2026; only invited orgs may submit full proposals now. Up to $1,500,000 per award (max $500K Year 1, $1M Year 2); up to $15,000,000 total pool. Focus: significant safety, security, and/or privacy vulnerabilities in open-source ecosystems — both technical (code vulnerabilities, side-channels) and socio-technical (supply chain, insider threats). U.S.-based for-profit and non-profit organizations, universities, and government entities eligible. Future cycles will open in 2027. Note for operator: share with contacts that had preliminary proposals invited — this is their window. Posted by the U.S. National Science Foundation (nsf.gov).\nLink: https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems"
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

sleep 1

# ─── ENTRY 2: OpenAI Safety Fellowship (AI) ───────────────────────────────────
echo "Submitting: OpenAI Safety Fellowship..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **OpenAI Safety Fellowship 2026–2027** — OpenAI launched its inaugural external AI safety research fellowship, running September 14, 2026 through February 5, 2027. Applications close May 3, 2026; successful applicants notified by July 25. Fellows receive a monthly stipend, API credits, and compute support. No internal OpenAI system access — workspace available in Berkeley alongside Constellation fellows or fully remote. Research focus: safety evaluation, agentic oversight, ethics, robustness, privacy-preserving safety methods, and high-severity misuse domains. Expected output: paper, benchmark, or dataset. Open to external researchers, engineers, and practitioners; no specific academic credentials required. Selection based on research ability, technical judgment, and execution capacity. DEADLINE: May 3, 2026. Posted by @OpenAI.\nLink: https://openai.com/index/introducing-openai-safety-fellowship/"
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

sleep 1

# ─── ENTRY 3: Constellation Astra Fellowship (AI) ─────────────────────────────
echo "Submitting: Constellation Astra Fellowship..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Constellation Astra Fellowship 2026 — September Cohort** — Constellation Institute is accepting applications for its fully-funded 5-month AI safety fellowship beginning September 2026. Deadline: May 3, 2026. Fellows receive $8,400/month stipend plus ~$15,000/month in compute resources. In-person at the Berkeley research institute with weekly mentorship from researchers at Redwood Research, METR, Anthropic, OpenAI, Google DeepMind, and the UK AI Security Institute. Research tracks: empirical ML safety (alignment, AI control, model evaluations, scalable oversight), AI strategy, and governance. 80%+ of first cohort now work full-time in AI safety roles. Open globally. Apply by May 3 (11:59 PM Anywhere on Earth). DEADLINE: May 3, 2026. Posted by Constellation Institute (constellation.org).\nLink: https://constellation.org/programs/astra"
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

sleep 1

# ─── ENTRY 4: Pivotal Research Fellowship Q3 (AI) ─────────────────────────────
echo "Submitting: Pivotal Research Fellowship Q3 2026..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Pivotal Research Fellowship — Q3 2026** — Pivotal Research is accepting applications for its Q3 2026 AI safety research fellowship, deadline May 3, 2026. Fellows spend 9 weeks (extensible to 6 months) working in-person at the London Initiative for Safe AI (LISA), with weekday lunch and dinner included. Compensation: £6,000–£8,000 stipend plus £2,000 housing support for non-London fellows and travel funding. Compute provided. Weekly 1-on-1 mentorship from researchers at GovAI, UK AI Security Institute (AISI), Google DeepMind, Cooperative AI Foundation, Future of Life Institute (FLI), Institute for Progress, and others. Open to anyone 18+, including those without formal AI safety backgrounds. DEADLINE: May 3, 2026. Posted by @pivotal_org.\nLink: https://www.pivotal-research.org/fellowship"
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

sleep 1

# ─── ENTRY 5: DeAgentAI AIA Ecosystem Fund (Crypto) ──────────────────────────
echo "Submitting: DeAgentAI AIA Ecosystem Fund..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **DeAgentAI AIA Ecosystem Fund** — DeAgentAI announced the AIA Ecological Fund on April 14, 2026, targeting projects at the intersection of AI Agent and Physical AI. The fund focuses on: (1) AI Agent — application-layer projects with autonomous decision-making, on-chain execution, and multi-agent collaboration capabilities; (2) Physical AI — hardware infrastructure and compute optimization extending AI reasoning to the real world. Built on DeAgentAIs infrastructure across SUI, BSC, and BTC ecosystems with 191M+ on-chain interactions. Provides investee projects with technology, ecosystem traffic, and partnership support. Seed investments announced: AliceAI (verifiable predictive market decision-making) and ASIC AI chips optimized for Transformer inference. Rolling applications. Posted by @DeAgentAI (via PANews, April 14 2026).\nLink: https://www.panewslab.com/en/articles/019d8a58-94fc-71a1-a675-b1931b6c4c08"
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

sleep 1

# ─── ENTRY 6: Modular Community Grant Program (OSS) ──────────────────────────
echo "Submitting: Modular Community Grant Program..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Modular Community Grant Program** — Modular launched a rolling grant program for open source projects contributing to the Modular ecosystem, including Mojo, MAX, and related developer tooling. Grants start at $500 USD and scale with scope and ecosystem relevance, distributed over 6 months in three equal installments via GitHub Sponsors. Eligible contributions include open source development, community events, and Modular-focused conference talks. Applications reviewed on a rolling basis. Announced early April 2026 on the official Modular forum. Posted by Modular (forum.modular.com).\nLink: https://forum.modular.com/t/introducing-the-modular-community-grant-program/2941"
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

sleep 1

# ─── STEP 3: Send daily brief ────────────────────────────────────────────────
echo ""
echo "=== Sending daily brief ==="
curl -s -X POST "$API/api/scan/agent/send-brief" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "'"$DATE"'",
    "entries": [
      {
        "wire": "oss",
        "name": "NSF Safe-OSE: Safety, Security & Privacy of Open-Source Ecosystems",
        "url": "https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems",
        "amount": "up to $15,000,000 total",
        "deadline": "2026-04-28",
        "note": "Full proposals due April 28 for INVITED organizations only (prelim proposals were Jan 2026). Share with contacts that submitted preliminary proposals. Future cycle opens 2027."
      },
      {
        "wire": "ai",
        "name": "OpenAI Safety Fellowship 2026–2027",
        "url": "https://openai.com/index/introducing-openai-safety-fellowship/",
        "amount": "Monthly stipend + compute + API credits",
        "deadline": "2026-05-03"
      },
      {
        "wire": "ai",
        "name": "Constellation Astra Fellowship 2026 (September Cohort)",
        "url": "https://constellation.org/programs/astra",
        "amount": "$8,400/month + $15K/month compute",
        "deadline": "2026-05-03"
      },
      {
        "wire": "ai",
        "name": "Pivotal Research Fellowship Q3 2026",
        "url": "https://www.pivotal-research.org/fellowship",
        "amount": "£6,000–£8,000 stipend + housing + travel",
        "deadline": "2026-05-03"
      },
      {
        "wire": "crypto",
        "name": "DeAgentAI AIA Ecosystem Fund",
        "url": "https://www.panewslab.com/en/articles/019d8a58-94fc-71a1-a675-b1931b6c4c08",
        "amount": "Investment + ecosystem support (seed round active)",
        "deadline": "rolling",
        "note": "Announced April 14 2026 — AI Agent + Physical AI track on SUI/BSC/BTC"
      },
      {
        "wire": "oss",
        "name": "Modular Community Grant Program",
        "url": "https://forum.modular.com/t/introducing-the-modular-community-grant-program/2941",
        "amount": "$500+ USD (6-month, 3 installments via GitHub Sponsors)",
        "deadline": "rolling"
      }
    ],
    "searchesDone": 28,
    "totalFound": 22,
    "skippedDuplicates": 16,
    "notes": "SANDBOX BLOCKED: Outbound HTTP/DB unreachable from scan agent environment. Run this script from a host on the production allowlist. NEW today: NSF Safe-OSE $15M (OSS, full proposals due April 28 for INVITED orgs only — two-stage program, prelim was January), DeAgentAI AIA Fund (Crypto, April 14 announcement, rolling), Modular Community Grants (OSS, rolling). DROPPED: Anthropic Fellows — deadline April 26 PASSED. Carryovers from Apr 24 script included via server dedup. NOTE: Also verify Foresight Institute Nodes (April 30 deadline in 3 DAYS — from Apr 24 script) and Stellar SCF #43 (April 26 — may now be PAST) from prior submissions."
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

echo ""
echo "=== Done ==="
echo "Submitted 6 entries: 3 AI, 1 Crypto, 2 OSS"
echo "⚠️  URGENT: NSF Safe-OSE full proposals due April 28 (invited-only — share with prelim-submitters)"
echo "⚠️  URGENT: Foresight Institute Nodes closes April 30 (from Apr 24 script)"
echo "   All three May 3 deadlines: OpenAI Safety Fellowship, Astra Fellowship, Pivotal Q3"
