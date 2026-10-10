/**
 * Share of decided rows that were approved.
 * Null when the window has no approve or decline, so an all-duplicate
 * ingest does not read as a 0% approval rate.
 */
export function reviewedApprovalRate(approved: number, declined: number): number | null {
  const reviewed = approved + declined;
  if (!(reviewed > 0) || !Number.isFinite(reviewed)) return null;
  return Math.round((approved / reviewed) * 1000) / 1000;
}
