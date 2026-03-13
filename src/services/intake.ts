/**
 * Intake Service
 *
 * Parses structured scan results (from Grok X-scan prompts or web searches)
 * into normalized ScanEntry records and inserts them into the database.
 *
 * Handles two input formats:
 * 1. Structured text output from our Grok prompts (the ** format)
 * 2. JSON array of results (for programmatic web search intake)
 */

import type {
  PromptVariant,
  ScanSource,
  RawScanResult,
  ScanSubmission,
} from '../types/intake';

/**
 * Strip markdown artifacts that Grok injects into output.
 * Removes reference-style links [[N]](url) and code fence markers.
 */
/**
 * Validate that a URL is "useful" — not just a bare domain homepage.
 * X/Twitter URLs are always trusted (Grok has direct access).
 * Web URLs require a meaningful path (depth >= 2 segments after domain).
 */
export function isUsefulUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // Reject bare "www" with no TLD (e.g. "https://www")
    if (!host || host === 'www' || !host.includes('.')) return false;
    // X/Twitter URLs: validate tweet ID length for x.com/i/status/ URLs
    if (host === 'x.com' || host === 'twitter.com') {
      const statusMatch = u.pathname.match(/\/(?:i\/)?status\/(\d+)/);
      if (statusMatch) {
        // Real tweet IDs are 18-20 digits; reject truncated ones
        return statusMatch[1].length >= 18;
      }
      // Non-status X URLs (profiles, etc.) — reject x.com/i/statu and similar truncations
      if (u.pathname.startsWith('/i/') && !u.pathname.startsWith('/i/status/')) return false;
      return true;
    }
    // t.co short links: trust (they redirect to the real URL)
    if (host === 't.co') return true;
    // Web URLs: require at least one meaningful path segment (not just /en/ or /about/)
    const genericSegments = new Set(['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'about', 'blog', 'home', 'index']);
    const segments = u.pathname.split('/').filter(s => s.length > 0 && !genericSegments.has(s.toLowerCase()));
    return segments.length >= 1;
  } catch {
    return false;
  }
}

