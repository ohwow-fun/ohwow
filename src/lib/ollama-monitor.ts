/**
 * OllamaMonitor — Polls Ollama for running/installed models and tracks usage stats.
 *
 * - Polls /api/ps every 10s for loaded (in-memory) models
 * - Polls /api/tags every 60s for installed models
 * - Reconciles into SQLite (ollama_model_snapshots)
 * - Accumulates per-model usage stats (ollama_model_stats) via recordUsage()
 * - Emits 'ollama:models-changed' when snapshot data changes
 */

import type { TypedEventBus } from './typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { OllamaModelSummary } from './ollama-monitor-types.js';
import { logger } from './logger.js';
import { MODEL_CATALOG } from './ollama-models.js';

/** Raw response shape from Ollama /api/ps */
interface OllamaPsModel {
  name: string;
  model: string;
  size: number;
  size_vram?: number;
  digest: string;
  details?: {
    family?: string;
    quantization_level?: string;
    /** Future: Ollama may expose KV cache quantization type (e.g., 'turbo4', 'q4_0') */
    cache_type_k?: string;
    /** Future: Ollama may expose KV cache quantization type for values */
    cache_type_v?: string;
  };
  expires_at?: string;
}

/** Raw response shape from Ollama /api/tags */
interface OllamaTagModel {
  name: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    quantization_level?: string;
  };
}

