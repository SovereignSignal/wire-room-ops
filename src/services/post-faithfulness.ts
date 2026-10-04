/**
 * Deterministic check that a draft only repeats facts from its input.
 * Numbers, currency, dates, news verbs, opinion lines, and invented
 * eligibility are rejected. Telegram HTML is checked when the draft is a post.
 */

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};

const NEWS_VERBS = [
  'opens', 'opened', 'opening',
  'launches', 'launched', 'launching', 'launch',
  'relaunches', 'relaunched', 'relaunching', 'relaunch',
  'announces', 'announced', 'announcing',
  'unveils', 'unveiled', 'unveiling',
  'debuts', 'debuted',
  'introduces', 'introduced',
  'rolls out', 'rolled out',
  'kicks off', 'kicked off',
  'new',
];

const OPINION_PHRASES = [
  'one of the',
  'worth exploring',
  'strong appetite',
  "don't miss",
  'do not miss',
  'first-of-its-kind',
  'first of its kind',
  'game-changing',
  'game changing',
  'cutting-edge',
  'cutting edge',
  'world-class',
  'world class',
  'best-in-class',
  'highly anticipated',
  'rare',
  'notable',
  'signals',
  'major',
  'significant',
  'groundbreaking',
  'unprecedented',
  'exciting',
  'revolutionary',
  'largest',
  'biggest',
  'unique',
  'leading',
  'premier',
  'flagship',
  'huge',
  'massive',
  'incredible',
  'remarkable',
  'crucial',
  'innovative',
  'historic',
  'landmark',
  'unparalleled',
  'exceptional',
  'outstanding',
  'prestigious',
];

const ELIGIBILITY_PHRASES = [
  'eligibility',
  'eligible',
  'open to',
  'applicants must',
  'must be based',
  'only for',
  'restricted to',
  'residents',
  'worldwide',
  'anyone can',
  'limited to',
];

const DEADLINE_PHRASES = ['rolling', 'no deadline', 'open-ended'];

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'a', 'code', 'pre', 'blockquote', 'span', 'tg-spoiler', 'tg-emoji',
]);

export interface FaithfulnessCheck {
  ok: boolean;
  violations: string[];
}

interface Span {
  start: number;
  end: number;
}

interface FoundDate {
  year: number;
  month: number;
  day: number | null;
}

function phraseRe(phrase: string): RegExp {
  const body = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s+');
  return new RegExp(`\\b${body}\\b`, 'i');
}

function visibleText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#\d+;/g, ' ');
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function canonicalNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1000) / 1000;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
  return String(rounded);
}

function scale(raw: string, suffix: string | undefined): string | null {
  const numeric = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const factor = suffix ? { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[suffix.toLowerCase()] ?? 1 : 1;
  return canonicalNumber(numeric * factor);
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some(span => start < span.end && end > span.start);
}

function findDates(text: string): { dates: FoundDate[]; spans: Span[] } {
  const dates: FoundDate[] = [];
  const spans: Span[] = [];
  const patterns: RegExp[] = [
    new RegExp(`\\b(20\\d{2})-(\\d{1,2})-(\\d{1,2})\\b`, 'gi'),
    new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, 'gi'),
    new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(20\\d{2})\\b`, 'gi'),
    new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(20\\d{2})\\b`, 'gi'),
    new RegExp(`\\b(${MONTH_PATTERN})\\s+(20\\d{2})\\b`, 'gi'),
  ];
  const push = (date: FoundDate, start: number, end: number) => {
    if (date.month < 1 || date.month > 12) return;
    if (date.day != null && (date.day < 1 || date.day > 31)) return;
    if (overlaps(spans, start, end)) return;
    dates.push(date);
    spans.push({ start, end });
  };
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const token = match[0];
      if (overlaps(spans, start, start + token.length)) continue;
      if (/^\d{4}-/.test(token)) {
        push({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, start, start + token.length);
      } else if (/^[A-Za-z]/.test(token) && match[3]) {
        push({ year: Number(match[3]), month: MONTHS[match[1].toLowerCase()], day: Number(match[2]) }, start, start + token.length);
      } else if (/^\d{1,2}\s+[A-Za-z]/.test(token)) {
        push({ year: Number(match[3]), month: MONTHS[match[2].toLowerCase()], day: Number(match[1]) }, start, start + token.length);
      } else if (/^[A-Za-z]/.test(token)) {
        push({ year: Number(match[2]), month: MONTHS[match[1].toLowerCase()], day: null }, start, start + token.length);
      } else if ((match[0].match(/\//g) || []).length === 2) {
        push({ year: Number(match[3]), month: Number(match[1]), day: Number(match[2]) }, start, start + token.length);
      } else if (match[2] && String(match[2]).length === 4) {
        push({ year: Number(match[2]), month: Number(match[1]), day: null }, start, start + token.length);
      }
    }
  }
  return { dates, spans };
}

