/**
 * Distribution Routes
 *
 * Mounted at /api — keeps full sub-paths since routes span both
 * /api/distribution/* and /api/scan/entries/:id/* namespaces.
 *
 * GET    /distribution/pace                      — pace settings and the change log
 * PUT    /distribution/pace                      — validate and store pace settings
 * GET    /distribution/outgoing                  — scheduled, sent, stuck, and programs-only rows
 * POST   /distribution/queue/:id/enqueue      — book one approved entry onto the paced queue
 * GET    /distribution/queue/:id/verification — what each send of a stuck publication did, and what to check
 * POST   /distribution/queue/:id/release      — record verified outcomes and take it out of review (never sends)
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
import { acknowledgeFailedDistribution, AcknowledgeDistributionError, enqueuePacedPublication, EnqueueConflictError, listPublicationReview, resolvePublication, listQueuedPublicationReview, retryQueuedPublication } from '../services/publication-queue';
import { overrideQueuedPost, PublicationPostError, readPublicationPost, regenerateQueuedPost } from '../services/publication-post';
import { RepeatFunderHoldError, repeatFunderPayload, repeatFunderStatus } from '../services/repeat-funder';
import { openCuratorIdempotency } from '../services/curator-idempotency';
import { parseCuratorEvidence } from '../services/curator-evidence';
import { ACKNOWLEDGE_CONFIRM_MESSAGE, RELEASE_CONFIRM_MESSAGE, curatorConfirmed } from '../services/curator-confirm';
import { getPublicationVerification, parseDeliveryDecisions, PublicationReleaseError, releaseStuckPublication } from '../services/publication-release';
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
import { DEFAULT_PACE, getDistributionPace, listPaceChanges, PaceValidationError, parsePaceUpdate, saveDistributionPace, listOutgoing } from '../services/distribution-pace';
import { curatorApiActor, noteCuratorChange } from '../services/curator-audit';
import { maskConfig, maskCredentials } from '../utils/masking';
import { rateLimit } from '../middleware/rate-limit';
import { isValidUuid, isValidFeedKey } from '../utils/validation';

const router = Router();

function paceActor(req: Request): string {
  return curatorApiActor(req)
    || (req as Request & { authSession?: { userId?: string } }).authSession?.userId
    || (req as Request & { agentSession?: { userId?: string } }).agentSession?.userId
    || 'unknown';
}

function requestActor(req: Request): string | undefined {
  return curatorApiActor(req)
    || (req as Request & { authSession?: { userId?: string } }).authSession?.userId
    || undefined;
}

router.get('/distribution/pace', async (_req, res) => {
  try {
    res.json({ pace: await getDistributionPace(), changes: await listPaceChanges() });
  } catch (error) {
    console.error('[Distribution] Pace settings read failed:', error);
    res.status(500).json({ error: 'Could not load pace settings' });
  }
});

router.put('/distribution/pace', async (req, res) => {
  const actor = paceActor(req);
  if (!rateLimit(`distribution-pace:${actor}`, 30, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many pace changes. Wait a few minutes and try again.' });
    return;
  }
  try {
    parsePaceUpdate(req.body, DEFAULT_PACE);
  } catch (error) {
    if (error instanceof PaceValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  try {
    const current = await getDistributionPace();
    const next = parsePaceUpdate(req.body, current);
    const saved = await saveDistributionPace(next, actor);
    noteCuratorChange(res, { subject: 'PUT /api/distribution/pace', old: current, next: saved.pace });
    res.json({ pace: saved.pace, changed: saved.changed, changes: await listPaceChanges() });
  } catch (error) {
    if (error instanceof PaceValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('[Distribution] Pace settings update failed:', error);
    res.status(500).json({ error: 'Could not save pace settings' });
  }
});

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
router.post('/distribution/queue/:id/enqueue', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    res.status(400).json({ error: 'reason is required' });
    return;
  }
  if (reason.length > 2000) {
    res.status(400).json({ error: 'reason must be at most 2000 characters' });
    return;
  }
  let sources: string[] = [];
  if (req.body?.sources !== undefined) {
    if (!Array.isArray(req.body.sources) || req.body.sources.some((item: unknown) => typeof item !== 'string')) {
      res.status(400).json({ error: 'sources must be an array of strings' });
      return;
    }
    sources = req.body.sources.map((item: string) => item.trim()).filter(Boolean);
  }
  const actor = (req as Request & { agentSession?: { userId?: string }; authSession?: { userId?: string } }).agentSession?.userId
    || (req as Request & { authSession?: { userId?: string } }).authSession?.userId
    || 'unknown';
  const overrideRepeatFunder = req.body?.override_repeat_funder === true;
  try {
    const result = await enqueuePacedPublication(id, { actor, reason, sources, overrideRepeatFunder });
    noteCuratorChange(res, {
      subject: `POST /api/distribution/queue/${id}/enqueue`,
      old: { distributable: false },
      next: { availableAt: result.availableAt },
    });
    res.json(result);
  } catch (error) {
    if (error instanceof RepeatFunderHoldError) {
      res.status(error.statusCode).json(repeatFunderPayload(error));
      return;
    }
    if (error instanceof EnqueueConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error('[Distribution] Enqueue failed:', error);
    res.status(500).json({ error: 'Could not enqueue publication' });
  }
});

const POST_TEXT_CONFIRM = 'Regenerating or replacing a queued post needs confirm=true. This action does not send.';

function queueEntryId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return null;
  }
  return id;
}

router.get('/distribution/entries/:id/repeat-funder', async (req, res) => {
  const id = queueEntryId(req, res);
  if (id === null) return;
  try {
    const status = await repeatFunderStatus(id);
    if (!status) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json(status);
  } catch (error) {
    console.error('[Distribution] Repeat-funder check failed:', error);
    res.status(500).json({ error: 'Could not check repeat-funder status' });
  }
});

router.get('/distribution/queue/:id', async (req, res) => {
  const id = queueEntryId(req, res);
  if (id === null) return;
  try {
    const post = await readPublicationPost(id);
    if (!post) {
      res.status(404).json({ error: 'Entry has no publication row' });
      return;
    }
    res.json(post);
  } catch (error) {
    console.error('[Distribution] Post read failed:', error);
    res.status(500).json({ error: 'Could not load the queued post' });
  }
});

async function beginQueuedPostWrite(req: Request, res: Response): Promise<
  | { ok: false }
  | {
      ok: true;
      actor: string;
      reason: string;
      sources: string[];
      finish: (statusCode: number, payload: unknown) => Promise<void>;
      abort: () => Promise<void>;
    }
> {
  if (!curatorConfirmed(req)) {
    res.status(400).json({ error: 'confirm_required', message: POST_TEXT_CONFIRM });
    return { ok: false };
  }
  const parsed = parseCuratorEvidence(req.body, { requireQuote: false });
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return { ok: false };
  }
  const idem = await openCuratorIdempotency(req, res);
  if (idem.sent) return { ok: false };
  const actor = (req as Request & { agentSession?: { userId?: string }; authSession?: { userId?: string } }).agentSession?.userId
    || (req as Request & { authSession?: { userId?: string } }).authSession?.userId
    || '';
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return { ok: false };
  }
  return { ok: true, actor, reason: parsed.evidence.reason, sources: parsed.evidence.sources, finish: idem.finish, abort: idem.abort };
}

router.post('/distribution/queue/:id/regenerate', async (req, res) => {
  const id = queueEntryId(req, res);
  if (id === null) return;
  const gate = await beginQueuedPostWrite(req, res);
  if (!gate.ok) return;
  try {
    const post = await regenerateQueuedPost(id, gate.actor, gate.reason, gate.sources);
    noteCuratorChange(res, {
      subject: `POST /api/distribution/queue/${id}/regenerate`,
      old: { id },
      next: { model: post.model, sent: false },
    });
    const payload = { ...post, enqueued: false, sent: false };
    await gate.finish(200, payload);
    res.status(200).json(payload);
  } catch (error) {
    if (error instanceof PublicationPostError) {
      const payload = { error: error.message };
      await gate.finish(error.statusCode, payload);
      res.status(error.statusCode).json(payload);
      return;
    }
    await gate.abort();
    console.error('[Distribution] Post regenerate failed:', error);
    res.status(500).json({ error: 'Could not regenerate the queued post' });
  }
});

router.patch('/distribution/queue/:id/post', async (req, res) => {
  const id = queueEntryId(req, res);
  if (id === null) return;
  if (typeof req.body?.postText !== 'string') {
    res.status(400).json({ error: 'postText is required' });
    return;
  }
  const gate = await beginQueuedPostWrite(req, res);
  if (!gate.ok) return;
  try {
    const post = await overrideQueuedPost(id, req.body.postText, gate.actor, gate.reason, gate.sources);
    noteCuratorChange(res, {
      subject: `PATCH /api/distribution/queue/${id}/post`,
      old: { id },
      next: { model: 'manual', sent: false },
    });
    const payload = { ...post, enqueued: false, sent: false };
    await gate.finish(200, payload);
    res.status(200).json(payload);
  } catch (error) {
    if (error instanceof PublicationPostError) {
      const payload = { error: error.message };
      await gate.finish(error.statusCode, payload);
      res.status(error.statusCode).json(payload);
      return;
    }
    await gate.abort();
    console.error('[Distribution] Post override failed:', error);
    res.status(500).json({ error: 'Could not replace the queued post' });
  }
});

router.post('/distribution/queue/:id/retry', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: 'Invalid entry ID' }); return; }
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    await retryQueuedPublication(id, {
      overrideRepeatFunder: req.body?.override_repeat_funder === true,
      reason,
      actor: requestActor(req),
    });
    noteCuratorChange(res, { subject: `POST /api/distribution/queue/${id}/retry`, old: null, next: { id, retried: true } });
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof RepeatFunderHoldError) {
      res.status(error.statusCode).json(repeatFunderPayload(error));
      return;
    }
    res.status(409).json({ error: error instanceof Error ? error.message : 'Retry failed' });
  }
});
router.get('/distribution/queue/:id/verification', async (req, res) => {
  const id = queueEntryId(req, res);
  if (id === null) return;
  try {
    const verification = await getPublicationVerification(id);
    if (!verification) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json(verification);
  } catch (error) {
    console.error('[Distribution] Publication verification failed:', error);
    res.status(500).json({ error: 'Could not load publication verification' });
  }
});

router.post('/distribution/queue/:id/release', async (req, res) => {
  const id = queueEntryId(req, res);
  if (id === null) return;
  if (!curatorConfirmed(req)) {
    res.status(400).json({ error: 'confirm_required', message: RELEASE_CONFIRM_MESSAGE });
    return;
  }
  const reason = acknowledgeReason(req.body);
  if (!reason.ok) {
    res.status(400).json({ error: reason.error });
    return;
  }
  let decisions;
  try {
    decisions = parseDeliveryDecisions(req.body?.deliveries);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid deliveries' });
    return;
  }
  const actor = acknowledgeActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const dryRun = req.body?.dryRun === true;
  const idem = await openCuratorIdempotency(req, res);
  if (idem.sent) return;
  try {
    const result = await releaseStuckPublication(id, { decisions, actor, reason: reason.reason, dryRun });
    console.log(`[Distribution] Release #${id} by ${actor}: ${result.outcome}${result.dryRun ? ' (dry run)' : ''}${result.changed ? '' : ' (no change)'}`);
    if (result.changed && !result.dryRun) {
      noteCuratorChange(res, {
        subject: `POST /api/distribution/queue/${id}/release`,
        old: { queueStatus: result.queueStatus.before },
        next: { queueStatus: result.queueStatus.after, outcome: result.outcome, resolved: result.resolved, sent: false },
      });
    }
    await idem.finish(200, result);
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof PublicationReleaseError) {
      const payload = { error: error.message, ...(error.details ? { details: error.details } : {}) };
      await idem.finish(error.statusCode, payload);
      res.status(error.statusCode).json(payload);
      return;
    }
    await idem.abort();
    console.error('[Distribution] Release failed:', error);
    res.status(500).json({ error: 'Could not release the publication' });
  }
});

router.post('/distribution/review/:id/resolve', async (req, res) => {
  const id = Number(req.params.id);
  const { delivered, externalId } = req.body;
  if (!Number.isSafeInteger(id) || id < 1 || typeof delivered !== 'boolean'
    || (externalId !== undefined && (typeof externalId !== 'string' || externalId.length > 200))) {
    res.status(400).json({ error: 'Provide a valid delivery ID and confirmation' }); return;
  }
  try {
    const actor = requestActor(req);
    if (!actor) { res.status(401).json({ error: 'Unauthorized' }); return; }
    await resolvePublication(id, delivered, externalId?.trim(), actor, {
      overrideRepeatFunder: req.body?.override_repeat_funder === true,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
    });
    noteCuratorChange(res, {
      subject: `POST /api/distribution/review/${id}/resolve`,
      old: null,
      next: { id, delivered, externalId: externalId?.trim() || null },
    });
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof RepeatFunderHoldError) {
      res.status(error.statusCode).json(repeatFunderPayload(error));
      return;
    }
    res.status(409).json({ error: error instanceof Error ? error.message : 'Resolution failed' });
  }
});

function acknowledgeActor(req: Request): string {
  const session = req as Request & {
    agentSession?: { userId?: string };
    authSession?: { userId?: string };
  };
  return session.agentSession?.userId || session.authSession?.userId || '';
}

function acknowledgeReason(body: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { reason?: unknown }).reason
    : undefined;
  if (typeof raw !== 'string') return { ok: false, error: 'reason is required' };
  const reason = raw.trim();
  if (!reason) return { ok: false, error: 'reason is required' };
  if (reason.length > 2000) return { ok: false, error: 'reason must be at most 2000 characters' };
  return { ok: true, reason };
}

router.post('/distribution/logs/:id/acknowledge', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid distribution log ID' });
    return;
  }
  if (!curatorConfirmed(req)) {
    res.status(400).json({ error: 'confirm_required', message: ACKNOWLEDGE_CONFIRM_MESSAGE });
    return;
  }
  const reason = acknowledgeReason(req.body);
  if (!reason.ok) {
    res.status(400).json({ error: reason.error });
    return;
  }
  const actor = acknowledgeActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const idem = await openCuratorIdempotency(req, res);
  if (idem.sent) return;
  try {
    const closed = await acknowledgeFailedDistribution(id, actor, reason.reason);
    noteCuratorChange(res, {
      subject: `POST /api/distribution/logs/${id}/acknowledge`,
      old: { id, status: 'failed' },
      next: {
        id,
        status: closed.status,
        acknowledgedBy: closed.acknowledgedBy,
        acknowledgedReason: closed.acknowledgedReason,
        enqueued: false,
        sent: false,
      },
    });
    await idem.finish(200, closed);
    res.status(200).json(closed);
  } catch (error) {
    if (error instanceof AcknowledgeDistributionError) {
      const payload = { error: error.message };
      await idem.finish(error.statusCode, payload);
      res.status(error.statusCode).json(payload);
      return;
    }
    await idem.abort();
    console.error('[Distribution] Acknowledge failed:', error);
    res.status(500).json({ error: 'Could not acknowledge the failed send' });
  }
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
    const saved = {
      wire: result.wire,
      channel: result.channel,
      enabled: result.enabled,
      config: maskConfig(result.channel, result.config),
    };
    noteCuratorChange(res, {
      subject: `PUT /api/distribution/config/${wire}/${channel}`,
      old: current ? { wire, channel, enabled: current.enabled, config: maskConfig(channel, current.config) } : null,
      next: saved,
    });
    res.json(saved);
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
    noteCuratorChange(res, { subject: `POST /api/distribution/run/${wire}`, old: null, next: { ...result, wire } });
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
    noteCuratorChange(res, {
      subject: `POST /api/distribution/newsletter/${wire}/confirm`,
      old: null,
      next: { wire, confirmed: entryIds.length },
    });
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

    const created = {
      id: result.id,
      wire: result.wire,
      channel: result.channel,
      name: result.name,
      enabled: result.enabled,
      target_id: result.targetId,
      credentials: maskCredentials(result.credentials),
      created_at: result.createdAt,
      updated_at: result.updatedAt,
    };
    noteCuratorChange(res, { subject: 'POST /api/distribution/channels', old: null, next: created });
    res.json(created);
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

  try {
    const existing = await getDistributionChannelById(id);

    // If credentials provided, merge with existing (so partial updates don't wipe secrets)
    let mergedCredentials = credentials;
    if (credentials && typeof credentials === 'object') {
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

    const result = await updateDistributionChannel(id, updates);
    if (!result) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const saved = {
      id: result.id,
      wire: result.wire,
      channel: result.channel,
      name: result.name,
      enabled: result.enabled,
      target_id: result.targetId,
      credentials: maskCredentials(result.credentials),
      created_at: result.createdAt,
      updated_at: result.updatedAt,
    };
    noteCuratorChange(res, {
      subject: `PUT /api/distribution/channels/${id}`,
      old: existing ? {
        id: existing.id,
        wire: existing.wire,
        channel: existing.channel,
        name: existing.name,
        enabled: existing.enabled,
        target_id: existing.targetId,
        credentials: maskCredentials(existing.credentials),
      } : null,
      next: saved,
    });
    res.json(saved);
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
    const existing = await getDistributionChannelById(id);
    const deleted = await deleteDistributionChannel(id);
    if (!deleted) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    noteCuratorChange(res, {
      subject: `DELETE /api/distribution/channels/${id}`,
      old: existing ? { id: existing.id, wire: existing.wire, channel: existing.channel, name: existing.name, enabled: existing.enabled } : { id },
      next: { deleted: true },
    });
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
      noteCuratorChange(res, {
        subject: `POST /api/distribution/channels/${id}/test`,
        old: null,
        next: { id, sent: true },
      });
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
