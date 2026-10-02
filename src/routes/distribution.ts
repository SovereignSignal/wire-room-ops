/**
 * Distribution Routes
 *
 * Mounted at /api — keeps full sub-paths since routes span both
 * /api/distribution/* and /api/scan/entries/:id/* namespaces.
 *
 * GET    /distribution/config                     — list distribution configs (creds masked)
 * PUT    /distribution/config/:wire/:channel      — update channel config
 * POST   /distribution/run/:wire                  — trigger distribution
 * GET    /distribution/newsletter/:wire            — generate newsletter markdown
 * POST   /distribution/newsletter/:wire/confirm    — mark newsletter entries as distributed
 * GET    /distribution/status/:wire                — bulk distribution status
 * GET    /distribution/channels                    — list managed channels
 * POST   /distribution/channels                    — create channel
 * PUT    /distribution/channels/:id                — update channel
 * DELETE /distribution/channels/:id                — delete channel
 * POST   /distribution/channels/:id/test           — test channel
 *
 * Entry-level routes (GET /scan/entries/:id/distribution, POST /scan/entries/:id/redistribute)
 * are in scan-entries.ts (mounted at /api/scan with requireAuthOrInternalKey).
 */

import { Router, Request, Response } from 'express';
import { listPublicationReview, resolvePublication, listQueuedPublicationReview, retryQueuedPublication } from '../services/publication-queue';
import {
  getDistributionConfigs,
  upsertDistributionConfig,
  getDistributionStatusBulk,
  getDistributionChannels,
  getDistributionChannelById,
  createDistributionChannel,
  updateDistributionChannel,
  deleteDistributionChannel,
  getPool,
  getFeedByKey,
} from '../db';
import { distributeEntries, generateNewsletterMarkdown, confirmNewsletterDistribution, sendTestMessage } from '../services/distribution';
import { listOutgoing } from '../services/distribution-pace';
import { maskConfig, maskCredentials } from '../utils/masking';
import { rateLimit } from '../middleware/rate-limit';
import { isValidUuid, isValidFeedKey } from '../utils/validation';

const router = Router();

router.get('/distribution/outgoing', async (req, res) => {
  const raw = req.query.sentSince;
  let sentSince: Date | undefined;
  if (typeof raw === 'string' && raw.length > 0) {
    sentSince = new Date(raw);
    if (Number.isNaN(sentSince.getTime())) {
      res.status(400).json({ error: 'Invalid sentSince' });
      return;
    }
  }
  try {
    res.json(await listOutgoing(sentSince));
  } catch (error) {
    console.error('[Distribution] Outgoing list failed:', error);
    res.status(500).json({ error: 'Could not load outgoing distribution' });
  }
});

router.get('/distribution/review', async (_req, res) => {
  try { res.json({ items: await listPublicationReview(), jobs: await listQueuedPublicationReview() }); }
  catch { res.status(500).json({ error: 'Could not load publication review' }); }
});
router.post('/distribution/queue/:id/retry', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: 'Invalid entry ID' }); return; }
  try { await retryQueuedPublication(id); res.json({ ok: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Retry failed' }); }
});
router.post('/distribution/review/:id/resolve', async (req, res) => {
  const id = Number(req.params.id);
  const { delivered, externalId } = req.body;
  if (!Number.isSafeInteger(id) || id < 1 || typeof delivered !== 'boolean'
    || (externalId !== undefined && (typeof externalId !== 'string' || externalId.length > 200))) {
    res.status(400).json({ error: 'Provide a valid delivery ID and confirmation' }); return;
  }
  try {
    await resolvePublication(id, delivered, externalId?.trim(), (req as any).authSession.userId);
    res.json({ ok: true });
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Resolution failed' }); }
});


// Concurrent execution guard for distribution runs (per wire)
const distributionRunning = new Set<string>();

// --- Legacy config endpoints ---

// GET /distribution/config — list all configs (creds masked)
router.get('/distribution/config', async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const configs = await getDistributionConfigs(wire);

    // Mask sensitive credential values
    const masked = configs.map(c => ({
      wire: c.wire,
      channel: c.channel,
      enabled: c.enabled,
      config: maskConfig(c.channel, c.config),
    }));

    res.json(masked);
  } catch (error) {
    console.error('Failed to fetch distribution configs:', error);
    res.status(500).json({ error: 'Failed to fetch distribution configs' });
  }
});

