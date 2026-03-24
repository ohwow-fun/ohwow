/**
 * Types for Ollama model monitoring and stats tracking.
 */

/** Snapshot of a single model's current state */
export interface OllamaRunningModel {
  modelName: string;
  status: 'loaded' | 'installed' | 'unavailable';
  sizeBytes: number | null;
  vramBytes: number | null;
  processor: string | null;
  quantization: string | null;
  family: string | null;
  expiresAt: string | null;
  lastSeenAt: string;
}

/** Cumulative usage counters per model */
export interface OllamaModelStats {
  modelName: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  lastUsedAt: string | null;
}

/** Joined view: snapshot + stats, used for display and heartbeat */
export interface OllamaModelSummary {
  modelName: string;
  status: 'loaded' | 'installed' | 'unavailable';
  sizeBytes: number | null;
  vramBytes: number | null;
  processor: string | null;
  quantization: string | null;
  family: string | null;
  expiresAt: string | null;
  lastSeenAt: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  lastUsedAt: string | null;
  avgDurationMs: number | null;
}
