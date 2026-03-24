/**
 * ComfyUI HTTP Client
 *
 * Communicates with ComfyUI's REST API for generating images and videos.
 * ComfyUI runs locally and exposes REST + WebSocket endpoints.
 */

import { logger } from '../lib/logger.js';

const DEFAULT_URL = 'http://127.0.0.1:8188';

export interface ComfyUIPromptResult {
  prompt_id: string;
}

export interface ComfyUIHistoryEntry {
  status: { status_str: string; completed: boolean };
  outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}

export class ComfyUIClient {
  private baseUrl: string;
  private clientId: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? DEFAULT_URL).replace(/\/$/, '');
    this.clientId = `ohwow-${Date.now()}`;
  }

  /** Check if ComfyUI is reachable. */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Queue a workflow prompt and return the prompt ID. */
  async queuePrompt(workflow: Record<string, unknown>): Promise<ComfyUIPromptResult> {
    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: workflow,
        client_id: this.clientId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ComfyUI prompt failed (${response.status}): ${text}`);
    }

    return await response.json() as ComfyUIPromptResult;
  }

  /** Wait for a prompt to complete, polling the history endpoint. */
  async waitForCompletion(promptId: string, timeoutMs = 300_000): Promise<ComfyUIHistoryEntry> {
    const start = Date.now();
    const pollInterval = 1000;

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${this.baseUrl}/history/${promptId}`);
        if (resp.ok) {
          const data = await resp.json() as Record<string, ComfyUIHistoryEntry>;
          const entry = data[promptId];
          if (entry?.status?.completed) {
            return entry;
          }
        }
      } catch (err) {
        logger.warn(`[comfyui] Poll error: ${err instanceof Error ? err.message : err}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
  }

  /** Download a generated image/video from ComfyUI. */
  async downloadOutput(filename: string, subfolder: string, type: string): Promise<Buffer> {
    const params = new URLSearchParams({ filename, subfolder, type });
    const resp = await fetch(`${this.baseUrl}/view?${params}`);

    if (!resp.ok) {
      throw new Error(`Couldn't download ComfyUI output: ${resp.status}`);
    }

    return Buffer.from(await resp.arrayBuffer());
  }

  /** List available checkpoint models. */
  async listModels(): Promise<string[]> {
    try {
      const resp = await fetch(`${this.baseUrl}/object_info/CheckpointLoaderSimple`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];

      const data = await resp.json() as Record<string, unknown>;
      const info = data['CheckpointLoaderSimple'] as Record<string, unknown> | undefined;
      const input = info?.['input'] as Record<string, unknown> | undefined;
      const required = input?.['required'] as Record<string, unknown> | undefined;
      const ckptName = required?.['ckpt_name'] as [string[]] | undefined;
      return Array.isArray(ckptName?.[0]) ? ckptName[0] : [];
    } catch {
      return [];
    }
  }

  /** Queue a workflow prompt and wait for results. Returns file buffers. */
  async generate(
    workflow: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Array<{ buffer: Buffer; filename: string }>> {
    const { prompt_id } = await this.queuePrompt(workflow);
    logger.info(`[comfyui] Queued prompt ${prompt_id}`);

    const history = await this.waitForCompletion(prompt_id, timeoutMs);
    const results: Array<{ buffer: Buffer; filename: string }> = [];

    for (const output of Object.values(history.outputs)) {
      if (output.images) {
        for (const img of output.images) {
          const buffer = await this.downloadOutput(img.filename, img.subfolder, img.type);
          results.push({ buffer, filename: img.filename });
        }
      }
    }

    return results;
  }
}
