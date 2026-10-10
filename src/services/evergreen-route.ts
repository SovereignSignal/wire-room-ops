/**
 * Parallel discovery keeps finding standing programs (OpenSats, Brink, and
 * the like) that have no new round. The wire queue declines those as
 * "evergreen rolling, no new window". grants.watch still wants the GRANT
 * label, so the row leaves the wire queue the same way a stale Grants.gov
 * listing does: status archived, classification unchanged, with a registry
 * lane stamp a consumer can filter on.
 *
 * grants.watch read: classification = 'GRANT' AND metadata->>'registry_lane'
 * = 'grants.watch', including archived rows.
 */

export const EVERGREEN_REGISTRY_LANE = 'grants.watch';
export const EVERGREEN_ARCHIVED_REASON = 'evergreen_open_program';
export const EVERGREEN_REASON_SUFFIX = 'Evergreen open program with no new window; routed to grants.watch registry review.';

const STANDING_PROGRAM = /\b(evergreen|rolling|ongoing|year-round|year round|always open|open-ended|open ended|continuously open|no deadline|standing (?:program|call|fund))\b/i;
const ROLLING_DEADLINE = /^\s*rolling\s*$/i;
const NEW_WINDOW = /\b(applications (?:are |is )?now open|call for proposals|newly announced|new (?:round|window|cycle|cohort)|round \d+|cohort \d+|fy20\d{2})\b/i;
const CALENDAR_DEADLINE = /\b(20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

export interface EvergreenRouteInput {
  scanSource?: string | null;
  promptVariant?: string | null;
  classification: string;
  wireArea?: string | null;
  /** Status the freshness gate already chose. */
  status: 'queued' | 'archived';
  deadline?: string | Date | null;
  deadlineParsed?: string | Date | null;
  name?: string | null;
  description?: string | null;
  operatorNotes?: string | null;
  hasNewCycle?: boolean;
}

export interface EvergreenRouteDecision {
  status: 'archived';
  metadata: {
    registry_lane: typeof EVERGREEN_REGISTRY_LANE;
    archived_reason: typeof EVERGREEN_ARCHIVED_REASON;
    operator_route: 'park';
  };
  reasonSuffix: string;
}

function textOf(value: string | Date | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  return String(value);
}

function hasParsedDeadline(value: string | Date | null | undefined): boolean {
  if (value == null || value === '') return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return !Number.isNaN(Date.parse(String(value)));
}

/**
 * Parallel variant P only. A dated deadline, a new-cycle stamp, or new-window
 * language stays on the wire. Empty copy with no standing-program language
 * stays on the wire too.
 */
export function applyEvergreenRegistryRoute(input: EvergreenRouteInput): EvergreenRouteDecision | null {
  if (input.scanSource !== 'web-search' || input.promptVariant !== 'P') return null;
  if (input.classification !== 'GRANT') return null;
  if (input.status !== 'queued') return null;
  if (input.hasNewCycle) return null;
  const area = (input.wireArea || '').trim().toLowerCase();
  if (area && area !== '3') return null;
  if (hasParsedDeadline(input.deadlineParsed)) return null;

  const deadline = textOf(input.deadline).trim();
  const blob = [input.name, input.description, deadline, input.operatorNotes].map(textOf).join('\n');
  if (NEW_WINDOW.test(blob)) return null;
  if (CALENDAR_DEADLINE.test(deadline) && !ROLLING_DEADLINE.test(deadline)) return null;

  const standing = ROLLING_DEADLINE.test(deadline) || STANDING_PROGRAM.test(blob);
  if (!standing) return null;

  return {
    status: 'archived',
    metadata: {
      registry_lane: EVERGREEN_REGISTRY_LANE,
      archived_reason: EVERGREEN_ARCHIVED_REASON,
      operator_route: 'park',
    },
    reasonSuffix: EVERGREEN_REASON_SUFFIX,
  };
}