// PUT /distribution/config/:wire/:channel — update channel config
router.put('/distribution/config/:wire/:channel', async (req: Request, res: Response) => {
  const { wire, channel } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }
  if (!['telegram', 'x', 'newsletter'].includes(channel)) {
    res.status(400).json({ error: 'Invalid channel. Must be telegram, x, or newsletter.' });
    return;
  }

  const { enabled, config: configData } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  if (configData && typeof configData !== 'object') {
    res.status(400).json({ error: 'config must be an object' });
    return;
  }

  try {
    // Merge incoming config with existing to avoid overwriting secrets on partial updates
    const existing = await getDistributionConfigs(wire);
    const current = existing.find(c => c.channel === channel);
    // Filter out masked values (e.g. "****...") so they don't overwrite real secrets
    const cleanedData: Record<string, any> = {};
    if (configData) {
      for (const [k, v] of Object.entries(configData)) {
        if (typeof v === 'string' && v.startsWith('****')) continue;
        cleanedData[k] = v;
      }
    }
    const mergedConfig = { ...(current?.config || {}), ...cleanedData };

    const result = await upsertDistributionConfig(
      wire,
      channel as any,
      enabled,
      mergedConfig
    );
    res.json({
      wire: result.wire,
      channel: result.channel,
      enabled: result.enabled,
      config: maskConfig(result.channel, result.config),
    });
  } catch (error) {
    console.error('Failed to update distribution config:', error);
    res.status(500).json({ error: 'Failed to update distribution config' });
  }
});

// --- Distribution run + newsletter ---

// POST /distribution/run/:wire — trigger distribution (fire-and-forget)
router.post('/distribution/run/:wire', async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  if (!rateLimit(`distribution-run:${wire}`, 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Distribution recently run. Please wait a few minutes.' });
    return;
  }

  if (distributionRunning.has(wire)) {
    res.status(409).json({ error: 'Distribution already running for this wire' });
    return;
  }

  distributionRunning.add(wire);
  try {
    const result = await distributeEntries(wire);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Run failed:', error);
    res.status(500).json({ error: errorMsg });
  } finally {
    distributionRunning.delete(wire);
  }
});

// GET /distribution/newsletter/:wire — generate newsletter markdown
router.get('/distribution/newsletter/:wire', async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  if (!rateLimit('distribution-newsletter', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Newsletter recently generated. Please wait a few minutes.' });
    return;
  }

  try {
    const feed = await getFeedByKey(wire);
    const displayName = feed?.displayName || wire;
    const { markdown, entryIds } = await generateNewsletterMarkdown(wire, displayName);
    res.json({ success: true, markdown, entryIds });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Newsletter generation failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /distribution/newsletter/:wire/confirm — mark newsletter entries as distributed
router.post('/distribution/newsletter/:wire/confirm', async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  const { entryIds } = req.body;
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    res.status(400).json({ error: 'entryIds must be a non-empty array' });
    return;
  }

  try {
    await confirmNewsletterDistribution(entryIds, wire);
    res.json({ success: true, confirmed: entryIds.length });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Newsletter confirmation failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// GET /distribution/status/:wire — bulk distribution status for approved entries
router.get('/distribution/status/:wire', async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  try {
    const statusMap = await getDistributionStatusBulk(wire);
    res.json(statusMap);
  } catch (error) {
    console.error('Failed to fetch distribution status:', error);
    res.status(500).json({ error: 'Failed to fetch distribution status' });
  }
});

// --- Managed distribution channels CRUD ---

// GET /distribution/channels — list all managed channels
router.get('/distribution/channels', async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const channels = await getDistributionChannels(wire);

    // Mask credentials in response
    const masked = channels.map(c => ({
      id: c.id,
      wire: c.wire,
      channel: c.channel,
      name: c.name,
      enabled: c.enabled,
      target_id: c.targetId,
      credentials: maskCredentials(c.credentials),
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    }));

    res.json(masked);
  } catch (error) {
    console.error('Failed to fetch distribution channels:', error);
    res.status(500).json({ error: 'Failed to fetch distribution channels' });
  }
});

// POST /distribution/channels — create new managed channel
router.post('/distribution/channels', async (req: Request, res: Response) => {
  const { wire, channel, name, enabled, target_id, credentials } = req.body;

  if (!wire || typeof wire !== 'string') {
    res.status(400).json({ error: 'wire is required' });
    return;
  }
  if (!channel || !['telegram', 'discord', 'slack'].includes(channel)) {
    res.status(400).json({ error: 'channel must be telegram, discord, or slack' });
    return;
  }
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!target_id && channel !== 'slack') {
    res.status(400).json({ error: 'target_id is required for this channel type' });
    return;
  }
  if (!credentials || typeof credentials !== 'object') {
    res.status(400).json({ error: 'credentials is required' });
    return;
  }

  try {
    const result = await createDistributionChannel({
      wire,
      channel,
      name,
      enabled: enabled ?? true,
      targetId: target_id || '',
      credentials,
    });

    res.json({
      id: result.id,
      wire: result.wire,
      channel: result.channel,
      name: result.name,
      enabled: result.enabled,
      target_id: result.targetId,
      credentials: maskCredentials(result.credentials),
      created_at: result.createdAt,
      updated_at: result.updatedAt,
    });
  } catch (error) {
    console.error('Failed to create distribution channel:', error);
    res.status(500).json({ error: 'Failed to create distribution channel' });
  }
});

