import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { MagicLinkToken } from '../types';

// In-memory store for tokens (in production, use Redis or database)
const tokens = new Map<string, MagicLinkToken>();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto
    .createHmac('sha256', config.auth.magicLinkSecret)
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
  
  // Clean up expired tokens periodically
  cleanupExpiredTokens();
  
  return `${config.app.url}/download?token=${token}`;
}

export function validateMagicLink(token: string): { valid: boolean; fileId?: string; error?: string } {
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
  
  return { valid: true, fileId: tokenData.fileId };
}

export function createDownloadToken(fileId: string): string {
  // Create a one-time download token valid for 5 minutes
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
