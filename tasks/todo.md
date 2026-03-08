# UI Refresh Task Plan

## Checklist

- [x] Inspect the current dashboard, queue, shared shell, and feed/config routes to confirm actual navigation and workflow issues.
- [x] Make `/queue` the single authenticated landing page and add feed-scoped prompts/distribution routes with legacy redirects.
- [x] Rework the shared shell into task-first navigation with feed tabs and remove the dead `+ Add Feed` nav link.
- [x] Redesign the queue into a URL-synced review workspace with pagination, detail panel/drawer, toasts, and diagnostics separated from primary actions.
- [x] Simplify feed overview pages around triage and add clear navigation back to the filtered queue.
- [x] Add real feed management to Setup using the existing feed APIs.
- [x] Extend the queue API to optionally include distribution status per entry.
- [x] Run `npm run typecheck` and record verification notes.

## Review

- Implemented task-first navigation, queue-first routing, feed-scoped prompts/distribution pages, and Setup feed management.
- Replaced the old queue card layout with a URL-synced workspace that supports pagination, detail review, diagnostics separation, copyable state, and undo toasts.
- Extended the queue API to include per-entry distribution status via `includeDistributionStatus=1`, allowing approved views to render distribution state without follow-up fetches.
- Verification: `npm run typecheck` passed.
- Not verified in-browser: desktop/mobile rendering, live queue interactions, and route redirects still need a manual runtime check with a configured local environment.

## Follow-Up: Feed Management Clarity

- [x] Replace the wide feed-management table with a clearer existing-feeds list that keeps edit/remove actions visible.
- [x] Clarify the difference between feed key and display name directly in the Setup form.
- [x] Re-run typecheck and record the verification result.

## Follow-Up Review

- Replaced the Setup feed table with stacked feed cards so `Edit Feed`, `Open Workspace`, and `Remove Feed` are visible without horizontal scanning.
- Clarified feed-field semantics directly in the form with `Key (internal slug)` and `Display Name (shown in UI)` helper copy.
- Hardened `GET /api/feeds` so missing historical `summaries` data no longer breaks feed management; feed entry counts now fail open to `0` instead of taking down the list.
- Verification: `npm run typecheck` passed, `/api/feeds?includeArchived=true` returns seeded feeds again, and the Setup page source includes the new feed management actions and field labels.

## Follow-Up: Feed Key Simplification

- [x] Remove manual key entry from the primary feed-creation flow and make the user-facing name the only required field.
- [x] Generate feed keys server-side from the name while keeping explicit-key API compatibility for advanced/internal callers.
- [x] Re-run typecheck and refresh local dev preview for verification.

## Feed Key Simplification Review

- Simplified the Setup feed form so operators create feeds with a single `Feed Name`; the internal key is generated automatically and only shown as read-only context when editing an existing feed.
- Updated the create-feed API to accept an omitted key and derive a stable route slug from the display name, with numeric suffixes when needed to avoid collisions.

## Follow-Up: Prompt Lab

- [x] Inspect the existing prompt CRUD/test flow and identify the gap between pass/fail testing and actual prompt tuning.
- [x] Add draft prompt testing that shows raw yield plus parsed opportunities without forcing a save first.
- [x] Add Claude-based prompt review with concrete suggestions and an apply-back-to-editor workflow.
- [x] Re-run typecheck and refresh local dev preview for verification.

## Prompt Lab Review

- Added a prompt lab inside the prompt editor so operators can run the current draft prompt, inspect the raw output, see how many opportunities parsed successfully, and review extracted results before saving.
- Added Claude-backed prompt review that returns a score, strengths, risks, suggestions, and revised prompt/response format text that can be applied directly into the editor.
- Added backend draft-test and prompt-review APIs so testing/tuning works for unsaved edits, not just stored prompts.
- Updated Anthropic fallback models toward current Claude family defaults so the review path targets a real high-end Claude model instead of stale placeholder IDs.

## Follow-Up: Feed Archive Semantics

- [x] Rename feed-management actions and copy so archive behavior is labeled accurately.
- [x] Remove the redundant Setup-level workspace action and make `Edit Feed` clearly lead into the inline editor.
- [x] Add a reactivation path for archived feeds.
- [x] Re-run typecheck and refresh local dev preview for verification.

## Feed Archive Semantics Review

- Replaced `Remove Feed` with `Archive Feed`, updated the surrounding copy to describe archive/reactivate behavior accurately, and removed the ambiguous `Open Workspace` action from Setup.
- `Edit Feed` now scrolls and focuses the inline feed editor so the action directly leads to the place where metadata changes happen.
- Archived feeds now expose `Reactivate Feed`, backed by the existing feed update path with `archived: false`.
