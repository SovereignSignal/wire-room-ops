#!/bin/bash
# Daily Grant Scan Submissions — 2026-04-19
# 5 entries across ai (3), crypto (1), oss (1) wires
# Run from any environment with network access to wire-room-ops-production.up.railway.app

API="https://wire-room-ops-production.up.railway.app"
TOKEN="1d67a15d8d12971ec38e512a726222e3df3027f1f8b43a091cd819aac9182bd7"
DATE="2026-04-19"

echo "=== Wire Room Daily Scan Submissions: $DATE ==="

# ─────────────────────────────────────────────
# AI WIRE — Entry 1: Anthropic Fellows Program 2026 (July cohort)
# Source: alignment.anthropic.com (Tier 1 — Anthropic official)
# Deadline: April 26, 2026 — URGENT
# ─────────────────────────────────────────────
echo ""
echo "[1/5] Submitting: Anthropic Fellows Program 2026 (July cohort)..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Anthropic Fellows Program 2026 (July Cohort)** — Anthropic is accepting applications for its next cohort of AI safety fellows, starting July 20, 2026. Fellows pursue independent safety research with close mentorship from Anthropic researchers. Stipend: $3,850/week USD (or £2,310/week GBP / $4,300/week CAD). Compute funding: ~$15,000/month. Duration: 4 months. Applications close April 26, 2026 — rolling review for later cohorts. Open to researchers, engineers, and practitioners wanting to transition into AI safety. No prior safety experience required. Posted by @AnthropicAI.\nLink: https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# AI WIRE — Entry 2: OpenAI Safety Fellowship 2026
# Source: openai.com (Tier 1 — OpenAI official)
# Deadline: May 3, 2026
# ─────────────────────────────────────────────
echo ""
echo "[2/5] Submitting: OpenAI Safety Fellowship 2026..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **OpenAI Safety Fellowship 2026** — OpenAI is launching an external Safety Fellowship for researchers, engineers, and practitioners to pursue rigorous, high-impact safety and alignment research. Program runs September 14, 2026 through February 5, 2027 (~5 months). Fellows receive a monthly stipend, compute support, and mentorship from OpenAI researchers. Workspace available in Berkeley at Constellation; remote option also available. Priority research areas: safety evaluation, robustness, agentic oversight, scalable mitigations, privacy-preserving safety methods, and high-severity misuse domains. Open to applicants from CS, social science, cybersecurity, HCI, and related fields. Applications close May 3, 2026; notifications by July 25. Posted by @OpenAI.\nLink: https://openai.com/index/introducing-openai-safety-fellowship/"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# AI WIRE — Entry 3: Constellation Astra Fellowship 2026
# Source: constellation.org (Tier 1 — Constellation Institute official)
# Deadline: May 3, 2026
# ─────────────────────────────────────────────
echo ""
echo "[3/5] Submitting: Constellation Astra Fellowship 2026..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "ai",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Constellation Astra Fellowship 2026** — Constellation Institute is accepting applications for its fully funded, 3–6 month in-person AI safety fellowship at its Berkeley research center. Stipend: $8,400/month. Empirical research fellows also receive ~$15,000/month compute funding. Open to individuals motivated to reduce catastrophic risks from advanced AI — technical, governance, policy, security, or field-building backgrounds welcome. Prior AI safety experience not required. Over 80% of the first cohort now work full-time at Redwood Research, METR, Anthropic, OpenAI, DeepMind, UK AISI, and similar orgs. Applications close May 3, 2026 at 11:59 PM (Anywhere on Earth). Posted by Constellation Institute.\nLink: https://constellation.org/programs/astra"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# CRYPTO WIRE — Entry 4: Ethereum Foundation $1M Audit Subsidy Program
# Source: blog.ethereum.org / esp.ethereum.foundation (Tier 1 — Ethereum Foundation)
# Announced: April 14, 2026 — rolling until $1M exhausted
# ─────────────────────────────────────────────
echo ""
echo "[4/5] Submitting: Ethereum Foundation $1M Audit Subsidy Program..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "crypto",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **Ethereum Foundation $1M Audit Subsidy Program** — The Ethereum Foundation launched a $1 million Audit Subsidy Program on April 14, 2026, to help Ethereum mainnet builders offset the high cost of smart contract security audits. Eligible teams can receive up to 30% of total audit costs covered, with higher support available on a case-by-case basis. Partners include 20+ top-tier audit firms via Areta Market, Nethermind, and Chainlink Labs. All Ethereum mainnet builders are eligible regardless of project size or stage; priority goes to teams advancing CROPS principles (Censorship Resistance, Open Source, Privacy, Security). No fixed deadline — subsidies distributed on a first-come basis until $1M pool is exhausted. Part of the Ethereum Foundation Trillion Dollar Security Initiative. Apply via form on Areta Market. Posted by @ethereum and @EF_ESP.\nLink: https://blog.ethereum.org/en/2026/04/14/audit-subsidy"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

sleep 1

