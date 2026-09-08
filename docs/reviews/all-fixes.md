# System review: implementation follow-up

All eleven findings in [the original review](2026-09-07-system-review.md) have fixes and regression coverage. This report records local validation; it does not attest to a deployment. The original review records the behavior at its reviewed commit.

## Fixes

| Finding | Resulting behavior |
| --- | --- |
| R1: malformed session cookie crashes authentication | Runtime token validation rejects malformed inputs before hashing; middleware forwards unexpected errors to Express. |
| R2: organization merge loses related records | A single transaction transfers contacts and other relationships. Conflicting contact identifiers abort without deleting either organization. |
| R3: failed receipt persistence permits duplicate sends | A send claim precedes transport. Receipt persistence retries do not resend. Uncertain outcomes retain the claim and require human verification. |
| R4: scheduler retry is unbounded | Each occurrence gets at most one retry. A new occurrence cancels an older scheduled retry, and shutdown clears retry timers. |
| R5: platform-level dedup skips destinations | Claims, backlog selection, and retries distinguish wire, platform, and channel ID, including legacy destinations. |
| R6: stale pending claims never recover | Expired claims appear in a review panel with their message text and available receipt. Operators explicitly confirm delivery or non-delivery; the resolution records actor and time. |
| R7: verification outage advances weekly checkpoint | An all-unresolved batch fails before email and checkpoint updates. Explicitly verified closures remain valid results. |
| R8: weekly cap starves later wires | Verification slots rotate across wires. Overflow and unresolved entries persist as deferred IDs and remain eligible beyond the next date window. |
| R9: intended agent endpoints require a browser session | Accounts and grants-intel routes use their intended authentication middleware before the generic session-only mount. Publication review remains session-only. |
| R10: discovery budget misses provider spend | The gate includes covered discovery calls across providers, serializes paid discovery admission, waits for usage writes, and blocks on unknown pricing or failed usage accounting. |
| R11: deployment health ignores initialization failures | Railway checks `/ready`, which requires completed migrations, initialized scheduling, and a reachable database. `/health` remains liveness-only. |

## Additional improvements

- Approval and publication enqueue happen in one SQL statement. A leased database worker survives process restarts; quiet approvals remain excluded. Historical approvals are not automatically queued.
- Scheduler timing and outcome metadata persist across restarts. Partial scans are reported as partial failures rather than clean successes.
- Settings exposes uncertain delivery review, stalled publication jobs, unknown-cost indicators, and source outcomes based on intake records and successful delivery receipts.
- Source costs include only entry-linked usage. Shared or unlinked discovery spend is not presented as source-level return on investment.
- Vite's hashed asset filenames receive immutable caching. Compatible dependency updates and a targeted `qs` override clear the installed dependency audit findings without a major framework migration. The override's removal condition is documented in `CLAUDE.md`.

## Verification

- **720 tests passed, zero failures or skips**, under Node 22.23.2, matching CI's runtime family.
- Server and client type checks and production builds passed.
- Root and client dependency audits reported zero vulnerabilities after installation.
- Startup migrations and database regressions ran against disposable local PostgreSQL 17. CI uses PostgreSQL 16; that exact database version was not rerun locally.
- Regression coverage includes receipt-write failures, ambiguous transport outcomes, independent destinations, durable approvals, stale-claim resolution, weekly outage and carryover behavior, budget accounting and concurrency, bounded scheduler retries, authentication, and merge rollback.
- Browser smoke checks exercised the publication confirmation flow using a synthetic local message and verified its recorded resolution. Usage checks confirmed unknown-cost warnings and source outcome rendering.

No production credentials, paid provider calls, real outbound messages, or external Notion writes were used for validation.

## Release considerations and limits

Startup adds the publication queue and delivery-review columns and replaces the destination uniqueness index. Stage these migrations before release and verify `/ready`. Existing pending delivery records with no lease become review items; verify their actual destinations before resolving them. Do not clear claims wholesale or replay historical approvals.

Review production model pricing before enabling paid discovery. The budget gate controls admission using recorded or configured estimated costs; an already-running operation can exceed the remaining allowance. It does not replace a provider-side spending cap.

Publication transport and the database cannot commit atomically. Ambiguous deliveries require operator verification to avoid blind duplicate sends. These changes do not reconstruct contacts already lost by historical merges or reconcile past production deliveries.

An application rollback must account for the changed destination uniqueness index and pending claims. An older startup path may attempt to recreate the former, stricter index, which can conflict with newly valid destination records.
