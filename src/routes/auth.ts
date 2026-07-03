/**
 * Auth & File Routes
 *
 * GET    /                — login page or redirect to SPA
 * POST   /api/auth/callback — Privy token exchange
 * GET    /logout          — destroy session and redirect
 * GET    /file/:fileId    — download a stored file (session required)
 * POST   /resend-link     — resend download link for latest file
 * GET    /download        — legacy email download link landing page
 * GET    /download/:token — legacy token-based file download
 */

import path from 'path';
import { Router, Request, Response } from 'express';
import { config } from '../config';
import { verifyPrivyToken, isDevMode } from '../middleware/auth';
import { createSessionToken, validateSession, invalidateSession, createMagicLink, createDownloadToken, validateMagicLink } from '../services/auth';
import { getFile, listFiles } from '../services/storage';
import { sendResendLinkEmail } from '../services/email';
import { rateLimit } from '../middleware/rate-limit';
import { renderLoginPage } from '../views/login';
import { renderErrorPage, renderLegacyDownloadPage, renderExpiredLinkPage, renderResendSuccessPage } from '../views/error';
import { requireAuth } from '../middleware/auth';
import { StoredFile } from '../types';

const router = Router();

// Landing page - login check then serve React SPA or login page
router.get('/', async (req: Request, res: Response) => {
  const session = req.cookies?.session as string;
  if (isDevMode || (session && await validateSession(session))) {
    // Authenticated — serve React SPA
    const indexPath = path.join(__dirname, '../../dist/client/index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        // Fallback if client not built yet
        res.redirect('/queue');
      }
    });
    return;
  }
  res.send(renderLoginPage());
});

// Privy auth callback - verifies token and creates session
router.post('/api/auth/callback', async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: 'Missing token' });
    return;
  }

  try {
    const claims = await verifyPrivyToken(token);
    const privyUserId = claims.sub;

    if (!privyUserId) {
      res.status(401).json({ error: 'Invalid token: no user ID' });
      return;
    }

    // Fetch user details from Privy to get their email
    const privyUserRes = await fetch(`https://auth.privy.io/api/v1/users/${privyUserId}`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.privy.appId}:${config.privy.appSecret}`).toString('base64')}`,
        'privy-app-id': config.privy.appId,
      },
    });

    if (!privyUserRes.ok) {
      console.error(`[Auth] Failed to fetch Privy user ${privyUserId}: ${privyUserRes.status}`);
      res.status(401).json({ error: 'Could not verify user identity' });
      return;
    }

    const privyUser = await privyUserRes.json() as { linked_accounts?: Array<{ type: string; address?: string }> };

    // Extract email from linked accounts
    const linkedEmail = privyUser.linked_accounts?.find(
      (a) => a.type === 'email'
    )?.address?.toLowerCase();

    // Check against allowed emails (NOTIFICATION_EMAIL + optional ALLOWED_EMAILS)
    const allowedEmails = new Set<string>();
    if (config.email.notificationEmail) {
      allowedEmails.add(config.email.notificationEmail.toLowerCase());
    }
    const extraEmails = process.env.ALLOWED_EMAILS;
    if (extraEmails) {
      extraEmails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean).forEach(e => allowedEmails.add(e));
    }

    if (!linkedEmail || !allowedEmails.has(linkedEmail)) {
      console.warn(`[Auth] Access denied for ${linkedEmail || 'unknown email'} (Privy user ${privyUserId})`);
      res.status(403).json({ error: 'Access denied. This dashboard is restricted.' });
      return;
    }

    console.log(`[Auth] Login granted for ${linkedEmail}`);
    const sessionToken = await createSessionToken(linkedEmail);
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: config.app.url.startsWith('https'),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days to match DB session expiry
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Privy token verification failed:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.get('/logout', async (req: Request, res: Response) => {
  const sessionToken = req.cookies?.session as string;
  if (sessionToken) {
    await invalidateSession(sessionToken);
  }
  res.clearCookie('session', { httpOnly: true, sameSite: 'lax' });
  res.redirect('/');
});

// Download file (session required)
router.get('/file/:fileId', async (req: Request, res: Response) => {
  const session = req.cookies?.session as string;
  const fileId = req.params.fileId;

  if (!session || !(await validateSession(session))) {
    res.redirect('/');
    return;
  }

  const file = await getFile(fileId);

  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }

  const ext = file.filename.split('.').pop()?.toLowerCase();
  const contentType = ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  res.send(file.content);
});

// Resend download link - requires auth or strict rate limiting
router.post('/resend-link', async (req: Request, res: Response) => {
  // Check auth first; fall back to IP rate limiting for expired-session users
  const session = req.cookies?.session as string;
  const isAuthed = session && await validateSession(session);

  if (!isAuthed) {
    const clientIp = req.ip || 'unknown';
    if (!rateLimit(`resend:${clientIp}`, 2, 30 * 60 * 1000)) {
      res.status(429).send(renderErrorPage('Too many requests. Please try again later.'));
      return;
    }
  }

  try {
    const files = await listFiles();

    if (files.length === 0) {
      res.send(renderErrorPage('No files available. Please run the job first.'));
      return;
    }

    // Get the most recent file
    const latestFile = files[0];

    const downloadUrl = createMagicLink(config.email.notificationEmail, latestFile.id);
    await sendResendLinkEmail(config.email.notificationEmail, downloadUrl, latestFile.filename);

    res.send(renderResendSuccessPage());
  } catch (error) {
    console.error('Failed to resend link:', error);
    res.send(renderErrorPage('Failed to resend link. Please try again.'));
  }
});

// Legacy download endpoint for email links
router.get('/download', async (req: Request, res: Response) => {
  const token = req.query.token as string;

  if (!token) {
    res.redirect('/');
    return;
  }

  const validation = validateMagicLink(token);

  if (!validation.valid || !validation.fileId) {
    res.send(renderExpiredLinkPage(validation.error || 'Invalid link'));
    return;
  }

  const file = await getFile(validation.fileId);

  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }

  const downloadToken = createDownloadToken(validation.fileId);
  res.send(renderLegacyDownloadPage(file.filename, downloadToken));
});

// Legacy file download
router.get('/download/:token', async (req: Request, res: Response) => {
  const token = req.params.token;
  const validation = validateMagicLink(token);

  if (!validation.valid || !validation.fileId) {
    res.status(401).send(renderErrorPage(validation.error || 'Invalid or expired download link'));
    return;
  }

  const file = await getFile(validation.fileId);

  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }

  const ext = file.filename.split('.').pop()?.toLowerCase();
  const contentType = ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  res.send(file.content);
});

export { router as authRouter };
