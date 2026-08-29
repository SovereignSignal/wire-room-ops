export const QUEUE_CLASSIFICATIONS = ['GRANT', 'EXPIRED', 'NEWS', 'NOISE', 'UNCHECKED'] as const;
export const QUEUE_ROUTES = ['publish', 'source_check', 'park', 'relationship_signal', 'decline'] as const;
export const QUEUE_SCORE_BANDS = ['strong', 'medium', 'weak', 'unscored'] as const;
export const QUEUE_TIMELINES = ['upcoming', 'no_date', 'expired'] as const;

export type QueueClassificationFilter = (typeof QUEUE_CLASSIFICATIONS)[number];
export type QueueRouteFilter = (typeof QUEUE_ROUTES)[number];
export type QueueScoreBand = (typeof QUEUE_SCORE_BANDS)[number];
export type QueueTimeline = (typeof QUEUE_TIMELINES)[number];

export interface QueueQueryFilters {
  wire: string | null;
  classification: QueueClassificationFilter | null;
  route: QueueRouteFilter | null;
  scoreBand: QueueScoreBand | null;
  timeline: QueueTimeline | 'all';
  entryId: string | null;
}

export interface QueueApiParams {
  wire?: string;
  classification?: string;
  route?: string;
  minScore?: number;
  maxScore?: number;
  unscored?: boolean;
  dateStatus?: QueueTimeline;
}

const CORE_WIRES = ['crypto', 'ai', 'oss'] as const;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? value as T : null;
}

export function emptyQueueFilters(): QueueQueryFilters {
  return {
    wire: null,
    classification: null,
    route: null,
    scoreBand: null,
    timeline: 'all',
    entryId: null,
  };
}

export function parseQueueSearch(search: string): QueueQueryFilters {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const wire = params.get('wire');
  return {
    wire: wire && (CORE_WIRES as readonly string[]).includes(wire) ? wire : null,
    classification: oneOf(params.get('classification'), QUEUE_CLASSIFICATIONS),
    route: oneOf(params.get('route'), QUEUE_ROUTES),
    scoreBand: oneOf(params.get('score'), QUEUE_SCORE_BANDS),
    timeline: oneOf(params.get('timeline'), QUEUE_TIMELINES) || 'all',
    entryId: params.get('entry'),
  };
}

export function serializeQueueSearch(filters: QueueQueryFilters): string {
  const params = new URLSearchParams();
  if (filters.wire) params.set('wire', filters.wire);
  if (filters.classification) params.set('classification', filters.classification);
  if (filters.route) params.set('route', filters.route);
  if (filters.scoreBand) params.set('score', filters.scoreBand);
  if (filters.timeline !== 'all') params.set('timeline', filters.timeline);
  if (filters.entryId) params.set('entry', filters.entryId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function queueFiltersToApi(filters: QueueQueryFilters): QueueApiParams {
  const params: QueueApiParams = {};
  if (filters.wire) params.wire = filters.wire;
  if (filters.classification) params.classification = filters.classification;
  if (filters.route) params.route = filters.route;
  if (filters.timeline !== 'all') params.dateStatus = filters.timeline;
  if (filters.scoreBand === 'strong') {
    params.minScore = 70;
  } else if (filters.scoreBand === 'medium') {
    params.minScore = 50;
    params.maxScore = 69;
  } else if (filters.scoreBand === 'weak') {
    params.minScore = 0;
    params.maxScore = 49;
  } else if (filters.scoreBand === 'unscored') {
    params.unscored = true;
  }
  return params;
}

export function queueFiltersActive(filters: QueueQueryFilters): boolean {
  return Boolean(
    filters.wire
    || filters.classification
    || filters.route
    || filters.scoreBand
    || filters.timeline !== 'all',
  );
}

export function queueFiltersEqual(a: QueueQueryFilters, b: QueueQueryFilters): boolean {
  return a.wire === b.wire
    && a.classification === b.classification
    && a.route === b.route
    && a.scoreBand === b.scoreBand
    && a.timeline === b.timeline
    && a.entryId === b.entryId;
}
