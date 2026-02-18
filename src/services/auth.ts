import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { MagicLinkToken } from '../types';

// In-memory store for tokens (in production, use Redis or database)
const tokens = new Map<string, MagicLinkToken>();

// Session store for logged-in users
interface Session {
  email: string;
  createdAt: Date;
  expiresAt: Date;
}
const sessions = new Map<string, Session>();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto
    .createHmac('sha256', config.auth.magicLinkSecret)
    .update(token)
    .digest('hex');
}

export function createLoginMagicLink(email: string): string {
  const token = generateToken();
  const hashedToken = hashToken(token);
  
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 15);
  
  const tokenData: MagicLinkToken = {
    token: hashedToken,
    email,
    fileId: 'login',
    expiresAt,
    used: false,
  };
  
  tokens.set(hashedToken, tokenData);
  cleanupExpiredTokens();
  
  return `${config.app.url}/auth?token=${token}`;
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

export function validateMagicLink(token: string): { valid: boolean; fileId?: string; email?: string; error?: string } {
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

export function createSessionToken(email: string): string {
  const token = generateToken();
  const hashedToken = hashToken(token);

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setHours(expiresAt.getHours() + 24);

  sessions.set(hashedToken, {
    email,
    createdAt: now,
    expiresAt,
  });

  cleanupExpiredSessions();
  return token;
}

export function validateSession(token: string): boolean {
  const hashedToken = hashToken(token);
  const session = sessions.get(hashedToken);

  if (!session) {
    return false;
  }

  if (new Date() > session.expiresAt) {
    sessions.delete(hashedToken);
    return false;
  }

  return true;
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
  for (const [key, value] of sessions.entries()) {
    if (now > value.expiresAt) {
      sessions.delete(key);
    }
  }
}
