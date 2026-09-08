import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { MagicLinkToken } from '../types';
import { getPool } from '../db';

// In-memory store for tokens (in production, use Redis or database)
const tokens = new Map<string, MagicLinkToken>();

// Session store — DB-backed so sessions survive deploys
interface Session {
  email: string;
  createdAt: Date;
  expiresAt: Date;
}

// In-memory cache layer (populated from DB on validate)
const sessionCache = new Map<string, Session>();

// Ensure sessions table exists in DB (called at startup)
export async function ensureSessionsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);
  console.log('[Auth] Sessions table ready (DB-backed)');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto
    .createHmac('sha256', config.privy.appSecret)
    .update(token)
    .digest('hex');
}

export function createMagicLink(email: string, fileId: string): string {
  const token = generateToken();
  const hashedToken = hashToken(token);
  
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + config.auth.tokenExpiryHours);
  
  const tokenData: MagicLinkToken = {
    token: hashedToken,
    email,
    fileId,
    expiresAt,
    used: false,
  };
  
  tokens.set(hashedToken, tokenData);
  cleanupExpiredTokens();
  
  return `${config.app.url}/download?token=${token}`;
}

export function validateMagicLink(token: unknown): { valid: boolean; fileId?: string; email?: string; error?: string } {
  // Download tokens are UUIDs; magic-link tokens are hexadecimal strings.
  if (typeof token !== 'string' || !token) {
    return { valid: false, error: 'Invalid or expired link' };
  }
  const hashedToken = hashToken(token);
  const tokenData = tokens.get(hashedToken);
  
  if (!tokenData) {
    return { valid: false, error: 'Invalid or expired link' };
  }
  
  if (tokenData.used) {
    return { valid: false, error: 'This link has already been used' };
  }
  
  if (new Date() > tokenData.expiresAt) {
    tokens.delete(hashedToken);
    return { valid: false, error: 'This link has expired' };
  }
  
  // Mark as used
  tokenData.used = true;
  tokens.set(hashedToken, tokenData);
  
  return { valid: true, fileId: tokenData.fileId, email: tokenData.email };
}

export async function createSessionToken(email: string): Promise<string> {
  const token = generateToken();
  const hashedToken = hashToken(token);

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + 7); // 7-day sessions (survive deploys)

  const session: Session = { email, createdAt: now, expiresAt };

  // Persist to DB
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO sessions (token_hash, email, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO UPDATE SET email = $2, expires_at = $4`,
      [hashedToken, email, now, expiresAt]
    );
  } catch (err) {
    console.error('[Auth] Failed to persist session to DB:', err);
    // Fall through — cache will still work for this deploy
  }

  sessionCache.set(hashedToken, session);
  cleanupExpiredSessions();
  return token;
}

export async function getSessionEmail(token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hashedToken = hashToken(token);

  // Check in-memory cache first
  const cached = sessionCache.get(hashedToken);
  if (cached) {
    if (new Date() > cached.expiresAt) {
      sessionCache.delete(hashedToken);
      // Clean from DB too (fire-and-forget)
      getPool().query('DELETE FROM sessions WHERE token_hash = $1', [hashedToken]).catch(() => {});
      return null;
    }
    return cached.email;
  }

  // Not in cache — check DB (session may have been created before this deploy)
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT email, created_at, expires_at FROM sessions WHERE token_hash = $1',
      [hashedToken]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const expiresAt = new Date(row.expires_at);
    if (new Date() > expiresAt) {
      pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashedToken]).catch(() => {});
      return null;
    }

    // Populate cache
    sessionCache.set(hashedToken, {
      email: row.email,
      createdAt: new Date(row.created_at),
      expiresAt,
    });
    return row.email;
  } catch (err) {
    console.error('[Auth] Failed to check session in DB:', err);
    return null;
  }
}

export async function validateSession(token: unknown): Promise<boolean> {
  return (await getSessionEmail(token)) !== null;
}

export async function invalidateSession(token: unknown): Promise<void> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return;
  const hashedToken = hashToken(token);
  sessionCache.delete(hashedToken);
  try {
    await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [hashedToken]);
  } catch (err) {
    console.error('[Auth] Failed to delete session from DB:', err);
  }
}

export function createDownloadToken(fileId: string): string {
  const token = uuidv4();
  const hashedToken = hashToken(token);

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 5);

  const tokenData: MagicLinkToken = {
    token: hashedToken,
    email: config.email.notificationEmail,
    fileId,
    expiresAt,
    used: false,
  };

  tokens.set(hashedToken, tokenData);
  cleanupExpiredTokens();

  return token;
}

function cleanupExpiredTokens(): void {
  const now = new Date();
  for (const [key, value] of tokens.entries()) {
    if (now > value.expiresAt) {
      tokens.delete(key);
    }
  }
}

function cleanupExpiredSessions(): void {
  const now = new Date();
  for (const [key, value] of sessionCache.entries()) {
    if (now > value.expiresAt) {
      sessionCache.delete(key);
    }
  }
  // Also clean DB (fire-and-forget)
  getPool().query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {});
}

// Periodic cleanup timer for tokens and sessions
let authCleanupTimer: NodeJS.Timeout | null = null;

export function startAuthCleanup(): void {
  if (authCleanupTimer) return;
  authCleanupTimer = setInterval(() => {
    cleanupExpiredTokens();
    cleanupExpiredSessions();
  }, 15 * 60 * 1000); // every 15 minutes
  authCleanupTimer.unref();
}

export function stopAuthCleanup(): void {
  if (authCleanupTimer) {
    clearInterval(authCleanupTimer);
    authCleanupTimer = null;
  }
}

// Start cleanup on module load
startAuthCleanup();
