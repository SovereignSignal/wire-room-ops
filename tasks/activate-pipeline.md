# Activate Automated Scan Pipeline

## Goal
Replace manual daily Grok scans with the automated pipeline: prompts execute on schedule, results get deduped/scored/queued, Sov reviews and approves from the dashboard.

---

## Phase 1: Load Prompts
- [ ] Fetch prompt text from 9 Notion pages (use Notion MCP tool)
- [ ] Load each prompt via POST /api/scan/prompts with correct wire/label/variant/toolType/sortOrder
- [ ] Verify all 9 appear in the Prompt Management card on dashboard

### Prompt Matrix
| Wire | Variant | Label | Sort | Notion Page |
|------|---------|-------|------|-------------|
| crypto | A | Crypto A — Action Scan | 0 | 309000c0d59081a59b21dc94da540bc6 |
| crypto | B | Crypto B — Landscape Scan | 1 | 309000c0d59081b190c2f4e615046199 |
| crypto | C | Crypto C — Open Sweep | 2 | 309000c0d59081e89903f1ddba8ad53b |
| ai | A | AI A — Action Scan | 0 | 309000c0d590815989aaf297c996329a |
| ai | B | AI B — Landscape Scan | 1 | 309000c0d5908146b101df00589b48e6 |
| ai | C | AI C — Open Sweep | 2 | 309000c0d59081c3a601ee8cb423ea36 |
| oss | A | OSS A — Action Scan | 0 | 309000c0d59081799254c5056d746bec |
| oss | B | OSS B — Landscape Scan | 1 | 309000c0d5908115bd59cf3d7583d300 |
| oss | C | OSS C — Open Sweep | 2 | 309000c0d59081f5ab84db03a49bf1dd |

All: `toolType: "x_search"`, `isActive: true`, `responseFormat: ""`

---

## Phase 2: Test Prompts
- [ ] Test each prompt via POST /api/scan/prompts/:id/test (one at a time)
- [ ] Check that parser picks up entries (Strategy 3 = X-post format expected)
- [ ] If any prompt returns 0 parseable results, consider adding a responseFormat requesting structured output
- [ ] Note: each test takes 60-90s (Grok Responses API call)
- [ ] Document which prompts parse well vs need format tweaks

---

## Phase 3: First Manual Scan Run
- [ ] Run manual scan for crypto wire: POST /api/scan/run { "wire": "crypto" }
- [ ] Monitor progress via SSE (dashboard shows progress bar)
- [ ] Full run of 3 prompts takes ~3-5 min
- [ ] Check the queue page (/queue) for results
- [ ] Verify: quality scores look reasonable, dedup is working, good entries score >= 40
- [ ] Approve a few entries to test the full flow through to thewireroom.xyz
- [ ] Repeat for ai and oss wires

---

## Phase 4: Set Up Daily Schedules
- [ ] Create scan-execution schedule for each wire (or one for all)
- [ ] Recommended: daily at a quiet hour (e.g., 6 AM PT)
- [ ] Use the Scheduled Runs card on dashboard (+ Add Schedule)
- [ ] Type: scan-execution, set cron expression
- [ ] Verify scheduler picks them up (Scheduler Health shows "Active")

---

## Phase 5: Enable Distribution (Crypto Telegram First)
- [ ] Open Distribution Settings on dashboard
- [ ] Configure crypto wire: enable, set Telegram channel to @cryptograntwire
- [ ] Test Connection to verify bot can see the channel
- [ ] Approve a queued entry and verify it posts to Telegram
- [ ] Later: configure ai and oss Telegram channels
- [ ] Later: set up aggregated X account and configure X credentials

---

## Phase 6: Validate & Tune
- [ ] Run for 2-3 days with manual review
- [ ] Check Prompt Effectiveness stats (dashboard card)
- [ ] Tune quality scoring thresholds if needed (src/services/quality-scorer.ts)
- [ ] Adjust dedup sensitivity if too many duplicates slip through or good entries get caught
- [ ] Consider adding responseFormat to prompts that parse poorly

---

## Phase 7: Sunset Manual Workflow
- [ ] Once pipeline consistently surfaces good entries daily
- [ ] Daily routine becomes: open /queue, review pending entries, approve/decline
- [ ] TeleSum continues for ad-hoc submissions
- [ ] Manual Grok scans no longer needed

---

## Key Commands Reference
```bash
# Test a prompt (replace :id)
curl -X POST https://wire-room-ops-production.up.railway.app/api/scan/prompts/:id/test

# Run scan for one wire
curl -X POST https://wire-room-ops-production.up.railway.app/api/scan/run \
  -H "Content-Type: application/json" -d '{"wire":"crypto"}'

# Check prompt stats
curl https://wire-room-ops-production.up.railway.app/api/scan/prompt-stats?days=7
```

## Notes
- Full 9-prompt scan takes ~9-14 minutes
- Pipeline: prompts → Grok Responses API → parse → dedup → score → queue
- Quality threshold: 40 (entries below get archived, not queued)
- Parser tries 4 strategies in order; Strategy 3 (X-post format) matches Grok output
- Distribution is fire-and-forget on approve, never blocks
