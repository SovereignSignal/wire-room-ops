/**
 * OSS Parallel discovery prompt. AI and crypto already ask for the last 21
 * days. This one was still searching the funders the feed lane watches
 * directly (NLnet, Sovereign Tech Agency, Alpha-Omega).
 */
export const OSS_PARALLEL_DISCOVERY_PROMPT = [
  'Find newly announced open-source funding from the last 21 days (maintainer grants, security funds, foundation rounds, fellowships with a new window). Exclude VC, closed programs, aggregator roundups, and evergreen programs with no new round. Do not search NLnet, Sovereign Tech Agency, or Alpha-Omega.',
  'Search queries: "open source" "applications are now open" fund 2026 | "maintainers" grant program launched 2026 | "open source" security funding round announced | "call for proposals" open source maintainers 2026 | OSS fellowship "applications open" 2026',
].join('\n');

const OLD_OSS_QUERY = /nlnet ngi|sovereign tech fellowship|openssf alpha-omega|open source endowment/i;

/**
 * True when an active OSS Parallel prompt still lacks the 21-day window or
 * still names the funders the feed lane already watches. The canonical text
 * is left alone, so a later operator edit is not refreshed on a re-apply
 * that never runs, and a one-shot migration does not loop.
 */
export function ossParallelPromptNeedsRefresh(text: string | null | undefined): boolean {
  const current = (text || '').trim();
  if (current === OSS_PARALLEL_DISCOVERY_PROMPT.trim()) return false;
  if (!/last 21 days/i.test(current)) return true;
  return OLD_OSS_QUERY.test(current);
}