function findCurrencies(text: string, occupied: Span[]): { values: string[]; spans: Span[] } {
  const values: string[] = [];
  const spans: Span[] = [];
  const pattern = /(?:(?:usd|eur|gbp|us\$|\$|€|£)\s*)(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*[kmb])?\b|\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*[kmb])\b(?:\s*(?:usd|eur|gbp))?/gi;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(occupied, start, end) || overlaps(spans, start, end)) continue;
    const amount = match[1] || match[3];
    const suffix = (match[2] || match[4] || '').trim();
    const value = scale(amount, suffix || undefined);
    if (!value) continue;
    values.push(value);
    spans.push({ start, end });
  }
  return { values, spans };
}

function findPlainNumbers(text: string, occupied: Span[]): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(occupied, start, end)) continue;
    const value = canonicalNumber(Number(match[0]));
    if (value) values.push(value);
  }
  return values;
}

function findNumberWords(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi)) {
    values.push(NUMBER_WORDS[match[1].toLowerCase()]);
  }
  return values;
}

function dateKey(date: FoundDate): string {
  const month = String(date.month).padStart(2, '0');
  if (date.day == null) return `${date.year}-${month}`;
  return `${date.year}-${month}-${String(date.day).padStart(2, '0')}`;
}

function unsupportedDates(inputDates: FoundDate[], outputDates: FoundDate[]): string[] {
  const full = new Set(inputDates.filter(date => date.day != null).map(dateKey));
  const months = new Set(inputDates.map(date => `${date.year}-${String(date.month).padStart(2, '0')}`));
  const violations: string[] = [];
  for (const date of outputDates) {
    if (date.day != null) {
      if (!full.has(dateKey(date))) violations.push(`date ${dateKey(date)} is not in the input`);
    } else if (!months.has(dateKey(date))) {
      violations.push(`date ${dateKey(date)} is not in the input`);
    }
  }
  return violations;
}

function absentPhrases(input: string, output: string, phrases: string[], label: string): string[] {
  const violations: string[] = [];
  for (const phrase of phrases) {
    const pattern = phraseRe(phrase);
    if (pattern.test(output) && !pattern.test(input)) violations.push(`${label} "${phrase}" is not in the input`);
  }
  return violations;
}

