# Scan Pipeline Integration Guide

## What This Is

This adds a scan intake pipeline to the existing grant-wire-summarizer. It handles:

1. **Intake**: Parsing structured scan results from Grok X-scan prompts
2. **Dedup**: URL exact match + fuzzy name matching to eliminate repeats
3. **Quality Scoring**: 0-100 score based on amount, deadline, actionability
4. **Daily Queue**: Surface only new, high-quality entries for review

The existing summarizer stays untouched. This adds new tables, new services, and new API routes that run alongside everything already there.

## Files to Add

Copy these into your existing repo structure:

```
src/
âââ types/
â   âââ intake.ts                    # New types (add alongside existing index.ts)
âââ services/
â   âââ intake.ts                    # Parser + URL/name normalization
â   âââ dedup.ts                     # Two-layer dedup service
â   âââ quality-scorer.ts            # Quality scoring engine
âââ jobs/
â   âââ daily-intake.ts              # Main intake job orchestrator
âââ db/
    âââ migrations/
        âââ add-scan-pipeline.sql    # New database tables
```

## Step 1: Run the Migration

Against your existing Postgres database:

```bash
psql $DATABASE_URL -f src/db/migrations/add-scan-pipeline.sql
```

This creates 4 new tables:
- `scan_entries` - All raw and processed scan results
- `seen_urls` - Fast URL dedup lookup
- `seen_names` - Fuzzy name matching lookup
- `intake_runs` - Job execution log

None of these touch your existing tables (summaries, messages, categories, schedules, etc.).

## Step 2: Add the Route to server.ts

Add these routes inside your authenticated section of `server.ts`:

```typescript
import {
  buildSubmission,
  buildBatchSubmission,
} from './services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from './jobs/daily-intake';

// ---- Scan Intake Routes ----

// Submit scan results (single prompt)
app.post('/api/scan/submit', async (req, res) => {
  try {
    const { rawText, wire, promptVariant, scanDate } = req.body;
    const submission = buildSubmission(rawText, wire, promptVariant, scanDate);

    const pool = getPool();
    const summary = await runDailyIntake(pool, [submission]);

    res.json({ success: true, summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Submit batch scan results (all prompts for a wire at once)
app.post('/api/scan/submit-batch', async (req, res) => {
  try {
    const { rawText, wire, scanDate } = req.body;
    const submissions = buildBatchSubmission(rawText, wire, scanDate);

    const pool = getPool();
    const summary = await runDailyIntake(pool, submissions);

    res.json({ success: true, summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get daily queue (new high-quality entries)
app.get('/api/scan/queue', async (req, res) => {
  try {
    const wire = req.query.wire as string || null;
    const date = req.query.date as string || null;
    const minScore = parseInt(req.query.minScore as string) || 40;

    const pool = getPool();
    const entries = await getDailyQueue(pool, wire as any, minScore, date);

    res.json({ entries, count: entries.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get intake stats for dashboard
app.get('/api/scan/stats', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;

    const pool = getPool();
    const stats = await getIntakeStats(pool, days);

    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

## Step 3: Add Scan Intake to the Dashboard

Add a new section to your dashboard HTML in `server.ts`. This gives you a paste-in form:

```html
<div class="section">
  <h2>Scan Intake</h2>
  <div style="display: flex; gap: 12px; margin-bottom: 12px;">
    <select id="scanWire">
      <option value="ai">AI</option>
      <option value="crypto">Crypto</option>
      <option value="oss">OSS</option>
    </select>
    <select id="scanPrompt">
      <option value="A">Prompt A</option>
      <option value="B">Prompt B</option>
      <option value="C">Prompt C</option>
    </select>
    <input type="date" id="scanDate" />
  </div>
  <textarea id="scanText" rows="12" placeholder="Paste structured scan output here..."
    style="width:100%; font-family: monospace; font-size: 13px;"></textarea>
  <button onclick="submitScan()">Process Scan</button>
  <div id="scanResult"></div>
</div>

<div class="section">
  <h2>Daily Queue</h2>
  <div style="display: flex; gap: 12px; margin-bottom: 12px;">
    <select id="queueWire" onchange="loadQueue()">
      <option value="">All Wires</option>
      <option value="ai">AI</option>
      <option value="crypto">Crypto</option>
      <option value="oss">OSS</option>
    </select>
    <input type="range" id="queueMinScore" min="0" max="100" value="40"
      oninput="document.getElementById('scoreLabel').textContent=this.value; loadQueue()">
    <span>Min Score: <span id="scoreLabel">40</span></span>
  </div>
  <div id="queueEntries"></div>
</div>
```

## Step 4: Add a Schedule for Daily Intake

You can reuse your existing scheduler. Add a new schedule type that triggers the
intake job. Or run it as a CLI command:

```typescript
// In package.json scripts:
"job:intake": "ts-node src/jobs/daily-intake-cli.ts"
```

## How the Pipeline Works

```
Raw Text (pasted or API)
         â
         â¼
   Parse Structured Output
   (extract name, desc, deadline, link, amount)
         â
         â¼
   Insert as scan_entries (status: raw)
         â
         â¼
   Dedup Check
   ââ Layer 1: URL exact match (seen_urls table)
   ââ Layer 2: Fuzzy name match (seen_names + token overlap)
   â
   ââ Duplicate? â status: duplicate, link to original
   ââ Unique? â status: deduped, register in seen tables
         â
         â¼
   Quality Score (0-100)
   ââ Has amount: +25
   ââ Amount > $5K: +15
   ââ Has deadline: +15
   ââ Deadline within 60 days: +10
   ââ Is funding opportunity: +20
   ââ Is actionable: +15
   ââ Governance noise: -15
   ââ Already awarded: -10
   â
   ââ Score >= 40? â status: queued
   ââ Score < 40? â status: archived
         â
         â¼
   Daily Queue (dashboard view)
   Only shows new, unique, quality entries
```

## Quality Score Thresholds

- **80-100**: Top tier. Real grant with dollar amount, deadline, and clear application path.
- **60-79**: Strong find. Has most signals of a real opportunity.
- **40-59**: Moderate. Worth reviewing but may be lower signal.
- **Below 40**: Archived. Governance proposals, already-awarded items, vague mentions.

## Connecting to the Existing Summarizer

Once entries are in the `scan_entries` table with status `queued`, they can be
fed into the existing summarizer pipeline. The bridge looks like this:

```typescript
// Get queued entries and insert them as messages for the summarizer
const queued = await getEnrichmentQueue(pool, 'ai', 50);

for (const entry of queued) {
  // Insert into existing messages table
  await pool.query(
    `INSERT INTO messages (extracted_urls, created_at)
     VALUES ($1, $2)`,
    [JSON.stringify([entry.source_url]), entry.scan_date]
  );

  // Update scan entry status
  await pool.query(
    `UPDATE scan_entries SET status = 'enriched' WHERE id = $1`,
    [entry.id]
  );
}
```

This bridges the scan pipeline into your existing AI enrichment and newsletter
generation flow without changing how the summarizer works.

## What's Next

1. **Web search intake**: Add automated web searches (grants.gov, foundation pages)
   as a new ScanSource that feeds into the same pipeline
2. **Auto-briefing email**: Use the daily queue to generate a short daily email
   with only high-quality new finds
3. **Historical backfill**: Import the existing 476-row CSV tracking file into
   scan_entries to seed the dedup tables
