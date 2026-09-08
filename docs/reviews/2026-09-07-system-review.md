# Wire Room Ops system review

Reviewed 7 September 2026 at commit `dac68c78bada3be0feff2bb7cb3e38b9776aa2ac`.

**Fix the unauthenticated process crash first.** The review found 11 concrete issues across authentication, organization merging, publication recovery, scheduling, weekly selection, agent access, budgeting, and deployment readiness. The existing 695 tests pass, but the additional failure scenarios below reproduce behavior they do not cover.

This was a local, review-only assessment. Application code and lockfiles were unchanged. Production data, schedules, publication destinations, and external workspaces were not modified. No paid provider calls or real messages were sent. Synthetic sends and provider responses were used to exercise real orchestration and database behavior.

## Priority

P1 means fix before the next routine release or use of the affected operation. P2 means a reproducible correctness or operational defect to address next. These are engineering priorities, not claims that each condition has occurred in production.

| ID | Priority | Finding | Reproduced result |
|---|---|---|---|
| R1 | P1 | Malformed session cookie terminates the server | Unauthenticated request caused process exit 1 |
| R2 | P1 | Organization merge deletes discovered-contact records | Entry relinked; source contact registry lost |
| R3 | P1 | Receipt-write failure permits duplicate publication | Same entry sent twice |
| R4 | P1 | Scheduler's single retry is unbounded | Four failed attempts with another retry queued |
| R5 | P2 | Partial destination failures disappear from retry/backlog | Failed second Telegram destination never retried |
| R6 | P2 | Abandoned publication claims remain pending forever | Seven-day-old claim could not be reclaimed |
| R7 | P2 | Verification outage advances the weekly checkpoint | Zero verified items, successful draft, checkpoint advanced |
| R8 | P2 | Weekly cap silently excludes later wires | 40 AI items consumed the budget; OSS omitted |
| R9 | P2 | Session middleware blocks intended agent endpoints | Valid internal key received 401 on two agent routes |
| R10 | P2 | Discovery budget excludes other paid providers | $1,000 recorded Perplexity cost counted as $0 |
| R11 | P2 | Deployment probes liveness instead of readiness | Configured probe returned 200 while readiness returned 503 |

Machine-readable observations: [review evidence](2026-09-07-system-review-evidence.json).

## Findings and fixes

### R1. An unauthenticated malformed cookie crashes the Node process

