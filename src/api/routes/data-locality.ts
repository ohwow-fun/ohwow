/**
 * Data Locality Routes
 *
 * Pin/unpin data to this device. Serve pinned data to authenticated peers.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  pinData,
  unpinData,
  sealData,
  getLocalManifest,
  findManifestEntry,
  recordFetch,
  type PinDataOpts,
  type PinnedDataType,
} from '../../data-locality/manifest.js';
import { logger } from '../../lib/logger.js';

export function createDataLocalityRoutes(db: DatabaseAdapter, workspaceId: string, deviceId: string): Router {
  const router = Router();

  // ── Pin data to this device ──
  router.post('/pin', async (req, res) => {
    try {
      const opts = req.body as PinDataOpts;
      if (!opts.dataType || !opts.dataId || !opts.title) {
        return res.status(400).json({ error: 'dataType, dataId, and title are required' });
      }

      const entry = await pinData(db, workspaceId, deviceId, opts);
      return res.json({ entry });
    } catch (err) {
      logger.error({ err }, '[data-locality] Pin failed');
      return res.status(500).json({ error: 'Pin failed' });
    }
  });

  // ── Unpin data from this device ──
  router.post('/unpin', async (req, res) => {
    try {
      const { dataId } = req.body as { dataId: string };
      if (!dataId) return res.status(400).json({ error: 'dataId is required' });

      await unpinData(db, dataId);
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, '[data-locality] Unpin failed');
      return res.status(500).json({ error: 'Unpin failed' });
    }
  });

  // ── Seal data (never leaves device, not even discoverable) ──
  router.post('/seal', async (req, res) => {
    try {
      const { dataId, dataType } = req.body as { dataId: string; dataType: PinnedDataType };
      if (!dataId || !dataType) return res.status(400).json({ error: 'dataId and dataType are required' });

      await sealData(db, dataId, dataType);
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, '[data-locality] Seal failed');
      return res.status(500).json({ error: 'Seal failed' });
    }
  });

  // ── List manifest entries ──
  router.get('/manifest', async (_req, res) => {
    try {
      const entries = await getLocalManifest(db, workspaceId);
      return res.json({ entries });
    } catch (err) {
      logger.error({ err }, '[data-locality] List manifest failed');
      return res.status(500).json({ error: 'List failed' });
    }
  });

  // ── Serve pinned data to authenticated peers ──
  router.post('/fetch', async (req, res) => {
    try {
      const { dataId } = req.body as { dataId: string };
      if (!dataId) return res.status(400).json({ error: 'dataId is required' });

      // Find manifest entry
      const entry = await findManifestEntry(db, dataId);
      if (!entry) {
        return res.status(404).json({ error: 'Data not found on this device' });
      }

      // Check if data is sealed (should never be fetchable)
      const table = dataTypeToTable(entry.dataType);
      if (table) {
        const { data: sourceRow } = await db.from(table)
          .select('locality_policy')
          .eq('id', dataId)
          .maybeSingle();
        if ((sourceRow as Record<string, unknown>)?.locality_policy === 'device_sealed') {
          return res.status(403).json({ error: 'Data is sealed to this device' });
        }
      }

      // Check if approval is required
      if (entry.requiresApproval) {
        // For now, auto-approve. Phase D adds the approval flow.
        logger.info({ dataId, title: entry.title }, '[data-locality] Auto-approving fetch (approval flow not yet implemented)');
      }

      // Load actual data based on type
      const data = await loadPinnedData(db, entry.dataType, dataId);
      if (!data) {
        return res.status(404).json({ error: 'Data not found in local database' });
      }

      // Record access
      await recordFetch(db, dataId);

      return res.json({
        data,
        accessPolicy: entry.accessPolicy,
        cacheTtl: accessPolicyToTtl(entry.accessPolicy),
      });
    } catch (err) {
      logger.error({ err }, '[data-locality] Fetch failed');
      return res.status(500).json({ error: 'Fetch failed' });
    }
  });

  return router;
}

// ============================================================================
// HELPERS
// ============================================================================

function dataTypeToTable(dataType: PinnedDataType): string | null {
  switch (dataType) {
    case 'memory': return 'agent_workforce_agent_memory';
    case 'conversation': return 'orchestrator_conversations';
    default: return null;
  }
}

async function loadPinnedData(
  db: DatabaseAdapter,
  dataType: PinnedDataType,
  dataId: string,
): Promise<unknown> {
  switch (dataType) {
    case 'memory': {
      const { data } = await db
        .from('agent_workforce_agent_memory')
        .select('*')
        .eq('id', dataId)
        .maybeSingle();
      return data;
    }
    case 'conversation': {
      const { data: conv } = await db
        .from('orchestrator_conversations')
        .select('*')
        .eq('id', dataId)
        .maybeSingle();
      if (!conv) return null;

      const { data: messages } = await db
        .from('orchestrator_messages')
        .select('id, role, content, model, created_at')
        .eq('conversation_id', dataId)
        .order('created_at', { ascending: true });

      return { conversation: conv, messages: messages ?? [] };
    }
    default:
      return null;
  }
}

function accessPolicyToTtl(policy: string): number {
  switch (policy) {
    case 'cached_1h': return 3600;
    case 'cached_24h': return 86400;
    default: return 0; // ephemeral and never_cache: no caching
  }
}
