/**
 * Curator edits for the source-feed list.
 *
 * GET    /           — effective feeds (built-ins plus overlay)
 * POST   /           — add an rss or scrape feed
 * PUT    /:key       — patch a built-in or an added feed
 * DELETE /:key       — disable a built-in, or remove an added feed (confirm=true)
 */

import { Router, Request, Response } from 'express';
import { getAppState, setAppState } from '../db';
import { noteCuratorChange } from '../services/curator-audit';
import { SOURCE_REGISTRY } from '../services/source-feeds';
import {
  SOURCE_FEED_CONFIG_KEY,
  describeSources,
  normalizeSourceFeedConfig,
  validateAddedBody,
  validateFeedKey,
  validatePatchBody,
  type SourceFeedConfig,
} from '../services/source-feed-config';

const router = Router();

async function loadConfig(): Promise<SourceFeedConfig> {
  return normalizeSourceFeedConfig(await getAppState(SOURCE_FEED_CONFIG_KEY));
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const config = await loadConfig();
    res.json({ sources: describeSources(config) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = validateAddedBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const config = await loadConfig();
    if (config.added.some(feed => feed.key === parsed.feed.key)) {
      res.status(409).json({ error: 'A feed with this key already exists' });
      return;
    }
    const next: SourceFeedConfig = { patches: config.patches, added: [...config.added, parsed.feed] };
    await setAppState(SOURCE_FEED_CONFIG_KEY, next);
    const described = describeSources(next).find(source => source.key === parsed.feed.key) || null;
    noteCuratorChange(res, { subject: 'POST /api/source-feeds', old: null, next: described });
    res.status(201).json(described);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.put('/:key', async (req: Request, res: Response) => {
  const key = validateFeedKey(req.params.key);
  if (!key) {
    res.status(400).json({ error: 'Invalid feed key' });
    return;
  }
  const parsed = validatePatchBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const config = await loadConfig();
    const builtin = SOURCE_REGISTRY.some(source => source.key === key);
    const addedIndex = config.added.findIndex(feed => feed.key === key);
    if (!builtin && addedIndex < 0) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    const before = describeSources(config).find(source => source.key === key) || null;
    const next: SourceFeedConfig = { patches: { ...config.patches }, added: config.added.map(feed => ({ ...feed })) };
    if (builtin) {
      next.patches[key] = { ...(next.patches[key] || {}), ...parsed.patch };
    } else {
      const current = next.added[addedIndex];
      if (parsed.patch.endpoint !== undefined) current.endpoint = parsed.patch.endpoint;
      if (parsed.patch.enabled !== undefined) current.enabled = parsed.patch.enabled;
      if (parsed.patch.name !== undefined) current.name = parsed.patch.name;
      if (parsed.patch.wire !== undefined) current.wire = parsed.patch.wire;
      if (parsed.patch.urlPrefix !== undefined) current.urlPrefix = parsed.patch.urlPrefix;
      if (parsed.patch.scrapePrompt !== undefined) current.scrapePrompt = parsed.patch.scrapePrompt;
      if (parsed.patch.titleAllow === null) delete current.titleAllow;
      else if (typeof parsed.patch.titleAllow === 'string') current.titleAllow = parsed.patch.titleAllow;
    }
    await setAppState(SOURCE_FEED_CONFIG_KEY, next);
    const described = describeSources(next).find(source => source.key === key) || null;
    noteCuratorChange(res, { subject: `PUT /api/source-feeds/${key}`, old: before, next: described });
    res.json(described);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.delete('/:key', async (req: Request, res: Response) => {
  const key = validateFeedKey(req.params.key);
  if (!key) {
    res.status(400).json({ error: 'Invalid feed key' });
    return;
  }
  try {
    const config = await loadConfig();
    const builtin = SOURCE_REGISTRY.some(source => source.key === key);
    const added = config.added.some(feed => feed.key === key);
    if (!builtin && !added) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    const before = describeSources(config).find(source => source.key === key) || null;
    const next: SourceFeedConfig = builtin
      ? {
          patches: { ...config.patches, [key]: { ...(config.patches[key] || {}), enabled: false } },
          added: config.added,
        }
      : { patches: config.patches, added: config.added.filter(feed => feed.key !== key) };
    await setAppState(SOURCE_FEED_CONFIG_KEY, next);
    const described = builtin ? describeSources(next).find(source => source.key === key) || null : null;
    noteCuratorChange(res, { subject: `DELETE /api/source-feeds/${key}`, old: before, next: described });
    res.json(described || { key, removed: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const sourceFeedConfigRouter = router;