export class OllamaMonitor {
  private baseUrl: string;
  private db: DatabaseAdapter;
  private emitter: TypedEventBus<RuntimeEvents>;
  private psInterval: ReturnType<typeof setInterval> | null = null;
  private tagsInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(baseUrl: string, db: DatabaseAdapter, emitter: TypedEventBus<RuntimeEvents>) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.db = db;
    this.emitter = emitter;
  }

  /** Start polling intervals. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Initial polls
    this.pollRunningModels().catch(() => {});
    this.pollInstalledModels().catch(() => {});

    // /api/ps every 10s (loaded models change frequently)
    this.psInterval = setInterval(() => {
      this.pollRunningModels().catch(() => {});
    }, 10_000);

    // /api/tags every 60s (installed models change infrequently)
    this.tagsInterval = setInterval(() => {
      this.pollInstalledModels().catch(() => {});
    }, 60_000);
  }

  /** Stop polling. */
  stop(): void {
    this.running = false;
    if (this.psInterval) {
      clearInterval(this.psInterval);
      this.psInterval = null;
    }
    if (this.tagsInterval) {
      clearInterval(this.tagsInterval);
      this.tagsInterval = null;
    }
  }

  /** Record a completed Ollama request for usage tracking. */
  async recordUsage(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      const { data: existing } = await this.db
        .from('ollama_model_stats')
        .select('model_name')
        .eq('model_name', modelName)
        .maybeSingle();

      if (existing) {
        // Increment counters using raw SQL via the adapter's rpc if available,
        // otherwise read-then-write (acceptable for single-writer SQLite)
        const { data: row } = await this.db
          .from('ollama_model_stats')
          .select('total_requests, total_input_tokens, total_output_tokens, total_duration_ms')
          .eq('model_name', modelName)
          .single();

        if (row) {
          const r = row as Record<string, number>;
          await this.db.from('ollama_model_stats').update({
            total_requests: r.total_requests + 1,
            total_input_tokens: r.total_input_tokens + inputTokens,
            total_output_tokens: r.total_output_tokens + outputTokens,
            total_duration_ms: r.total_duration_ms + durationMs,
            last_used_at: now,
            updated_at: now,
          }).eq('model_name', modelName);
        }
      } else {
        await this.db.from('ollama_model_stats').insert({
          model_name: modelName,
          total_requests: 1,
          total_input_tokens: inputTokens,
          total_output_tokens: outputTokens,
          total_duration_ms: durationMs,
          last_used_at: now,
          created_at: now,
          updated_at: now,
        });
      }
    } catch (err) {
      logger.error({ err }, '[OllamaMonitor] Failed to record usage');
    }
  }

  /** Get joined snapshot + stats for all known models. */
  async getModelSummaries(): Promise<OllamaModelSummary[]> {
    try {
      const { data: snapshots } = await this.db
        .from('ollama_model_snapshots')
        .select('*')
        .neq('status', 'unavailable')
        .order('updated_at', { ascending: false });

      if (!snapshots || snapshots.length === 0) return [];

      const { data: stats } = await this.db
        .from('ollama_model_stats')
        .select('*');

      const statsMap = new Map<string, Record<string, unknown>>();
      if (stats) {
        for (const s of stats) {
          const row = s as Record<string, unknown>;
          statsMap.set(row.model_name as string, row);
        }
      }

      return (snapshots as Array<Record<string, unknown>>).map((snap) => {
        const name = snap.model_name as string;
        const st = statsMap.get(name);
        const totalReqs = (st?.total_requests as number) || 0;
        const totalDur = (st?.total_duration_ms as number) || 0;

        return {
          modelName: name,
          status: snap.status as 'loaded' | 'installed' | 'unavailable',
          sizeBytes: (snap.size_bytes as number) ?? null,
          vramBytes: (snap.vram_bytes as number) ?? null,
          processor: (snap.processor as string) ?? null,
          quantization: (snap.quantization as string) ?? null,
          family: (snap.family as string) ?? null,
          expiresAt: (snap.expires_at as string) ?? null,
          lastSeenAt: snap.last_seen_at as string,
          totalRequests: totalReqs,
          totalInputTokens: (st?.total_input_tokens as number) || 0,
          totalOutputTokens: (st?.total_output_tokens as number) || 0,
          totalDurationMs: totalDur,
          lastUsedAt: (st?.last_used_at as string) ?? null,
          avgDurationMs: totalReqs > 0 ? Math.round(totalDur / totalReqs) : null,
        };
      });
    } catch (err) {
      logger.error({ err }, '[OllamaMonitor] Failed to get summaries');
      return [];
    }
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  /** Poll /api/ps for models loaded in memory. */
  private async pollRunningModels(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/ps`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;

      const data = await response.json() as { models?: OllamaPsModel[] };
      const running = data.models || [];

      await this.reconcileSnapshots(running, 'loaded');
    } catch {
      // Ollama may not be running
    }
  }

  /** Poll /api/tags for all installed models. */
  private async pollInstalledModels(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;

      const data = await response.json() as { models?: OllamaTagModel[] };
      const installed = data.models || [];

      // Convert to same shape as ps models (subset of fields)
      const asPsModels: OllamaPsModel[] = installed.map((m) => ({
        name: m.name,
        model: m.name,
        size: m.size,
        digest: m.digest,
        details: m.details,
      }));

      await this.reconcileSnapshots(asPsModels, 'installed');

      // Mark models no longer reported by Ollama as unavailable
      const polledNames = new Set(installed.map(m => m.name));
      const { data: allKnown } = await this.db.from('ollama_model_snapshots')
        .select('model_name').neq('status', 'unavailable');
      let staleChanged = false;
      for (const row of (allKnown || []) as Array<Record<string, string>>) {
        if (!polledNames.has(row.model_name)) {
          await this.db.from('ollama_model_snapshots').update({
            status: 'unavailable', updated_at: new Date().toISOString(),
          }).eq('model_name', row.model_name);
          staleChanged = true;
        }
      }
      if (staleChanged) this.emitter.emit('ollama:models-changed', {});
    } catch {
      // Ollama may not be running
    }
  }

  /** Upsert model snapshots. For 'loaded' status, override installed. For 'installed', don't demote loaded models. */
  private async reconcileSnapshots(
    models: OllamaPsModel[],
    defaultStatus: 'loaded' | 'installed',
  ): Promise<void> {
    let changed = false;
    const now = new Date().toISOString();

    for (const model of models) {
      const name = model.name;
      const family = this.resolveFamily(name, model.details?.family);
      const processor = model.size_vram != null
        ? (model.size_vram > 0 ? 'GPU' : 'CPU')
        : null;

      const { data: existing } = await this.db
        .from('ollama_model_snapshots')
        .select('model_name, status')
        .eq('model_name', name)
        .maybeSingle();

      if (existing) {
        const ex = existing as Record<string, string>;
        // Don't demote 'loaded' to 'installed' (ps poll may not have run yet)
        const newStatus = defaultStatus === 'loaded' ? 'loaded'
          : ex.status === 'loaded' ? 'loaded'
          : 'installed';

        const statusChanged = ex.status !== newStatus;

        await this.db.from('ollama_model_snapshots').update({
          status: newStatus,
          size_bytes: model.size || null,
          vram_bytes: model.size_vram ?? null,
          processor,
          quantization: model.details?.quantization_level || null,
          family,
          expires_at: model.expires_at || null,
          last_seen_at: now,
          updated_at: now,
        }).eq('model_name', name);

        if (statusChanged) changed = true;
      } else {
        await this.db.from('ollama_model_snapshots').insert({
          model_name: name,
          status: defaultStatus,
          size_bytes: model.size || null,
          vram_bytes: model.size_vram ?? null,
          processor,
          quantization: model.details?.quantization_level || null,
          family,
          expires_at: model.expires_at || null,
          last_seen_at: now,
          updated_at: now,
        });
        changed = true;
      }
    }

    // For 'loaded' polls: mark models no longer running as 'installed'
    if (defaultStatus === 'loaded') {
      const runningNames = new Set(models.map((m) => m.name));
      const { data: allLoaded } = await this.db
        .from('ollama_model_snapshots')
        .select('model_name')
        .eq('status', 'loaded');

      if (allLoaded) {
        for (const row of allLoaded as Array<Record<string, string>>) {
          if (!runningNames.has(row.model_name)) {
            await this.db.from('ollama_model_snapshots').update({
              status: 'installed',
              updated_at: now,
            }).eq('model_name', row.model_name);
            changed = true;
          }
        }
      }
    }

    if (changed) {
      this.emitter.emit('ollama:models-changed', {});
    }
  }

  /** Resolve model family from MODEL_CATALOG or Ollama details. */
  private resolveFamily(modelName: string, ollamaFamily?: string): string | null {
    // Check MODEL_CATALOG first (matches by tag prefix)
    const baseName = modelName.split(':')[0];
    const catalogEntry = MODEL_CATALOG.find(
      (m) => m.tag === modelName || m.tag.split(':')[0] === baseName,
    );
    if (catalogEntry) return catalogEntry.family;

    // Fall back to Ollama-reported family
    return ollamaFamily || null;
  }
}