# ─────────────────────────────────────────────
# OSS WIRE — Entry 5: GNOME Fellowship Program 2026
# Source: blogs.gnome.org / fellowship.gnome.org (Tier 1 — GNOME Foundation)
# Deadline: April 20, 2026 — URGENT (tomorrow!)
# ─────────────────────────────────────────────
echo ""
echo "[5/5] Submitting: GNOME Fellowship Program 2026 [URGENT — closes April 20]..."
curl -s -X POST "$API/api/scan/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wire": "oss",
    "promptVariant": "A",
    "scanDate": "'"$DATE"'",
    "source": "web-search",
    "rawText": "1. **GNOME Fellowship Program 2026** — The GNOME Foundation is launching its inaugural Fellowship, funding community members for 12-month sustainability work on the GNOME project. Salary: $70,000–$100,000 USD/year based on experience and location. Full-time or half-time proposals accepted. Round 1 focus: build systems, CI/CD infrastructure, testing frameworks, developer tooling, documentation, accessibility, and technical debt reduction — not feature development. Open to anyone with a track record in GNOME or relevant open source experience. Applicants should be available to begin around May 2026. Applications close April 20, 2026 at 23:00 UTC — DEADLINE IS TOMORROW. Posted by GNOME Foundation (@gnome).\nLink: https://fellowship.gnome.org/apply"
  }' | python3 -m json.tool 2>/dev/null || echo "Response received"

echo ""
echo "=== Submissions complete ==="
echo ""
echo "Now sending daily brief..."

curl -s -X POST "$API/api/scan/agent/send-brief" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "'"$DATE"'",
    "entries": [
      {
        "wire": "ai",
        "name": "Anthropic Fellows Program 2026 (July cohort)",
        "source_url": "https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/",
        "decision": "submitted",
        "reason": "Tier 1 source (Anthropic official). Top-tier AI safety fellowship, $3,850/week + $15K/month compute. Deadline April 26."
      },
      {
        "wire": "ai",
        "name": "OpenAI Safety Fellowship 2026",
        "source_url": "https://openai.com/index/introducing-openai-safety-fellowship/",
        "decision": "submitted",
        "reason": "Tier 1 source (OpenAI official). New external safety fellowship, monthly stipend + compute. Deadline May 3."
      },
      {
        "wire": "ai",
        "name": "Constellation Astra Fellowship 2026",
        "source_url": "https://constellation.org/programs/astra",
        "decision": "submitted",
        "reason": "Tier 1 source (Constellation Institute). Explicitly listed as top-tier AI safety fellowship in editorial standards. $8,400/month + compute. Deadline May 3."
      },
      {
        "wire": "crypto",
        "name": "Ethereum Foundation $1M Audit Subsidy Program",
        "source_url": "https://blog.ethereum.org/en/2026/04/14/audit-subsidy",
        "decision": "submitted",
        "reason": "Tier 1 source (EF official). Fresh announcement (April 14). Ecosystem-wide security service, all mainnet builders eligible."
      },
      {
        "wire": "oss",
        "name": "GNOME Fellowship Program 2026",
        "source_url": "https://fellowship.gnome.org/apply",
        "decision": "submitted",
        "reason": "Tier 1 source (GNOME Foundation). $70-100K/year sustainability fellowship. DEADLINE TOMORROW April 20."
      }
    ],
    "skipped": [
      {"name": "CAIS AI and Society Fellowship", "reason": "Deadline passed March 24"},
      {"name": "Sovereign Tech Fellowship 2026", "reason": "Deadline passed April 6"},
      {"name": "EF PhD Fellowship", "reason": "Deadline passed April 1"},
      {"name": "Alpha-Omega $12.5M LF Fund", "reason": "33 days old, not an open application program"},
      {"name": "Solana Actions/Blinks $400K", "reason": "Announced July 2024, too old"},
      {"name": "HRF Bitcoin Development Fund", "reason": "Grants already awarded, not open application"},
      {"name": "Cambridge ERA:AI Fellowship", "reason": "Source is Tier 3 aggregator (opportunitiesforyouth.org)"},
      {"name": "Pivotal Research Fellowship Q3", "reason": "Not on approved top-tier list; smaller org"},
      {"name": "Open Source Endowment", "reason": "Still in fundraising stage, no grants distributed yet"},
      {"name": "Gitcoin GG24", "reason": "Closed October 2025"},
      {"name": "Optimism RetroPGF", "reason": "Applications closed"},
      {"name": "Unicoin Foundation", "reason": "Tier 3 — new brand-new org self-promoting"}
    ],
    "searchesDone": 18,
    "totalFound": 17,
    "skippedDuplicates": 0,
    "note": "Submission executed via script due to network sandbox in agent environment. DB duplicate check not performed — operator should verify before approving."
  }' | python3 -m json.tool 2>/dev/null || echo "Brief sent"

echo ""
echo "Done. 5 entries submitted across ai (3), crypto (1), oss (1) wires."
