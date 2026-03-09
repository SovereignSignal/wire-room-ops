/**
 * Brand configuration — read from environment variables.
 *
 * Override these per deployment:
 *   BRAND_NAME        Display name (e.g. "The Wire Room", "Claw Consulting")
 *   BRAND_TAGLINE     Short descriptor shown under the name in emails
 *   BRAND_COLOR       Primary accent color as a CSS hex (e.g. "#f5a623")
 *   BRAND_URL         Base URL of the ops dashboard
 *   BRAND_FROM_NAME   Sender display name for outbound email
 *   BRAND_AUDIENCE    Who reads this — "grant seekers", "consulting clients"
 *   BRAND_CONTENT_TYPE  What we scan for — "grant funding opportunities", "AI consulting leads"
 *   BRAND_CONTENT_VERB  Action word — "apply for", "pursue", "respond to"
 *
 * Defaults ship as Wire Room values so existing deployments are unaffected.
 */

export interface BrandConfig {
  name: string;
  tagline: string;
  color: string;        // hex, used sparingly for links/highlights
  url: string;
  fromName: string;
  audience: string;     // who reads this
  contentType: string;  // what we scan for
  contentVerb: string;  // action word
}

export function getBrand(): BrandConfig {
  return {
    name:        process.env.BRAND_NAME         || 'The Wire Room',
    tagline:     process.env.BRAND_TAGLINE      || 'Intelligence Pipeline',
    color:       process.env.BRAND_COLOR        || '#2563eb',   // neutral blue default
    url:         process.env.BRAND_URL          || process.env.APP_URL || 'http://localhost:3000',
    fromName:    process.env.BRAND_FROM_NAME    || process.env.BRAND_NAME || 'The Wire Room',
    audience:    process.env.BRAND_AUDIENCE     || 'grant seekers',
    contentType: process.env.BRAND_CONTENT_TYPE || 'grant funding opportunities',
    contentVerb: process.env.BRAND_CONTENT_VERB || 'apply for',
  };
}