**Source:** [auth middleware](../../src/middleware/auth.ts#L43), [session lookup](../../src/services/auth.ts#L120), [token hashing](../../src/services/auth.ts#L39).

The middleware casts `req.cookies.session` to `string` without validating it. Cookie-parser accepts a JSON cookie and returns an object. Hashing that object throws before the session lookup's error handling. The rejected async middleware promise escapes Express 4 and terminates the process under the tested runtime.

**Evidence:** a disposable server with authentication enabled received `GET /api/scan/entries` and `Cookie: session=j:%7B%22test%22%3A1%7D`. The connection closed with `UND_ERR_SOCKET`; the child exited 1 with `ERR_INVALID_ARG_TYPE` in `hashToken`. No valid session or database lookup was required.

**Fix:** validate cookie type and the generated token format before lookup; independently validate the service boundary. Forward async middleware failures to Express error handling. Regression-test malformed cookies in a child process and verify that a subsequent health request still succeeds.

### R2. Organization merge destroys the source contact registry

**Source:** [merge implementation](../../src/services/org-merge.ts#L55), [contact foreign key](../../src/services/contact-discovery.ts#L26).

`mergeOrgs` relinks entries and child organizations, then deletes the source organization. It never transfers `discovered_contacts`, whose foreign key uses `ON DELETE CASCADE`. Contact names, handles, and stored Notion page identifiers disappear from the local registry. This can also undermine future contact deduplication. The merge consists of separate statements without a transaction.

**Evidence:** merging two fixture organizations relinked the source entry, but left zero contacts on the target after deleting the source. The test disabled external Notion archival. This proves local registry loss, not deletion of Notion contact pages.

**Fix:** merge dependent records in a transaction before deletion, resolving `(org_id, name_norm)` conflicts while preserving identifiers. Inventory other dependencies, including `watch_surfaces`, whose organization link currently becomes null. Test collision handling and rollback on failure.

### R3. A successful publication becomes retryable when saving its receipt fails

**Source:** [send and finalization](../../src/services/distribution.ts#L371).

The same `try` covers both the external send and receipt persistence. If the send succeeds but finalization fails, the catch marks the claim `failed` without the returned external message ID. A subsequent attempt acquires a new claim and sends again.

**Evidence:** an injected one-time database failure after a successful mock send produced two sends for the same entry. The first log was `failed` with no external ID; the second was `success` with the second message ID.

**Fix:** distinguish send failure from receipt-storage failure. Retain the confirmed external ID and retry persistence without resending. Treat a crash during an ambiguous delivery as requiring reconciliation. Test send success followed by receipt failure and prove that recovery does not call the sender again.

### R4. Every scheduler retry resets its own retry limit

**Source:** [new attempt status](../../src/services/scheduler.ts#L317), [retry callback](../../src/services/scheduler.ts#L646).

Each executor invocation creates a new status object without `retried`. On failure, that object is marked retried and another invocation is scheduled five minutes later. The next invocation starts with a fresh object, so a persistent non-quota failure retries indefinitely. This can repeat provider work and failure notifications between normal scheduled occurrences.

**Evidence:** the real executor, with fake timers and a provider outage, ran four attempts and still queued a fifth.

**Fix:** keep an attempt number for one scheduled occurrence and reset it only for a new occurrence. Preserve the existing shutdown/reconfiguration cancellation. Test the maximum attempt count, recovery on the single retry, and overlapping scheduled occurrences.

### R5. Retry selection collapses distinct publication destinations

**Source:** [retry filters](../../src/services/distribution.ts#L472), [undistributed query](../../src/db/index.ts#L1685).

Retry logic records successful or pending platforms in a set such as `telegram`. One successful Telegram destination suppresses every other Telegram destination. The backlog query likewise excludes an entry once any selected platform has a successful or pending log. These filters discard work before the more precise per-destination claim logic can run.

**Evidence:** with two enabled Telegram destinations, A successful and B failed, retry selected zero entries, made zero sends, and the batch backlog excluded the entry.

**Fix:** compare the desired `(entry, wire, platform, destination)` deliveries with matching successful/pending claims. Share that calculation between immediate retry and backlog processing. Test that B retries while A remains untouched.

### R6. A process interruption can strand a pending publication indefinitely

**Source:** [pending/success uniqueness](../../src/db/index.ts#L1598), [claim acquisition](../../src/db/index.ts#L1737), [retry exclusion](../../src/services/distribution.ts#L474).

Pending rows block subsequent claims indefinitely. There is no stale-claim reconciliation path in the reviewed distribution flow. A process dying after claim creation can leave an entry permanently excluded from retries and the backlog.

**Evidence:** a fixture pending claim aged seven days still prevented a new claim.

**Fix:** add claim ownership, a lease, and reconciliation. Expiry alone must not authorize a resend: a process may have sent the message before crashing. Distinguish confirmed delivery, confirmed failure, and unknown outcome; expose unresolved cases to the operator. A durable publish queue can address R3, R5, and R6 together.

### R7. Failed verification can silently advance the weekly issue checkpoint

**Source:** [provider failures return null](../../src/services/parallel-task.ts#L72), [fallback](../../src/jobs/weekly-issue.ts#L474), [delivery and checkpoint](../../src/jobs/weekly-issue.ts#L520).

Parallel errors and timeouts become null item results. The weekly fallback only runs when the batch throws, so these failures produce dropped items instead. Even if every item is unverified, a successful draft delivery advances the prior-issue date. Earlier unresolved items can then fall outside the next issue's window.

**Evidence:** 41 published fixtures with null verification results produced zero featured/open items. A successful mock email was enough to advance the checkpoint.

**Fix:** return explicit verification outcomes, separating source-closed decisions from transport errors and missing evidence. Retry or apply the fallback to unresolved items. Preserve unresolved coverage across checkpoints and report a degraded run. Keep the requirement that published recommendations have verified evidence; do not solve this by publishing unverified items.

### R8. The weekly verification cap can exclude an entire wire

**Source:** [wire-first ordering](../../src/jobs/weekly-issue.ts#L210), [global cap](../../src/jobs/weekly-issue.ts#L476), [input slicing](../../src/jobs/weekly-issue.ts#L418).

The source query sorts by wire, then quality. Verification takes only the first 40 items across all wires. A busy alphabetically earlier wire consumes the entire allowance before later wires are considered. The advancing date checkpoint does not preserve the deferred items.

**Evidence:** 40 published AI fixtures followed by one OSS fixture caused exactly 40 checks and no OSS section, even with successful verification responses.

**Fix:** allocate a bounded verification budget across wires, deduplicate known repeats before paid verification, and carry deferred candidates forward. Test a highly uneven corpus and verify that a later wire remains eligible. Keep the published-only corpus boundary.

### R9. Valid internal keys cannot reach two intended agent APIs

**Source:** [session-only prefix](../../src/server.ts#L117), [grants intelligence mount](../../src/server.ts#L140), [accounts mount](../../src/server.ts#L150).

The generic `/api` schedule mount runs `requireAuth` before the later accounts and grants-intelligence mounts. Internal-key requests are rejected before reaching those routers' `requireAuthOrInternalKey` middleware. This repeats the mount-order problem already documented and handled for scan/feed triggers.

**Evidence:** the same valid internal key returned 200 from `/api/scan/entries`, but 401 from `/api/accounts/monitored` and `/api/grants-intel/summary`.

**Fix:** mount the narrow agent-capable routes before generic session middleware, or apply authentication only to matching handlers. Preserve human-only access elsewhere. Expand the authentication matrix to cover these endpoints.

### R10. The discovery budget does not count all providers it gates

**Source:** [budget calculation](../../src/services/budget-guard.ts#L39), [scan guard contract](../../src/jobs/scan-execution.ts#L119).

The scan executor describes the guard as covering Grok, Perplexity, and Parallel. Its spend query only sums Grok discovery usage, plus separately tracked X reads. Other provider usage does not reduce the available budget. The guard also runs once before the whole prompt loop, allowing a large run to cross the remaining allowance.

**Evidence:** a $1,000 synthetic Perplexity scan-usage record yielded `allowed: true`, `spentUsd: 0`, and `capUsd: 20`.

**Fix:** define the intended discovery scope explicitly by provider and purpose. Count all covered usage, and reserve/check allowance at each paid step with bounded concurrency. Preserve intentional exclusions for unrelated classification and summarization. Confirm the production provider mix before estimating financial impact.

### R11. The configured deployment health check ignores database readiness

**Source:** [Railway configuration](../../railway.json#L8), [health and readiness endpoints](../../src/server.ts#L50).

The repository config points Railway at `/health`, which always returns 200. `/ready` checks the database and migration failures but is unused by that gate. Railway uses a successful deployment health check before switching traffic, so a liveness response can admit an unusable instance. [Railway health-check documentation](https://docs.railway.com/deployments/healthchecks).

**Evidence:** an injected migration-health failure returned `/health = 200` and `/ready = 503`; the repository probe remained `/health`.

**Fix:** use `/ready` for deployment admission, and ensure it requires completed startup migrations. Decide explicitly whether scheduler initialization is required; it is currently informational only. Retain `/health` for liveness. Live Railway overrides were not inspected.

## Optimization opportunities

1. **Make publication durable in Postgres.** Record desired delivery work in the approval transaction, then let bounded workers claim and reconcile it. This addresses the three publication failures above and the process-local `setImmediate` handoff in [entry actions](../../src/services/entry-actions.ts#L259). The current stack can support this without another queue service.

2. **Optimize discovery using useful outcomes.** Connect existing run and usage records to new canonical programs, human approvals, and confirmed deliveries. Compare cost per useful result and reviewer effort across lanes before reducing frequency or changing providers. Intake volume alone does not prove publication value. Preserve intentionally disabled lanes and human queue policy unless measurements justify a change.

3. **Make unknown pricing visible.** [Cost estimation](../../src/services/api-usage.ts#L80) returns zero when pricing is missing. Default seeds do not cover every model used by weekly work; Parallel verification also logs `task-core` while requesting `core-fast`. Use an explicit unknown-cost state and reconcile usage identifiers with configured prices. Production custom pricing was not read, so this is a configuration and observability opportunity, not a measured live undercharge.

4. **Fix caching of built assets.** The [static-header regex](../../src/server.ts#L159) recognizes an eight-character hexadecimal hash, while the actual Vite build uses names such as `index-CQ-2ooDf.js`. All 11 generated JS/CSS assets missed the immutable-cache branch. Serve generated `/assets` files with immutable caching and keep the HTML entry uncached. This is a small, directly verified performance fix.

5. **Persist useful run health.** Record partial source failures, retry counts, duration, coverage, and cost alongside existing run records. Keep the operator view able to distinguish a completed job from a complete collection. Prioritize this over splitting the service or adding new infrastructure.

## Dependency maintenance

Read-only `npm audit` found three moderate server-package entries and three client-tooling entries: one high, one moderate, one low. Package counts include transitive chains and are not counts of independently reachable exploits.

| Installed dependency | Recommended investigation | Evidence and exposure |
|---|---|---|
| `qs 6.15.3`, through Express/body-parser | Resolve to a compatible patched release, including `6.16.0` or later | [Maintainer advisory](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g). No application parse-to-stringify exploit path was demonstrated. R1 is a separate, reproduced bug. |
| `browserslist 4.28.1` | Refresh the client lockfile to a patched version, including `4.28.7` or later | [Maintainer advisory](https://github.com/browserslist/browserslist/security/advisories/GHSA-c83g-rgw3-j3cx). Build tooling; no public runtime attack path established here. |
| `postcss 8.5.22` | Resolve to `8.5.23` or later | [Maintainer advisory](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp). Relevant when processing attacker-controlled CSS under the advisory's conditions. |
| `postcss-selector-parser 6.1.2` | Apply the compatible patch identified by npm audit | Low-severity client-tooling finding in the captured audit. |

Do not apply `npm audit fix --force` blindly: the server audit proposes an Express 5 major upgrade. Prefer a small compatible dependency update and run the existing checks; assess any framework migration separately.

## Verification and limits

| Check | Result |
|---|---|
| Server and client type checks | Passed |
| Server and client production builds | Passed |
| Startup migrations on a fresh disposable database | 21 passed |
| Existing automated suite | 695 passed, 0 failed, 0 skipped |
| Additional failure scenarios | 11 findings reproduced with controlled fixtures/injections |
| Browser smoke test | Overview, queue, paste intake, quiet approval, database, settings |
| Quiet-approval database check | Approved, `distributable = false`, zero delivery logs |
| Runtime | Local Node 26.8.1 and PostgreSQL 17.11; CI declares Node 22 and PostgreSQL 16 |
| Source state | Application source and lockfiles unchanged; review artifacts added |

The review traced intake, deduplication/classification, queue approval, distribution, weekly generation, organization/contact integration, agent authentication, schedules, usage, startup, and the dashboard. It did not inspect every line or establish exhaustive security coverage. Failure tests used real application functions and database operations with mocked external sends, provider responses, and selected faults.

Production environment overrides, actual channel receipts, live Notion/provider behavior, data volumes/query plans, and backup/restore or credential-rotation practices were not verified. The exact CI runtime should repeat the regression checks when fixes are implemented. No production incidents, actual spend totals, or source ROI are inferred from the local fixtures.

**Recommended sequence:** fix R1 and R2; correct R3 through R6 as a focused publication/scheduler reliability pass; repair weekly coverage and agent access; then align budgeting/readiness and apply dependency/cache maintenance. Add regression tests for these observed failures rather than increasing coverage with implementation-mirroring tests.