function stripMarkdownArtifacts(text: string): string {
  return text
    .replace(/\[?\[(\d+)\]\]?\([^)]*\)/g, '')  // [[N]](url) or [N](url)
    .replace(/```[\w]*\n?/g, '')                 // ``` or ```json
    .replace(/\s{2,}/g, ' ')                     // collapse extra whitespace
    .trim();
}

// ============================================================
// Post-parse field sanitization
// ============================================================

/**
 * Post-parse sanitization: clean up fields that parsers may have mangled.
 * Applied uniformly to all parser strategy outputs.
 */
function sanitizeResult(result: RawScanResult): RawScanResult {
  let { name, description, amount, deadline, sourceUrl } = result;

  // 1. Name: truncate at 120 chars at word boundary
  if (name.length > 120) {
    // If name is a full sentence, move the excess text into description if empty
    const truncated = name.substring(0, 120).replace(/\s+\S*$/, '');
    if (!description || description.length < 10) {
      description = name; // Use full text as description
    }
    name = truncated || name.substring(0, 120);
  }

  // 2. Name: strip trailing junk after semicolons/closing parens that indicate parser leakage
  name = name.replace(/[;)]\s*.{10,}$/, '').trim();

  // 3. Deadline: reject if it looks like junk (contains URLs, semicolons, or is too long)
  if (deadline) {
    if (deadline.length > 50 || /[;)(]/.test(deadline) || /https?:\/\//.test(deadline)) {
      deadline = null;
    }
  }

  // 4. Amount: flag suspiciously low bare numbers without K/M/B suffix
  //    "$53" is almost certainly a misparse, but "$53K" and "$5,000" are fine
  if (amount) {
    const bareSmallAmount = amount.match(/^\$(\d{1,3})$/);
    if (bareSmallAmount) {
      const num = parseInt(bareSmallAmount[1]);
      if (num < 100) {
        amount = null; // Likely a misparse
      }
    }
  }

  // 5. Source URL: strip markdown link artifacts like "url](url" or trailing "](" fragments
  if (sourceUrl) {
    // Pattern: "https://x.com/foo/123](https://x.com/foo/123" — take the part before ](
    const mdArtifact = sourceUrl.indexOf('](');
    if (mdArtifact !== -1) {
      sourceUrl = sourceUrl.substring(0, mdArtifact);
    }
    // Strip trailing markdown/punctuation junk: ], ), ., ,, ;, :
    sourceUrl = sourceUrl.replace(/[\]\).,;:]+$/, '');
    // Strip trailing & from truncated UTM params (e.g. ?utm_source=Twitter&)
    sourceUrl = sourceUrl.replace(/&$/, '');
    // Detect truncated Google Forms URLs (form ID must be 50+ chars)
    if (sourceUrl.includes('google.com/forms/d/e/') && !sourceUrl.includes('/viewform')) {
      const formIdMatch = sourceUrl.match(/\/e\/([^/]+)/);
      if (formIdMatch && formIdMatch[1].length < 50) {
        sourceUrl = ''; // Truncated form ID, unusable
      }
    }
  }

  // 6. Description: if still empty after name truncation, provide a minimal fallback
  if (!description || description.trim().length === 0) {
    description = '';
  }

  return { name: name.trim(), description, amount, deadline, sourceUrl };
}

// ============================================================
// Text Parser: Structured Grok Output -> RawScanResult[]
// ============================================================

/**
 * Parses the structured output format our Grok prompts produce:
 *
 * **[Program Name]** - [Description]
 * Deadline: [date or "Rolling" or "None listed"]
 * Link: [URL]
 */
export function parseStructuredOutput(text: string): RawScanResult[] {
  // Strategy 1: Try structured text format (numbered list with bold names)
  const structured = parseStructuredText(text);
  if (structured.length > 0) return structured.map(sanitizeResult);

  // Strategy 2: Try JSON parsing (array of objects or wrapped array)
  const jsonResults = parseJsonOutput(text);
  if (jsonResults.length > 0) return jsonResults.map(sanitizeResult);

  // Strategy 4: Try X-post format (@Handle  Description / URL / date blocks)
  const xPosts = parseXPostFormat(text);
  if (xPosts.length > 0) return xPosts.map(sanitizeResult);

  // Strategy 3: Try lenient numbered list (no bold required, flexible URL detection)
  const lenient = parseLenientNumberedList(text);
  if (lenient.length > 0) return lenient.map(sanitizeResult);

  return [];
}

/**
 * Strategy 1: Original structured text format:
 * 1. **Name** — Description
 * Deadline: date
 * Link: URL
 */
function parseStructuredText(text: string): RawScanResult[] {
  const results: RawScanResult[] = [];
  const lines = text.split('\n');
  let currentEntry: Partial<RawScanResult> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match entry header: "1. **Program Name** — Description" or "**[Org] — Name**"
    // Also handles "**Org — Program Name**" (separator inside bold)
    const headerMatch = line.match(
      /^\d+\.\s+\*\*(.+?)\*\*\s*[—\-–:]\s*(.+)/
    ) || line.match(
      /^\*\*\[?(.+?)\]?\*\*\s*[—\-–:]\s*(.+)/
    ) || (() => {
      // Handle "**Org — Program Name**" where separator is inside bold
      const fullBold = line.match(/^\*\*(.+?)\*\*\s*$/);
      if (fullBold) {
        const inner = fullBold[1];
        // Use full bold text as name, no description from header
        if (inner.search(/\s*[—\-–]\s+/) > 0) {
          return [line, inner, ''];
        }
      }
      return null;
    })();
    if (headerMatch) {
      if (currentEntry && currentEntry.name) {
        results.push(currentEntry as RawScanResult);
      }
      const name = stripMarkdownArtifacts(headerMatch[1].trim());
      const desc = headerMatch[2] ? stripMarkdownArtifacts(headerMatch[2].replace(/\*+$/, '').trim()) : '';
      currentEntry = {
        name,
        description: desc,
        amount: extractAmount(desc),
        deadline: null,
        sourceUrl: '',
      };
      continue;
    }

    // Match bracket-wrapped metadata: [Key details: ...], [Direct URL: ...], [Date: ...]
    if (currentEntry && /^\[/.test(line)) {
      // [Direct URL: https://...] or [URL: https://...]
      const bracketUrlMatch = line.match(/^\[(?:Direct URL|Program URL|URL|Link|Source):\s*(https?:\/\/\S+)/i);
      if (bracketUrlMatch) {
        const u = bracketUrlMatch[1].replace(/[)\].,;:]+$/, '');
        if (isUsefulUrl(u)) currentEntry.sourceUrl = u;
        continue;
      }
      // [Key details: ...] — add to description
      const keyDetailsMatch = line.match(/^\[Key details?:\s*(.+)/i);
      if (keyDetailsMatch) {
        const details = keyDetailsMatch[1].replace(/\]$/, '').trim();
        currentEntry.description = (currentEntry.description || '') + ' ' + stripMarkdownArtifacts(details);
        if (!currentEntry.amount) currentEntry.amount = extractAmount(details);
        // Extract deadline from key details
        const dlMatch = details.match(/(?:deadline|due|closes|apply by)[:\s]+([^.\]]+)/i);
        if (dlMatch && !currentEntry.deadline) {
          currentEntry.deadline = normalizeDeadline(stripMarkdownArtifacts(dlMatch[1].trim()));
        }
        continue;
      }
      // [Date: ...] — skip
      if (/^\[Date:/i.test(line)) continue;
    }

    // Match deadline line
    const deadlineMatch = line.match(/^(?:Deadline|Due|Closes|Date):\s*(.+)/i);
    if (deadlineMatch && currentEntry) {
      currentEntry.deadline = normalizeDeadline(stripMarkdownArtifacts(deadlineMatch[1].trim()));
      continue;
    }

    // Match link/URL line (including "Direct URL", "Program URL" from updated prompts)
    const linkMatch = line.match(/^(?:Link|URL|Source|Website|Direct URL|Program URL):\s*(https?:\/\/\S+)/i);
    if (linkMatch && currentEntry) {
      const u = linkMatch[1].trim();
      if (isUsefulUrl(u)) {
        // "Program URL" is more specific than "Post URL" — always prefer it
        const isProgramUrl = /^(?:Program URL|Direct URL)/i.test(line);
        if (isProgramUrl || !currentEntry.sourceUrl) {
          currentEntry.sourceUrl = u;
        }
      }
      continue;
    }

    // Also catch bare URLs on their own line
    const bareUrlMatch = line.match(/^(https?:\/\/\S+)$/);
    if (bareUrlMatch && currentEntry && !currentEntry.sourceUrl) {
      const u = bareUrlMatch[1].trim();
      if (isUsefulUrl(u)) currentEntry.sourceUrl = u;
      continue;
    }

    // Match "Total: X results" line (end of output)
    if (line.match(/^Total:\s*\d+\s*results/i)) {
      if (currentEntry && currentEntry.name) {
        results.push(currentEntry as RawScanResult);
      }
      currentEntry = null;
    }
  }

  if (currentEntry && currentEntry.name) {
    results.push(currentEntry as RawScanResult);
  }

  return results;
}

/**
 * Strategy 2: Parse JSON output (array of objects or wrapped in an object).
 */
function parseJsonOutput(text: string): RawScanResult[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('\`\`\`')) {
    cleaned = cleaned.replace(/^\`\`\`(?:json)?\s*/, '').replace(/\s*\`\`\`$/, '');
  }

  const jsonStart = cleaned.indexOf('[');
  const objStart = cleaned.indexOf('{');

  let data: unknown;
  try {
    if (jsonStart !== -1 && (objStart === -1 || jsonStart < objStart)) {
      data = JSON.parse(cleaned.substring(jsonStart));
    } else if (objStart !== -1) {
      const parsed = JSON.parse(cleaned.substring(objStart));
      if (Array.isArray(parsed)) {
        data = parsed;
      } else if (parsed.results && Array.isArray(parsed.results)) {
        data = parsed.results;
      } else if (parsed.entries && Array.isArray(parsed.entries)) {
        data = parsed.entries;
      } else if (parsed.grants && Array.isArray(parsed.grants)) {
        data = parsed.grants;
      } else if (parsed.opportunities && Array.isArray(parsed.opportunities)) {
        data = parsed.opportunities;
      } else if (parsed.name || parsed.title) {
        data = [parsed];
      }
    } else {
      data = JSON.parse(cleaned);
    }
  } catch {
    return [];
  }

  if (!Array.isArray(data)) return [];

  const results: RawScanResult[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;

    const name = obj.name || obj.title || obj.program || obj.program_name || '';
    const description = obj.description || obj.desc || obj.summary || obj.details || '';
    const sourceUrl = obj.sourceUrl || obj.source_url || obj.url || obj.link || '';

    if (!name && !description) continue;

    results.push({
      name: stripMarkdownArtifacts(String(name).trim()) || 'Unknown',
      description: stripMarkdownArtifacts(String(description).trim()) || 'Found via X scan',
      amount: obj.amount ? String(obj.amount) : extractAmount(String(description)),
      deadline: obj.deadline ? normalizeDeadline(String(obj.deadline)) : null,
      sourceUrl: (() => { const u = String(sourceUrl).trim(); return isUsefulUrl(u) ? u : ''; })(),
    });
  }

  return results;
}

/**
 * Strategy 3: Lenient numbered list parser.
 * Handles formats without markdown bold, different separators, inline URLs.
 */
function parseLenientNumberedList(text: string): RawScanResult[] {
  const results: RawScanResult[] = [];
  const lines = text.split('\n');
  let currentEntry: Partial<RawScanResult> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Match numbered entry: "1. Name - Description" or "1) Name: Description"
    const headerMatch = line.match(
      /^\d+[.)]\s+\*{0,2}([^*\n]+?)\*{0,2}\s*[—\-–:]\s*(.+)/
    );
    if (headerMatch) {
      if (currentEntry && currentEntry.name) {
        results.push(finalizeLenientEntry(currentEntry));
      }
      const name = stripMarkdownArtifacts(headerMatch[1].trim());
      const description = stripMarkdownArtifacts(headerMatch[2].trim());
      const inlineUrl = description.match(/(https?:\/\/\S+)/);

      currentEntry = {
        name,
        description: description.replace(/https?:\/\/\S+/g, '').trim() || description,
        amount: extractAmount(description),
        deadline: null,
        sourceUrl: inlineUrl ? inlineUrl[1] : '',
      };
      continue;
    }

    if (currentEntry) {
      // Deadline patterns
      const deadlineMatch = line.match(/(?:Deadline|Due|Closes|Date|Expires|Apply by):\s*(.+)/i);
      if (deadlineMatch) {
        currentEntry.deadline = normalizeDeadline(stripMarkdownArtifacts(deadlineMatch[1].trim()));
        continue;
      }

      // Amount on its own line
      const amountMatch = line.match(/(?:Amount|Funding|Grant|Prize|Award|Value):\s*(.+)/i);
      if (amountMatch && !currentEntry.amount) {
        currentEntry.amount = extractAmount(amountMatch[1]) || amountMatch[1].trim();
        continue;
      }

      // URL patterns
      const urlMatch = line.match(/(?:Link|URL|Source|Website|More info|Apply|Details|Direct URL|Program URL):\s*(https?:\/\/\S+)/i);
      if (urlMatch) {
        const u = urlMatch[1].trim();
        if (isUsefulUrl(u)) currentEntry.sourceUrl = u;
        continue;
      }

      // Bare URL
      const bareUrl = line.match(/^(https?:\/\/\S+)$/);
      if (bareUrl && !currentEntry.sourceUrl) {
        const u = bareUrl[1].trim();
        if (isUsefulUrl(u)) currentEntry.sourceUrl = u;
        continue;
      }

      // URL embedded in text
      if (!currentEntry.sourceUrl) {
        const embeddedUrl = line.match(/(https?:\/\/\S+)/);
        if (embeddedUrl) {
          const u = embeddedUrl[1].trim();
          if (isUsefulUrl(u)) currentEntry.sourceUrl = u;
          continue;
        }
      }
    }
  }

  if (currentEntry && currentEntry.name) {
    results.push(finalizeLenientEntry(currentEntry));
  }

  return results;
}

/**
 * Strategy 4: Parse X-post format from Grok Responses API with x_search.
 * Grok often returns entries as blocks separated by blank lines:
 *
 * @Handle — Brief description
 * [Handle Label] — Brief description
 * [multi-line tweet content]
 * https://x.com/handle/status/...
 * YYYY-MM-DD
 */
function parseXPostFormat(text: string): RawScanResult[] {
  const results: RawScanResult[] = [];

  // Strip the "Model:" header line if present
  let content = text.replace(/^Model:.*\n/, '');

  // Normalize markdown-linked handles: [@Handle](url) -> @Handle
  content = content.replace(/\[@(\w+)\]\([^)]*\)/g, '@$1');

  const parseHeader = (rawLine: string): { author: string; title: string } | null => {
    const line = rawLine.trim().replace(/^\d+\.\s+/, '').replace(/^[-*]\s+/, '').replace(/\*{2,}/g, '');

    // @Handle — Title
    const atHandle = line.match(/^@([A-Za-z0-9_]{1,40})\s*[\u2014\u2013\-]\s+(.+)/);
    if (atHandle) {
      return {
        author: atHandle[1].trim(),
        title: atHandle[2].trim(),
      };
    }

    // [Handle Label] — Title
    const bracketed = line.match(/^\[([^\]\n]{1,120})\]\s*[\u2014\u2013\-]\s+(.+)/);
    if (bracketed) {
      return {
        author: stripMarkdownArtifacts(bracketed[1]).trim(),
        title: bracketed[2].trim(),
      };
    }

    return null;
  };

  // Split into blocks by recognized X-post headers
  const blocks: string[] = [];
  let currentBlock = '';

  for (const line of content.split('\n')) {
    const header = parseHeader(line);
    if (header && currentBlock.trim()) {
      blocks.push(currentBlock.trim());
      currentBlock = line + '\n';
    } else {
      currentBlock += line + '\n';
    }
  }
  if (currentBlock.trim()) blocks.push(currentBlock.trim());

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const header = parseHeader(lines[0]);
    if (!header) continue;
    const author = header.author;
    const title = header.title;

    // Collect description from body lines (skip header, URL, and date lines)
    let sourceUrl = '';
    const bodyLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Bracket-wrapped metadata lines: [Direct URL: ...], [Date: ...], [Key details: ...]
      const bracketUrlMatch = line.match(/^\[(?:Direct URL|Program URL|URL|Link|Source):\s*(https?:\/\/\S+)/i);
      if (bracketUrlMatch) {
        const u = bracketUrlMatch[1].replace(/[)\].,;:]+$/, '');
        if (isUsefulUrl(u)) sourceUrl = u;
        continue;
      }

      // [Date: ...] bracket lines — skip
      if (/^\[Date:/i.test(line)) continue;

      // URL line (standalone or as markdown link) — match any URL, not just X.com
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (urlMatch && line.replace(urlMatch[0], '').trim().length < 5) {
        const u = urlMatch[0].replace(/[)\].,;:]+$/, '');
        if (!sourceUrl || u.match(/x\.com|twitter\.com/)) sourceUrl = u;
        continue;
      }

      // Date line (YYYY-MM-DD or "Day, DD Mon YYYY..." format)
      if (/^\d{4}-\d{2}-\d{2}$/.test(line) || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+\w+\s+\d{4}/i.test(line)) {
        continue;
      }

      bodyLines.push(line);
    }

    // Build description from body (first 300 chars)
    const description = stripMarkdownArtifacts(bodyLines.join(' ').substring(0, 300).trim()) || stripMarkdownArtifacts(title);

    // Extract amount from combined text
    const fullText = title + ' ' + bodyLines.join(' ');
    const amount = extractAmount(fullText);

    // Extract deadline from body text — strip artifacts and limit to date portion
    let deadline: string | null = null;
    const deadlineMatch = fullText.match(/(?:deadline|due|closes|apply by)[:\s]+([^\n,]+)/i)
      || fullText.match(/(?:registration|applications?)\s*(?:close|end|due)[:\s]+([^\n,]+)/i);
    if (deadlineMatch) {
      // Strip Grok citation artifacts and truncate at common delimiters
      const cleaned = stripMarkdownArtifacts(deadlineMatch[1])
        .replace(/\s*[\[\(].+$/, '')  // strip anything in brackets after date
        .trim();
      deadline = normalizeDeadline(cleaned);
    }

    // Fallback: extract URL from body lines if none found on standalone URL line
    if (!sourceUrl) {
      for (const bl of bodyLines) {
        const embedded = bl.match(/(https?:\/\/\S+)/);
        if (embedded) {
          const u = embedded[1].replace(/[)\].,;:]+$/, '');
          if (isUsefulUrl(u)) { sourceUrl = u; break; }
        }
      }
    }

    results.push({
      name: author + ': ' + title.substring(0, 100),
      description,
      amount,
      deadline,
      sourceUrl,
    });
  }

  return results;
}


function finalizeLenientEntry(entry: Partial<RawScanResult>): RawScanResult {
  const rawUrl = entry.sourceUrl || '';
  return {
    name: entry.name || 'Unknown',
    description: entry.description || '',
    amount: entry.amount || null,
    deadline: entry.deadline || null,
    sourceUrl: isUsefulUrl(rawUrl) ? rawUrl : '',
  };
}

/**
 * Extract dollar/currency amounts from a description string.
 * Handles formats like: $50K, $3M, EUR 125M, GBP 4.5M, INR 500K, $5,000, etc.
 */
export function extractAmount(text: string): string | null {
  const currencyClass = '[\\u20AC\\u00A3\\u20B9\\u20A6]'; // EUR, GBP, INR, NGN symbols
  const dashClass = '[-\\u2013\\u2014]'; // hyphen, en dash, em dash

  // Match currency symbol + number + optional multiplier
  const patterns = [
    // $50,000 or $50K or $3M or $3.5M
    /(\$[\d,]+(?:\.\d+)?(?:\s*[KkMmBb](?:illion)?)?)/,
    // EUR 125M or GBP 4.5M
    new RegExp(`((?:${currencyClass}|USD|EUR|GBP|INR|NGN)\\s*[\\d,]+(?:\\.\\d+)?(?:\\s*[KkMmBb](?:illion)?)?)`, 'i'),
    // "Up to $X" or "up to EUR X"
    new RegExp(`(up\\s+to\\s+(?:[\\$${currencyClass}]|USD|EUR|GBP|INR|NGN)\\s*[\\d,]+(?:\\.\\d+)?(?:\\s*[KkMmBb](?:illion)?)?)`, 'i'),
    // "$5,000 to $350,000" ranges
    new RegExp(`([\\$${currencyClass}][\\d,]+(?:\\.\\d+)?(?:\\s*[KkMm])?\\s*(?:to|${dashClass})\\s*[\\$${currencyClass}]?[\\d,]+(?:\\.\\d+)?(?:\\s*[KkMm])?)`, 'i'),
    // "X million" or "X billion"
    /([\d,]+(?:\.\d+)?\s*(?:million|billion|mil|M|B)\s*(?:dollars|USD|EUR)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Parse a raw amount string into a numeric USD value and currency code.
 * Returns { numeric, currency } or null if unparseable.
 */
export function parseAmount(
  raw: string | null
): { numeric: number; currency: string } | null {
  if (!raw) return null;

  let currency = 'USD';
  let text = raw.trim();

  // Detect currency
  if (text.match(/\u20AC|EUR/i)) currency = 'EUR';
  else if (text.match(/\u00A3|GBP/i)) currency = 'GBP';
  else if (text.match(/\u20B9|INR/i)) currency = 'INR';
  else if (text.match(/\u20A6|NGN/i)) currency = 'NGN';
  else if (text.match(/N\$/)) currency = 'NAD';
  else if (text.match(/\bSOL\b/)) currency = 'SOL';
  else if (text.match(/\bSTX\b/)) currency = 'STX';
  else if (text.match(/\bENS\b/)) currency = 'ENS';
  else if (text.match(/USDT|USDC/i)) currency = 'USD';

  // Strip currency symbols and words
  text = text.replace(/[\$\u20AC\u00A3\u20B9\u20A6]/g, '');
  text = text.replace(
    /\b(USD|EUR|GBP|INR|NGN|SOL|STX|ENS|USDT|USDC|up\s+to|per\s+award|total|pool|prizes?|credits?|stipend|matching|varies|free)\b/gi,
    ''
  );
  text = text.trim();

  // Handle ranges: take the higher number
  const rangeMatch = text.match(
    /([\d,]+(?:\.\d+)?)\s*[KkMm]?\s*(?:to|[-\u2013\u2014])\s*([\d,]+(?:\.\d+)?)\s*([KkMmBb])?/
  );
  if (rangeMatch) {
    text = rangeMatch[2] + (rangeMatch[3] || '');
  }

  // Extract number and multiplier
  const numMatch = text.match(/([\d,]+(?:\.\d+)?)\s*([KkMmBb](?:illion)?)?/);
  if (!numMatch) return null;

  let numeric = parseFloat(numMatch[1].replace(/,/g, ''));
  const multiplier = (numMatch[2] || '').toLowerCase();

  if (multiplier === 'k') numeric *= 1_000;
  else if (multiplier === 'm' || multiplier === 'million' || multiplier === 'mil')
    numeric *= 1_000_000;
  else if (multiplier === 'b' || multiplier === 'billion')
    numeric *= 1_000_000_000;

  // Rough USD conversion for comparison purposes
  const fxRates: Record<string, number> = {
    USD: 1,
    EUR: 1.08,
    GBP: 1.26,
    INR: 0.012,
    NGN: 0.00063,
    NAD: 0.054,
    SOL: 150, // approximate, volatile
    STX: 1.5,
    ENS: 25,
  };

  const rate = fxRates[currency] || 1;
  const usdEquivalent = numeric * rate;

  return { numeric: Math.round(usdEquivalent), currency };
}

/**
 * Normalize deadline strings into consistent format.
 */
function normalizeDeadline(raw: string): string | null {
  const lower = raw.toLowerCase().trim();

  if (
    lower === 'none listed' ||
    lower === 'none' ||
    lower === 'n/a' ||
    lower === 'not specified' ||
    lower === ''
  ) {
    return null;
  }

  if (lower === 'rolling') return 'Rolling';
  if (lower === 'awarded') return null; // Already awarded, no deadline

  // Return the raw string for date parsing downstream
  return raw.trim();
}

/**
 * Try to parse a deadline string into a Date object.
 * Handles formats like "March 8, 2026", "8 March 2026", "2026-03-08", etc.
 */
export function parseDeadline(deadline: string | null): Date | null {
  if (!deadline || deadline === 'Rolling') return null;

  // Try direct parse first
  const d = new Date(deadline);
  if (!isNaN(d.getTime()) && d.getFullYear() >= new Date().getFullYear() - 1) return d;

  // Try common formats
  // "March 8, 2026" or "Mar 8 2026"
  const monthFirst = deadline.match(
    /(\w+)\s+(\d{1,2}),?\s*(\d{4})/
  );
  if (monthFirst) {
    const attempt = new Date(`${monthFirst[1]} ${monthFirst[2]}, ${monthFirst[3]}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  // "8 March 2026"
  const dayFirst = deadline.match(
    /(\d{1,2})\s+(\w+),?\s*(\d{4})/
  );
  if (dayFirst) {
    const attempt = new Date(`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  // "Feb 28" (assume current year)
  const monthDay = deadline.match(/(\w+)\s+(\d{1,2})$/);
  if (monthDay) {
    const year = new Date().getFullYear();
    const attempt = new Date(`${monthDay[1]} ${monthDay[2]}, ${year}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  return null;
}

// ============================================================
// Submission Builder
// ============================================================

/**
 * Build a ScanSubmission from raw text input and metadata.
 * This is the main entry point for the dashboard paste-in flow.
 */
export function buildSubmission(
  rawText: string,
  wire: string,
  promptVariant: PromptVariant,
  scanDate: string,
  source: ScanSource = 'x-scan'
): ScanSubmission {
  const results = parseStructuredOutput(rawText);

  return {
    wire,
    promptVariant,
    scanDate,
    source,
    results,
  };
}

/**
 * Build multiple submissions from a batch paste (all 3 prompts for a wire).
 * Expects sections labeled like "OSS Prompt A", "OSS Prompt B", etc.
 */
export function buildBatchSubmission(
  rawText: string,
  wire: string,
  scanDate: string,
  source: ScanSource = 'x-scan'
): ScanSubmission[] {
  const submissions: ScanSubmission[] = [];

  // Split on prompt headers
  const sectionPattern =
    /(?:^|\n)(?:#{1,3}\s*)?(?:(?:AI|Crypto|OSS)\s+)?Prompt\s+([ABC])\b/gi;
  const sections: Array<{ variant: PromptVariant; text: string }> = [];

  let lastIndex = 0;
  let lastVariant: PromptVariant | null = null;
  let match;

  // Reset regex
  sectionPattern.lastIndex = 0;

  while ((match = sectionPattern.exec(rawText)) !== null) {
    if (lastVariant !== null) {
      sections.push({
        variant: lastVariant,
        text: rawText.substring(lastIndex, match.index),
      });
    }
    lastVariant = match[1].toUpperCase() as PromptVariant;
    lastIndex = match.index;
  }

  // Capture last section
  if (lastVariant !== null) {
    sections.push({
      variant: lastVariant,
      text: rawText.substring(lastIndex),
    });
  }

  for (const section of sections) {
    const results = parseStructuredOutput(section.text);
    if (results.length > 0) {
      submissions.push({
        wire,
        promptVariant: section.variant,
        scanDate,
        source,
        results,
      });
    }
  }

  return submissions;
}

// ============================================================
// URL Normalization (re-exported from shared utility)
// ============================================================

export { normalizeUrl } from '../utils/url';

// ============================================================
// Name Normalization (for fuzzy matching)
// ============================================================

// Common words to strip for name comparison.
// These are words that appear frequently in grant/program names but don't
// identify a specific grant. Without filtering these, token-overlap dedup
// produces false positives (e.g. two unrelated grants both containing
// "proposal" and "treasury" would match).
const STOP_WORDS = new Set([
  // English determiners & prepositions
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'to', 'by',
  'with', 'on', 'at', 'from', 'into', 'via', 'per', 'its', 'this',
  'that', 'all', 'are', 'has', 'will', 'can', 'not', 'but', 'our',
  'their', 'your', 'how', 'who', 'what', 'any', 'each', 'more',

  // Grant / program structure words
  'program', 'programme', 'grant', 'grants', 'fund', 'funding', 'funded',
  'initiative', 'fellowship', 'hackathon', 'bounty', 'bounties',
  'challenge', 'competition', 'scholarship', 'accelerator', 'incubator',
  'cohort', 'season', 'phase', 'round', 'wave', 'new', 'batch',
  'proposal', 'proposals', 'rfp', 'rfc',

  // Governance & treasury (common in DAO names)
  'treasury', 'governance', 'dao', 'vote', 'voting', 'delegate',
  'allocation', 'allocate', 'budget',

  // Generic action / descriptor words
  'support', 'supporting', 'sponsor', 'sponsors', 'sponsorship',
  'build', 'builder', 'builders', 'building',
  'develop', 'developer', 'developers', 'development',
  'maintain', 'maintainer', 'maintainers', 'maintenance',
  'research', 'researcher', 'researchers',
  'contribute', 'contributor', 'contributors', 'contribution',
  'community', 'ecosystem', 'infrastructure', 'network', 'platform',
  'project', 'projects', 'activate', 'activates', 'launch', 'launching',

  // Common tech/crypto vocabulary that doesn't identify a specific grant
  'open', 'source', 'web3', 'web', 'blockchain', 'crypto',
  'decentralized', 'defi', 'token', 'tokens', 'nft', 'nfts',
  'smart', 'contract', 'contracts', 'protocol', 'protocols',
  'layer', 'chain', 'node', 'nodes', 'staking', 'stake',
  'onchain', 'offchain',

  // Financial terms
  'million', 'billion', 'usdc', 'usdt', 'usd', 'eth',

  // Generic qualifiers
  'global', 'annual', 'monthly', 'weekly', 'quarterly',
  'first', 'second', 'third', 'next', 'latest', 'upcoming',
  'public', 'private', 'pilot', 'beta', 'alpha',

  // Dynamically include current year ± 1 to avoid hardcoding
  ...Array.from({ length: 3 }, (_, i) => String(new Date().getFullYear() - 1 + i)),
]);

/**
 * Normalize a program name for fuzzy matching.
 * Strips common words, lowercases, removes special characters.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .sort()
    .join(' ')
    .trim();
}

/**
 * Extract significant tokens from a name for GIN index matching.
 */
export function extractNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}
