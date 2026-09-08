# Round 1: authentication safety and organization merge integrity

Implements R1 and R2 from the system review as local changes. Nothing has been committed, pushed, or deployed.

## Behavior

- Session lookup and logout reject malformed tokens before hashing or accessing storage. Auth middleware forwards unexpected lookup errors to Express. Legacy download links also reject non-string query values while retaining UUID download-token support.
- Organization merges use one transaction and lock the source and target in a consistent order. Contacts, entries, programs, watched sources, and child relationships transfer before source deletion.
- Complementary contact fields combine. Distinct handles or Notion page IDs on the same normalized contact name cause an explicit error and leave both organizations unchanged. The merge does not guess which identifier to discard.
- External Notion archival retains its existing behavior and runs only after the database commit. No external Notion writes were exercised during testing.

## Verification

Eight new regression tests cover an actual HTTP child process, malformed input at the service boundary, valid session/revocation compatibility, async error forwarding, contact preservation, identifier conflicts, late-failure rollback, and the optional contact table.

Against original source copies, six regression tests failed and two compatibility tests passed. Against the changes, all eight passed. The full check pipeline passed: 703 tests, zero failures or skips, server and client type checks. The server build passed. Testing used a disposable local database and private test schemas, with no production credentials or paid-provider calls. Local runtime was Node 26 and PostgreSQL 17; the exact CI runtime was not rerun.

The original review remains a snapshot of its reviewed commit. The remaining findings were subsequently addressed in [the full implementation follow-up](all-fixes.md). Existing production data was not inspected or repaired by these changes.