export function checkTelegramHtml(html: string): string[] {
  const violations: string[] = [];
  const tagRe = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g;
  const stack: string[] = [];
  let last = 0;
  for (const match of html.matchAll(tagRe)) {
    const start = match.index ?? 0;
    if (html.slice(last, start).includes('<')) violations.push('unescaped < in Telegram HTML');
    last = start + match[0].length;
    const name = match[1].toLowerCase();
    const closing = match[0].startsWith('</');
    const selfClosing = /\/>$/.test(match[0]);
    if (!ALLOWED_TAGS.has(name)) violations.push(`disallowed Telegram tag <${name}>`);
    if (!closing) {
      const attrs = match[2] || '';
      if (name === 'a') {
        const href = attrs.match(/\bhref\s*=\s*"([^"]*)"/i) || attrs.match(/\bhref\s*=\s*'([^']*)'/i);
        if (!href) violations.push('<a> needs an href');
        else if (!/^https?:\/\//i.test(unescapeAttr(href[1]).trim())) violations.push('<a> href must be an http(s) URL');
        const rest = attrs.replace(/\bhref\s*=\s*("[^"]*"|'[^']*')/i, '').trim();
        if (rest) violations.push('<a> has extra attributes');
      } else if (attrs.trim()) {
        violations.push(`<${name}> has attributes`);
      }
    }
    if (closing) {
      if (stack.pop() !== name) violations.push(`unbalanced </${name}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  if (html.slice(last).includes('<')) violations.push('unescaped < in Telegram HTML');
  if (stack.length) violations.push(`unclosed <${stack[stack.length - 1]}>`);
  return violations;
}

const COMMENTARY_RE = /\b(this shows|this means|this matters|why it matters|it matters|underscores|highlights the importance|should stay|should remain|ought to)\b/i;
const ATTRIBUTION_RE = /["“”]|\b(argues|argue|says|said|writes|wrote|believes|claims|contends|according to|noted that|in (?:his|her|their) view)\b/i;

function draftSentences(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Opinion stated as the writer's fact, without a named speaker or a quote. */
export function unattributedOpinionViolations(_input: string, output: string): string[] {
  const failures: string[] = [];
  for (const sentence of draftSentences(output)) {
    if (!COMMENTARY_RE.test(sentence) || ATTRIBUTION_RE.test(sentence)) continue;
    const claim = sentence.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!claim) continue;
    failures.push(`unattributed opinion: ${claim.slice(0, 180)}`);
  }
  return failures;
}

function hrefViolations(html: string, input: string): string[] {
  const violations: string[] = [];
  for (const match of html.matchAll(/\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = unescapeAttr(match[1]).trim();
    if (href && !input.includes(href)) violations.push(`link ${href} is not in the input`);
  }
  return violations;
}

/**
 * Every number, currency amount, and date in `output` must occur in `input`
 * after format normalization. News verbs, opinion lines, eligibility, and
 * rolling/no-deadline wording are flagged when the input does not say them.
 */
export function checkFaithfulness(input: string, output: string, opts: { html?: boolean } = {}): FaithfulnessCheck {
  const source = input || '';
  const draft = opts.html === false ? output || '' : visibleText(output || '');
  const inputDates = findDates(source);
  const outputDates = findDates(draft);
  const inputCurrency = findCurrencies(source, inputDates.spans);
  const outputCurrency = findCurrencies(draft, outputDates.spans);
  const allowed = new Set<string>([
    ...inputCurrency.values,
    ...findPlainNumbers(source, [...inputDates.spans, ...inputCurrency.spans]),
    ...findNumberWords(source),
  ]);
  const required = [
    ...outputCurrency.values.map(value => ({ kind: 'amount', raw: value, value })),
    ...findPlainNumbers(draft, [...outputDates.spans, ...outputCurrency.spans]).map(value => ({ kind: 'number', raw: value, value })),
    ...findNumberWords(draft).map(value => ({ kind: 'number', raw: value, value })),
  ];
  const violations = [
    ...unsupportedDates(inputDates.dates, outputDates.dates),
    ...required.filter(item => !allowed.has(item.value)).map(item => `${item.kind} ${item.raw} is not in the input`),
    ...absentPhrases(source, draft, NEWS_VERBS, 'news verb'),
    ...absentPhrases(source, draft, OPINION_PHRASES, 'opinion'),
    ...absentPhrases(source, draft, ELIGIBILITY_PHRASES, 'eligibility'),
    ...absentPhrases(source, draft, DEADLINE_PHRASES, 'deadline wording'),
    ...unattributedOpinionViolations(source, draft),
  ];
  if (opts.html !== false) {
    violations.push(...checkTelegramHtml(output || ''), ...hrefViolations(output || '', source));
  }
  return { ok: violations.length === 0, violations };
}
