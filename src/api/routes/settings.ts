/**
 * Settings Routes
 * GET /api/settings/:key — Read a runtime setting
 * PUT /api/settings/:key — Write a runtime setting
 */

import { Router } from 'express';
import type { EventEmitter } from 'events';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

const ALLOWED_SETTINGS = new Set([
  'anthropic_api_key',
  'ollama_model',
  'orchestrator_model',
  'ocr_model',
  'openrouter_api_key',
  'openrouter_model',
  'cloud_provider',
  'tunnel_url',
  'cloud_url',
  'cloud_workspace_id',
  'ghl_webhook_secret',
  'ghl_location_id',
  'ghl_api_key',
]);

const SENSITIVE_SETTINGS = new Set([
  'anthropic_api_key',
  'openrouter_api_key',
  'ghl_webhook_secret',
  'ghl_api_key',
]);

function maskSensitiveValue(value: string): string {
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

export function createSettingsRouter(db: DatabaseAdapter, eventBus?: EventEmitter): Router {
  const router = Router();

  // Read a single setting
  router.get('/api/settings/:key', async (req, res) => {
    try {
      const key = req.params.key;
      if (!ALLOWED_SETTINGS.has(key)) {
        res.status(400).json({ error: 'Unknown setting key' });
        return;
      }

      const { data, error } = await db.from('runtime_settings')
        .select('*')
        .eq('key', key)
        .maybeSingle();

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      if (data && SENSITIVE_SETTINGS.has(key)) {
        res.json({ data: { key: data.key, value: maskSensitiveValue(data.value as string) } });
        return;
      }

      res.json({ data: data ? { key: data.key, value: data.value } : null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Write a single setting (upsert)
  router.put('/api/settings/:key', async (req, res) => {
    try {
      const key = req.params.key;
      if (!ALLOWED_SETTINGS.has(key)) {
        res.status(400).json({ error: 'Unknown setting key' });
        return;
      }

      const { value } = req.body;
      if (value === undefined) {
        res.status(400).json({ error: 'value is required' });
        return;
      }

      // Try update first, then insert if not found
      const { data: existing } = await db.from('runtime_settings')
        .select('key')
        .eq('key', key)
        .maybeSingle();

      if (existing) {
        const { error } = await db.from('runtime_settings')
          .update({ value: String(value), updated_at: new Date().toISOString() })
          .eq('key', key);

        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }
      } else {
        const { error } = await db.from('runtime_settings')
          .insert({ key, value: String(value) });

        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }
      }

      // Notify daemon of key changes that require runtime updates
      if (eventBus) {
        if (key === 'openrouter_api_key') eventBus.emit('openrouter:key-changed', { key: String(value) });
        if (key === 'openrouter_model') eventBus.emit('openrouter:model-changed', { model: String(value) });
      }

      const displayValue = SENSITIVE_SETTINGS.has(key) ? maskSensitiveValue(String(value)) : String(value);
      res.json({ data: { key, value: displayValue } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
