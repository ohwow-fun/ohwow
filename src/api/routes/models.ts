/**
 * Models API Routes
 * Manage Ollama models: list installed, browse catalog, set active, delete.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { EventEmitter } from 'events';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { MODEL_CATALOG, isModelInstalled } from '../../lib/ollama-models.js';
import { detectDevice, getMemoryTier } from '../../lib/device-info.js';
import { isOllamaRunning, listInstalledModels, unloadModel, loadModel, pullModel } from '../../lib/ollama-installer.js';
import { updateConfigFile } from '../../config.js';
import type { LocalOrchestrator } from '../../orchestrator/local-orchestrator.js';

const OLLAMA_URL = process.env.OHWOW_OLLAMA_URL || 'http://localhost:11434';

export function createModelsRouter(db: DatabaseAdapter, eventBus?: EventEmitter, orchestrator?: LocalOrchestrator | null): Router {
  const router = Router();

  /**
   * GET /api/models/installed
   * Returns installed models enriched with catalog metadata + usage stats,
   * plus activeModel and ollamaRunning status.
   */
  router.get('/api/models/installed', async (_req: Request, res: Response) => {
    try {
      const [running, installedNames] = await Promise.all([
        isOllamaRunning(OLLAMA_URL),
        listInstalledModels(OLLAMA_URL),
      ]);

      // When Ollama is down, fall back to DB snapshots so dashboard isn't empty
      let effectiveInstalled = installedNames;
      if (!running && installedNames.length === 0) {
        const { data: snapshotNames } = await db.from('ollama_model_snapshots')
          .select('model_name')
          .neq('status', 'unavailable');
        if (snapshotNames && (snapshotNames as Array<{ model_name: string }>).length > 0) {
          effectiveInstalled = (snapshotNames as Array<{ model_name: string }>).map(s => s.model_name);
        }
      }

      // Get active model and orchestrator model from runtime_settings
      const [{ data: activeSetting }, { data: orchestratorSetting }] = await Promise.all([
        db.from('runtime_settings')
          .select('value')
          .eq('key', 'ollama_model')
          .maybeSingle(),
        db.from('runtime_settings')
          .select('value')
          .eq('key', 'orchestrator_model')
          .maybeSingle(),
      ]);
      const activeModel = (activeSetting as { value: string } | null)?.value || '';
      const orchestratorModel = (orchestratorSetting as { value: string } | null)?.value || '';

      // Get snapshot data (status, size) for each model
      const { data: snapshots } = await db.from('ollama_model_snapshots')
        .select('*');
      const snapshotMap = new Map(
        ((snapshots as Array<{ model_name: string; status: string; size_bytes: number | null; family: string | null; quantization: string | null }>) || [])
          .map(s => [s.model_name, s]),
      );

      // Get usage stats
      const { data: stats } = await db.from('ollama_model_stats')
        .select('*');
      const statsMap = new Map(
        ((stats as Array<{ model_name: string; total_requests: number; total_duration_ms: number; last_used_at: string | null }>) || [])
          .map(s => [s.model_name, s]),
      );

      // Build enriched model list
      const installed = effectiveInstalled.map(name => {
        const catalogEntry = MODEL_CATALOG.find(m => isModelInstalled(m.tag, [name]));
        const snapshot = snapshotMap.get(name);
        const modelStats = statsMap.get(name);

        return {
          tag: name,
          label: catalogEntry?.label || name.split(':')[0],
          description: catalogEntry?.description || '',
          sizeGB: catalogEntry?.sizeGB || (snapshot?.size_bytes ? Math.round(snapshot.size_bytes / 1e9 * 10) / 10 : null),
          features: catalogEntry?.features || [],
          family: catalogEntry?.family || snapshot?.family || null,
          toolCalling: catalogEntry?.toolCalling || false,
          vision: catalogEntry?.vision || false,
          audio: catalogEntry?.audio || false,
          status: snapshot?.status || 'installed',
          totalRequests: modelStats?.total_requests || 0,
          totalDurationMs: modelStats?.total_duration_ms || 0,
          lastUsedAt: modelStats?.last_used_at || null,
          isActive: name === activeModel || isModelInstalled(activeModel, [name]),
          isOrchestrator: orchestratorModel ? (name === orchestratorModel || isModelInstalled(orchestratorModel, [name])) : false,
          inCatalog: !!catalogEntry,
        };
      });

      res.json({
        data: {
          models: installed,
          activeModel,
          orchestratorModel,
          ollamaRunning: running,
          ollamaSource: running ? 'live' : (effectiveInstalled.length > 0 && !running ? 'snapshot' : 'live'),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  /**
   * GET /api/models/catalog
   * Returns full catalog annotated with `fits` and `installed` flags.
   */
  router.get('/api/models/catalog', async (_req: Request, res: Response) => {
    try {
      const device = detectDevice();
      const installedNames = await listInstalledModels(OLLAMA_URL);
      const memoryTier = getMemoryTier(device);
      const maxModelSize = device.totalMemoryGB * 0.75;

      const catalog = MODEL_CATALOG.map(model => ({
        ...model,
        fits: model.sizeGB < maxModelSize && device.totalMemoryGB >= model.minRAM,
        installed: isModelInstalled(model.tag, installedNames),
      }));

      res.json({
        data: {
          catalog,
          device,
          memoryTier,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  /**
   * PUT /api/models/active
   * Set the active Ollama model.
   */
  router.put('/api/models/active', async (req: Request, res: Response) => {
    try {
      const { model } = req.body as { model?: string };
      if (!model) {
        res.status(400).json({ error: 'model is required' });
        return;
      }

      // Validate the model is actually installed
      const installedNames = await listInstalledModels(OLLAMA_URL);
      if (!isModelInstalled(model, installedNames)) {
        res.status(400).json({ error: 'Model is not installed' });
        return;
      }

      // Upsert runtime_settings
      const { data: existing } = await db.from('runtime_settings')
        .select('key')
        .eq('key', 'ollama_model')
        .maybeSingle();

      if (existing) {
        const { error } = await db.from('runtime_settings')
          .update({ value: model, updated_at: new Date().toISOString() })
          .eq('key', 'ollama_model');
        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }
      } else {
        const { error } = await db.from('runtime_settings')
          .insert({ key: 'ollama_model', value: model });
        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }
      }

      eventBus?.emit('ollama:model-changed', { model });
      res.json({ data: { activeModel: model } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  /**
   * DELETE /api/models/:tag
   * Delete a model from Ollama and clean up local DB records.
   */
  router.delete('/api/models/:tag', async (req: Request, res: Response) => {
    try {
      const rawTag = req.params.tag;
      if (!rawTag || typeof rawTag !== 'string') {
        res.status(400).json({ error: 'Missing model tag' });
        return;
      }
      const tag = decodeURIComponent(rawTag);

      // Delete from Ollama (tolerate connection failures)
      let ollamaReached = false;
      try {
        const ollamaRes = await fetch(`${OLLAMA_URL}/api/delete`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tag }),
          signal: AbortSignal.timeout(30000),
        });
        ollamaReached = true;

        if (!ollamaRes.ok) {
          const body = await ollamaRes.text().catch(() => '');
          // If model already deleted from Ollama (404), continue with DB cleanup
          if (ollamaRes.status !== 404) {
            res.status(ollamaRes.status).json({ error: body || 'Ollama delete failed' });
            return;
          }
        }
      } catch {
        // Ollama unreachable — still clean up DB records
      }

      // Always clean up DB records
      await db.from('ollama_model_snapshots').delete().eq('model_name', tag);
      await db.from('ollama_model_stats').delete().eq('model_name', tag);

      // If this was the active model, clear it
      const { data: activeSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'ollama_model')
        .maybeSingle();

      if ((activeSetting as { value: string } | null)?.value === tag) {
        await db.from('runtime_settings')
          .update({ value: '', updated_at: new Date().toISOString() })
          .eq('key', 'ollama_model');
        eventBus?.emit('ollama:model-changed', { model: '' });
      }

      // If this was the orchestrator model, clear it
      const { data: orchSetting } = await db.from('runtime_settings')
        .select('value').eq('key', 'orchestrator_model').maybeSingle();
      if ((orchSetting as { value: string } | null)?.value === tag) {
        await db.from('runtime_settings')
          .update({ value: '', updated_at: new Date().toISOString() })
          .eq('key', 'orchestrator_model');
        updateConfigFile({ orchestratorModel: '' });
        if (orchestrator) orchestrator.setOrchestratorModel('');
      }

      res.json({ data: { deleted: tag, ollamaReached } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  /**
   * POST /api/models/:tag/unload
   * Unload a model from memory without deleting it.
   */
  router.post('/api/models/:tag/unload', async (req: Request, res: Response) => {
    try {
      const rawTag = req.params.tag;
      if (!rawTag || typeof rawTag !== 'string') {
        res.status(400).json({ error: 'Missing model tag' });
        return;
      }
      const tag = decodeURIComponent(rawTag);

      const running = await isOllamaRunning(OLLAMA_URL);
      if (!running) {
        res.status(503).json({ error: 'Ollama is not running' });
        return;
      }

      // Don't allow unloading the active or orchestrator model
      const [{ data: activeSet }, { data: orchSet }] = await Promise.all([
        db.from('runtime_settings').select('value').eq('key', 'ollama_model').maybeSingle(),
        db.from('runtime_settings').select('value').eq('key', 'orchestrator_model').maybeSingle(),
      ]);
      const activeTag = (activeSet as { value: string } | null)?.value || '';
      const orchTag = (orchSet as { value: string } | null)?.value || '';

      if (activeTag && (tag === activeTag || isModelInstalled(activeTag, [tag]))) {
        res.status(400).json({ error: 'Can\'t unload the active model. Switch active model first.' });
        return;
      }
      if (orchTag && (tag === orchTag || isModelInstalled(orchTag, [tag]))) {
        res.status(400).json({ error: 'Can\'t unload the orchestrator model. Change the orchestrator first.' });
        return;
      }

      await unloadModel(tag, OLLAMA_URL);
      eventBus?.emit('ollama:models-changed', {});
      res.json({ data: { unloaded: tag } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  /**
   * POST /api/models/:tag/load
   * Load a model into VRAM (inverse of unload).
   */
  router.post('/api/models/:tag/load', async (req: Request, res: Response) => {
    try {
      const rawTag = req.params.tag;
      if (!rawTag || typeof rawTag !== 'string') {
        res.status(400).json({ error: 'Missing model tag' });
        return;
      }
      const tag = decodeURIComponent(rawTag);

      const running = await isOllamaRunning(OLLAMA_URL);
      if (!running) {
        res.status(503).json({ error: 'Ollama is not running' });
        return;
      }

      // Validate model is installed
      const installedNames = await listInstalledModels(OLLAMA_URL);
      if (!isModelInstalled(tag, installedNames)) {
        res.status(400).json({ error: 'Model is not installed' });
        return;
      }

      await loadModel(tag, OLLAMA_URL);
      eventBus?.emit('ollama:models-changed', {});
      res.json({ data: { loaded: tag } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  /**
   * POST /api/models/:tag/pull
   * Pull (download) a model from the Ollama registry. Streams NDJSON progress.
   */
  router.post('/api/models/:tag/pull', async (req: Request, res: Response) => {
    try {
      const rawTag = req.params.tag;
      if (!rawTag || typeof rawTag !== 'string') {
        res.status(400).json({ error: 'Missing model tag' });
        return;
      }
      const tag = decodeURIComponent(rawTag);

      const running = await isOllamaRunning(OLLAMA_URL);
      if (!running) {
        res.status(503).json({ error: 'Ollama is not running' });
        return;
      }

      // Stream NDJSON progress
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      for await (const progress of pullModel(tag)) {
        res.write(JSON.stringify(progress) + '\n');
      }

      eventBus?.emit('ollama:models-changed', {});
      res.end();
    } catch (err) {
      // If headers already sent, write error as NDJSON line
      if (res.headersSent) {
        res.write(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : 'Pull failed' }) + '\n');
        res.end();
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
      }
    }
  });

  /**
   * PUT /api/models/orchestrator
   * Set the orchestrator model. Empty string means "auto" (clear override).
   */
  router.put('/api/models/orchestrator', async (req: Request, res: Response) => {
    try {
      const { model, modelSource } = req.body as { model?: string; modelSource?: 'local' | 'cloud' | 'auto' };
      if (model === undefined) {
        res.status(400).json({ error: 'model is required' });
        return;
      }

      // If non-empty, validate model is installed (skip for cloud models)
      if (model && modelSource !== 'cloud') {
        const installedNames = await listInstalledModels(OLLAMA_URL);
        if (!isModelInstalled(model, installedNames)) {
          res.status(400).json({ error: 'Model is not installed' });
          return;
        }
      }

      // Upsert runtime_settings
      const { data: existing } = await db.from('runtime_settings')
        .select('key')
        .eq('key', 'orchestrator_model')
        .maybeSingle();

      if (existing) {
        const { error } = await db.from('runtime_settings')
          .update({ value: model, updated_at: new Date().toISOString() })
          .eq('key', 'orchestrator_model');
        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }
      } else {
        const { error } = await db.from('runtime_settings')
          .insert({ key: 'orchestrator_model', value: model });
        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }
      }

      // Persist to config file
      updateConfigFile({ orchestratorModel: model });

      // Update orchestrator in-memory if available
      if (orchestrator) {
        orchestrator.setOrchestratorModel(model);
        if (modelSource) {
          orchestrator.setModelSource(modelSource);
        }
      }

      eventBus?.emit('ollama:model-changed', { model });
      res.json({ data: { orchestratorModel: model } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  /**
   * GET /api/models/openrouter
   * Returns available OpenRouter models (hardcoded catalog).
   */
  router.get('/api/models/openrouter', async (_req: Request, res: Response) => {
    try {
      const catalog = [
        {
          id: 'openrouter/optimus-alpha',
          alias: 'hunter-alpha',
          label: 'Hunter Alpha',
          description: '1T parameter reasoning model, 1M context, agentic tool calling',
          contextWindow: 1_000_000,
          multimodal: false,
          toolCalling: true,
          reasoning: true,
          free: true,
        },
        {
          id: 'openrouter/optimus-alpha',
          alias: 'healer-alpha',
          label: 'Healer Alpha',
          description: 'Multimodal model with vision, audio, and video understanding',
          contextWindow: 262_000,
          multimodal: true,
          toolCalling: true,
          reasoning: false,
          free: true,
        },
      ];

      // Check if OpenRouter is configured
      const { data: keySetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'openrouter_api_key')
        .maybeSingle();
      const hasKey = !!(keySetting as { value: string } | null)?.value;

      const { data: modelSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'openrouter_model')
        .maybeSingle();
      const activeModel = (modelSetting as { value: string } | null)?.value || '';

      res.json({
        data: {
          catalog,
          configured: hasKey,
          activeModel,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
