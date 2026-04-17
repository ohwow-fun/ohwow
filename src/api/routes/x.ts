/**
 * X / Twitter Routes
 * GET /api/x/tweet/:idOrPath — Fetch a single X post's body + metadata.
 *
 * Thin HTTP wrapper around `fetchXPost` from src/integrations/x. Lets the
 * web dashboard and MCP tools pull post content without leaking the
 * syndication endpoint as a client-side detail. The path param can be a
 * raw numeric id, a relative permalink (/handle/status/123), or a full
 * https URL — the helper normalises them.
 */

import { Router } from 'express';
import { fetchXPost } from '../../integrations/x/fetch-tweet.js';
import { logger } from '../../lib/logger.js';

export function createXRouter(): Router {
  const router = Router();

  router.get('/api/x/tweet/:id', async (req, res) => {
    try {
      const raw = String(req.params.id ?? '');
      // Permalinks like "/handle/status/123" get split by Express routing.
      // Accept a ?permalink=... override so callers can pass a full URL
      // without encoding it into the path segment.
      const input = typeof req.query.permalink === 'string' && req.query.permalink.length > 0
        ? req.query.permalink
        : raw;
      const post = await fetchXPost(input);
      if (!post) {
        res.status(404).json({ error: 'tweet not found or unparseable id' });
        return;
      }
      res.json({ data: post });
    } catch (err) {
      logger.warn({ err }, 'x.tweet fetch failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'fetch failed' });
    }
  });

  return router;
}
