/**
 * Mint a scoped curator key. Prints the bearer token once and a JSON entry
 * that contains only the SHA-256 hash. Sov pastes that entry into
 * WIRE_ROOM_CURATOR_KEYS. The token is not written to disk.
 *
 *   npm run curator-key:mint -- --name hedwig --scopes read_queue,decide,propose
 *   npm run curator-key:mint -- --name hedwig --scopes read_queue,decide,propose --expires 2027-01-01T00:00:00Z
 */

import crypto from 'crypto';
import { CURATOR_SCOPES, hashCuratorToken, type CuratorScope } from '../services/curator-keys';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const name = arg('name')?.trim();
const scopesArg = arg('scopes');
const expiresArg = arg('expires');

if (!name) fail('Missing --name (example: --name hedwig)');
if (!scopesArg) fail(`Missing --scopes (comma-separated: ${CURATOR_SCOPES.join(', ')})`);

const scopes = scopesArg.split(',').map(scope => scope.trim()).filter(Boolean);
if (scopes.length === 0) fail('At least one scope is required');
for (const scope of scopes) {
  if (!CURATOR_SCOPES.includes(scope as CuratorScope)) {
    fail(`Unknown scope "${scope}". Valid: ${CURATOR_SCOPES.join(', ')}`);
  }
}

let expiresAt: string;
if (expiresArg) {
  const parsed = Date.parse(expiresArg);
  if (Number.isNaN(parsed)) fail('--expires must be a UTC ISO timestamp');
  expiresAt = new Date(parsed).toISOString();
} else {
  const year = new Date();
  year.setUTCFullYear(year.getUTCFullYear() + 1);
  expiresAt = year.toISOString();
}

const token = crypto.randomBytes(32).toString('base64url');
const entry = {
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'curator',
  name,
  sha256: hashCuratorToken(token),
  scopes,
  expires_at: expiresAt,
  revoked: false,
};

console.log('Token (store this once; it cannot be recovered from the hash):');
console.log(token);
console.log('');
console.log('Add this object to the WIRE_ROOM_CURATOR_KEYS JSON array. Do not put the token in the variable:');
console.log(JSON.stringify(entry, null, 2));