// PUT /distribution/channels/:id — update managed channel
router.put('/distribution/channels/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  const { wire, channel, name, enabled, target_id, credentials } = req.body;

  // If credentials provided, merge with existing (so partial updates don't wipe secrets)
  let mergedCredentials = credentials;
  if (credentials && typeof credentials === 'object') {
    const existing = await getDistributionChannelById(id);
    if (existing) {
      // Only merge if the incoming creds have masked values (****) — skip those
      const cleanCreds: Record<string, string> = {};
      for (const [k, v] of Object.entries(credentials as Record<string, string>)) {
        if (v && !v.startsWith('****')) {
          cleanCreds[k] = v;
        }
      }
      mergedCredentials = { ...existing.credentials, ...cleanCreds };
    }
  }

  const updates: any = {};
  if (wire !== undefined) updates.wire = wire;
  if (channel !== undefined) updates.channel = channel;
  if (name !== undefined) updates.name = name;
  if (enabled !== undefined) updates.enabled = enabled;
  if (target_id !== undefined) updates.targetId = target_id;
  if (mergedCredentials !== undefined) updates.credentials = mergedCredentials;

  try {
    const result = await updateDistributionChannel(id, updates);
    if (!result) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    res.json({
      id: result.id,
      wire: result.wire,
      channel: result.channel,
      name: result.name,
      enabled: result.enabled,
      target_id: result.targetId,
      credentials: maskCredentials(result.credentials),
      created_at: result.createdAt,
      updated_at: result.updatedAt,
    });
  } catch (error) {
    console.error('Failed to update distribution channel:', error);
    res.status(500).json({ error: 'Failed to update distribution channel' });
  }
});

// DELETE /distribution/channels/:id — delete managed channel
router.delete('/distribution/channels/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  try {
    const deleted = await deleteDistributionChannel(id);
    if (!deleted) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete distribution channel:', error);
    res.status(500).json({ error: 'Failed to delete distribution channel' });
  }
});

// POST /distribution/channels/:id/test — send test message
router.post('/distribution/channels/:id/test', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  if (!rateLimit('dist-channel-test', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many test requests. Max 5 per 5 minutes.' });
    return;
  }

  try {
    const channel = await getDistributionChannelById(id);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const result = await sendTestMessage(channel);
    if (result.success) {
      res.json({ success: true, message: 'Test message sent successfully' });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Failed to send test message:', error);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});

// NOTE: Entry-level distribution routes (GET /scan/entries/:id/distribution and
// POST /scan/entries/:id/redistribute) are defined in scan-entries.ts which is
// mounted at /api/scan with requireAuthOrInternalKey middleware.

export const distributionRouter = router;
