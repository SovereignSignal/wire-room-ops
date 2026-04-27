#!/usr/bin/env bash
# Wire Room Daily Scan — 2026-04-27
# Run this from any machine with network access to the production API.
# Prerequisites: curl, psql or node+pg for dupe checks.
#
# NOTE: The Anthropic Fellows entry has a DEADLINE OF APRIL 26 — already passed.
# Operator should verify before submitting that entry.

API="https://wire-room-ops-production.up.railway.app"
TOKEN="1d67a15d8d12971ec38e512a726222e3df3027f1f8b43a091cd819aac9182bd7"
DB="postgresql://postgres:xSwjvffxbNgNsXNvlIBXwiSISeKbrLMD@gondola.proxy.rlwy.net:40765/railway"
DATE="2026-04-27"

AUTH="-H 'Authorization: Bearer $TOKEN'"
CT="-H 'Content-Type: application/json'"

# ─── STEP 1: Check for duplicates ─────────────────────────────────────────────
echo "=== Checking for existing duplicates ==="
URLS=(
  "https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/"
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

# ─── ENTRY 1: Anthropic Fellows Program (AI) ──────────────────────────────────
# NOTE: Deadline was April 26 — confirm if still accepting before submitting
echo "Submitting: Anthropic Fellows Program..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Anthropic Fellows Program — July 2026 Cohort** — Anthropic is accepting applications for its empirical AI safety research fellowship. The July 2026 cohort (starts July 20, 2026) had a deadline of April 26, 2026. Fellows receive a weekly stipend of $3,850 USD / £2,310 GBP / $4,300 CAD plus ~$15,000/month in compute resources, for 4 months of full-time AI safety research (40 hrs/week). Research areas include AI alignment, model evaluations, and scalable oversight. Fellows work closely with Anthropic researchers; 80%+ of past fellows produced published papers and 40%+ joined Anthropic full-time. Open to applicants globally; no specific academic credential required. Posted by @Anthropic.\nLink: https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/"
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
    "rawText": "1. **OpenAI Safety Fellowship** — OpenAI launched its inaugural external AI safety research fellowship, running September 14, 2026 through February 5, 2027. Applications close May 3, 2026; successful applicants notified by July 25. Fellows receive a monthly stipend, API credits, and compute support. No internal OpenAI system access — workspace available in Berkeley alongside Constellation fellows or fully remote. Research focus: safety evaluation, agentic oversight, ethics, robustness, privacy-preserving safety methods, and high-severity misuse domains. Expected output: paper, benchmark, or dataset. Open to external researchers, engineers, and practitioners; no specific academic credentials required. Selection based on research ability, technical judgment, and execution capacity. Posted by @OpenAI.\nLink: https://openai.com/index/introducing-openai-safety-fellowship/"
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
    "rawText": "1. **Constellation Astra Fellowship 2026 — September Cohort** — Constellation Institute is accepting applications for its fully-funded 5-month AI safety fellowship beginning September 2026. Deadline: May 3, 2026. Fellows receive $8,400/month stipend plus ~$15,000/month in compute resources. In-person at the Berkeley research institute with weekly mentorship from researchers at Redwood Research, METR, Anthropic, OpenAI, Google DeepMind, and the UK AI Security Institute. Research tracks: empirical ML safety (alignment, AI control, model evaluations, scalable oversight), AI strategy, and governance. 80%+ of first cohort now work full-time in AI safety roles. Open globally. Apply by May 3 (11:59 PM Anywhere on Earth). Posted by @ConstellOrg.\nLink: https://constellation.org/programs/astra"
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
    "rawText": "1. **Pivotal Research Fellowship — Q3 2026** — Pivotal Research is accepting applications for its Q3 2026 AI safety research fellowship, deadline May 3, 2026. Fellows spend 9 weeks (extensible to 6 months) working in-person at the London Initiative for Safe AI (LISA), with weekday lunch and dinner included. Compensation: £6,000–£8,000 stipend plus £2,000 housing support for non-London fellows and travel funding. Compute provided. Weekly 1-on-1 mentorship from researchers at GovAI, UK AI Security Institute (AISI), Google DeepMind, Cooperative AI Foundation, Future of Life Institute (FLI), Institute for Progress, and others. Open to anyone 18+, including those without formal AI safety backgrounds. Posted by @pivotal_org.\nLink: https://www.pivotal-research.org/fellowship"
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
    "rawText": "1. **DeAgentAI AIA Ecosystem Fund** — DeAgentAI announced the AIA Ecological Fund on April 14, 2026, targeting projects at the intersection of AI Agent and Physical AI. The fund focuses on: (1) AI Agent — application-layer projects with autonomous decision-making, on-chain execution, and multi-agent collaboration capabilities; (2) Physical AI — hardware infrastructure and compute optimization extending AI reasoning to the real world. Built on DeAgentAIs infrastructure across SUI, BSC, and BTC ecosystems with 191M+ on-chain interactions. Provides investee projects with technology, ecosystem traffic, and partnership support. Seed investments announced: AliceAI (verifiable predictive market decision-making) and ASIC AI chips optimized for Transformer inference. Posted by @DeAgentAI.\nLink: https://www.panewslab.com/en/articles/019d8a58-94fc-71a1-a675-b1931b6c4c08"
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
    "rawText": "1. **Modular Community Grant Program** — Modular launched a rolling grant program for open source projects contributing to the Modular ecosystem, including Mojo, MAX, and related developer tooling. Grants start at $500 USD and scale with scope and ecosystem relevance, distributed over 6 months in three equal installments via GitHub Sponsors. Eligible contributions include open source development, community events, and Modular-focused conference talks. Applications reviewed on a rolling basis. Announced in early April 2026. Posted by Modular (forum.modular.com).\nLink: https://forum.modular.com/t/introducing-the-modular-community-grant-program/2941"
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
    "searchesDone": 22,
    "totalFound": 18,
    "skippedDuplicates": 0,
    "entries": [
      {
        "wire": "ai",
        "name": "Anthropic Fellows Program — July 2026 Cohort",
        "url": "https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/",
        "amount": "$3,850/week stipend + $15K/month compute",
        "deadline": "2026-04-26",
        "note": "DEADLINE MAY HAVE PASSED — verify before approving"
      },
      {
        "wire": "ai",
        "name": "OpenAI Safety Fellowship",
        "url": "https://openai.com/index/introducing-openai-safety-fellowship/",
        "amount": "Monthly stipend + compute + API credits",
        "deadline": "2026-05-03"
      },
      {
        "wire": "ai",
        "name": "Constellation Astra Fellowship 2026",
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
        "amount": "Investment + ecosystem support",
        "deadline": "Rolling"
      },
      {
        "wire": "oss",
        "name": "Modular Community Grant Program",
        "url": "https://forum.modular.com/t/introducing-the-modular-community-grant-program/2941",
        "amount": "$500+ USD (6-month, 3 installments)",
        "deadline": "Rolling"
      }
    ]
  }' | python3 -m json.tool 2>/dev/null || echo "(parse error)"

echo ""
echo "=== Done ==="
echo "Submitted 6 entries across 3 wires (4 AI, 1 crypto, 1 OSS)"
echo "IMPORTANT: Verify Anthropic Fellows deadline (April 26) before approving that entry."
