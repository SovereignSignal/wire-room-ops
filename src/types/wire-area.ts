/** Wire eligibility, separate from classification. GRANT stays area 3 only. */
export const WIRE_AREAS = ['1', '2', '3', '4', '5', '6', 'out'] as const;
export type WireArea = typeof WIRE_AREAS[number];

export const WIRE_AREA_LIST = [
  '1 governance/treasury decisions that move capital or change a grant framework',
  '2 grant program results (awards, recipients, round outcomes, retros)',
  '3 open funding opportunities someone can apply to now',
  '4 incentives (liquidity/performance rewards; AI compute/API credits)',
  '5 research and analysis on funding mechanisms, including credible attributed commentary',
  '6 grant tools and infrastructure',
].join('; ');

export const WIRE_OUT_LIST = 'VC/equity raises (including AI lab raises), product launches not tied to funding, price/listings/regulation news, job posts outside a program';

/** Shared newsletter rule for Ollama and Grok summary prompts. */
export const FACTS_ONLY_SUMMARY_RULES = [
  "Use the funder's own verb. State only facts in the source: who, what, amount, dates, link.",
  "Include amounts and dates exactly as written; do not add counts, ratios, ROI or percentages unless they are the item's headline figure stated by the funder.",
  "No significance or 'why it matters' commentary.",
  "If the content couldn't be retrieved, return SKIP rather than summarizing from the title.",
].join(' ');

const WIRE_AREA_SET = new Set<string>(WIRE_AREAS);

export function parseWireArea(value: unknown): WireArea | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6) {
    return String(value) as WireArea;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return WIRE_AREA_SET.has(text) ? text as WireArea : null;
}

export function isWireEligibleArea(area: WireArea | null | undefined): area is Exclude<WireArea, 'out'> {
  return area != null && area !== 'out';
}

/** Model answer that means the page was not available, so no summary should be stored. */
export function isSummarySkip(text: string | null | undefined): boolean {
  return typeof text === 'string' && /^skip\b/i.test(text.trim());
}
