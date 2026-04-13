/**
 * SynthesisFailureDetector — Background worker that watches
 * agent_workforce_tasks for "LLM burned a lot of tokens and produced
 * nothing" outcomes and nominates them as candidates for deterministic
 * tool synthesis.
 *
 * The design bet: every time an agent flails in a ReAct loop on a
 * repeatable UI task, that's evidence a deterministic tool should
 * exist. Instead of letting the next attempt flail again, we collect
 * the candidate, probe the target surface, and generate a tool the
 * orchestrator can call directly. The 408k-token tweet post failure
 * on launch eve is the archetype — seven ReAct iterations, zero
 * output, one ALWAYS_INCLUDED tool (`x_compose_tweet`) could have
 * done the job in a single call.
 *
 * What this module does and does NOT do
 *
 *   - It SCANS. Every CHECK_INTERVAL_MS it runs a query for
 *     status='completed' rows with tokens_used above a threshold
 *     and empty output. Rows it has already considered are
 *     excluded via metadata.synthesis_considered.
 *
 *   - It EMITS. Candidates go out as a `synthesis:candidate` event
 *     on a plain EventEmitter. The synthesis generator (M5) subscribes
 *     and decides whether to actually probe+generate a skill — the
 *     detector is deliberately dumb so the decision logic lives in
 *     one place.
 *
 *   - It MARKS. After emitting, the task's metadata is stamped with
 *     `synthesis_considered: true` and `synthesis_candidate_emitted_at`
 *     so the next scan doesn't re-fire the same candidate.
 *
 * What it doesn't do: probe the page, call an LLM, write files,
 * register tools. All of that lives downstream in M5/M6.
 *
 * Query strategy
 *
 * The DatabaseAdapter interface doesn't expose raw SQL, so we can't
 * do `json_extract(metadata, '$.synthesis_considered') IS NULL`
 * directly. Instead we pull a small window of recent high-token
 * completions and do the metadata filter in JS. That's fine at
 * these volumes (a workspace produces at most a few hundred tasks
 * a day; failures are a subset).
 */

import { EventEmitter } from 'node:events';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReactTraceAction {
  tool?: string;
  inputSummary?: string;
}

export interface ReactTraceIteration {
  iteration?: number;
  thought?: string;
  actions?: ReactTraceAction[];
  observations?: Array<{ tool?: string; resultSummary?: string; success?: boolean }>;
  durationMs?: number;
  timestamp?: string;
}

export interface SynthesisCandidate {
  taskId: string;
  title: string;
  description: string | null;
  input: Record<string, unknown> | null;
  tokensUsed: number;
  agentId: string | null;
  /**
   * Best-effort extraction of the first URL the task tried to touch.
   * Null if no URL signal was found in the trace or input. The
   * generator treats null as "caller must supply target URL".
   */
  targetUrlGuess: string | null;
  reactTrace: ReactTraceIteration[];
  createdAt: string;
}

export interface SynthesisFailureDetectorOptions {
  db: DatabaseAdapter;
  workspaceId: string;
  /** How often to scan. Default 60 seconds. */
  checkIntervalMs?: number;
  /** Only consider tasks above this token burn. Default 50000. */
  minTokensUsed?: number;
  /** Max rows to examine per scan (ordered by created_at desc). Default 25. */
  batchSize?: number;
  /** Ignore tasks older than this many days. Default 7. */
  maxAgeDays?: number;
  /**
   * Optional override for the event bus. Defaults to an internal
   * EventEmitter exposed via `.bus`. Pass your own EE if you want to
   * share with other subsystems.
   */
  bus?: EventEmitter;
}

// ---------------------------------------------------------------------------
// Task row shape (loose — we tolerate schema drift)
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title?: string | null;
  description?: string | null;
  input?: string | Record<string, unknown> | null;
  output?: string | null;
  status?: string | null;
  tokens_used?: number | null;
  agent_id?: string | null;
  metadata?: string | Record<string, unknown> | null;
  created_at?: string | null;
}

// ---------------------------------------------------------------------------
// JSON-safe parse/stringify
// ---------------------------------------------------------------------------

function safeParse<T = unknown>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function serializeMetadata(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return '{}';
  }
}

// ---------------------------------------------------------------------------
// Target URL heuristic
// ---------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s"')]+/i;

/**
 * Walk the react_trace looking for the first navigate/goto/browser_*
 * action and extract a URL if present. Falls back to scanning the
 * task's input for a URL string. This is best-effort — the M5
 * generator always has a chance to override.
 */
export function inferTargetUrl(
  reactTrace: ReactTraceIteration[],
  input: Record<string, unknown> | null,
): string | null {
  for (const iter of reactTrace) {
    for (const action of iter.actions || []) {
      const tool = (action.tool || '').toLowerCase();
      const summary = action.inputSummary || '';
      if (
        tool === 'browser_navigate' ||
        tool === 'request_browser' ||
        tool.includes('navigate') ||
        tool.includes('goto') ||
        tool.includes('browse')
      ) {
        const match = summary.match(URL_REGEX);
        if (match) return match[0];
      }
      const fallback = summary.match(URL_REGEX);
      if (fallback) return fallback[0];
    }
  }
  if (input && typeof input === 'object') {
    const flat = JSON.stringify(input);
    const match = flat.match(URL_REGEX);
    if (match) return match[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Candidate qualification
// ---------------------------------------------------------------------------

/**
 * Decide whether a task row deserves to be emitted as a synthesis
 * candidate. Kept pure and exported so the unit tests can drive it
 * without running the full scan loop.
 */
export function qualifyTask(
  row: TaskRow,
  minTokensUsed: number,
  maxAgeDays: number,
): { eligible: boolean; reason?: string } {
  if ((row.status || '') !== 'completed') return { eligible: false, reason: 'status != completed' };
  const tokens = Number(row.tokens_used ?? 0);
  if (tokens < minTokensUsed) return { eligible: false, reason: 'tokens_used below threshold' };
  const output = typeof row.output === 'string' ? row.output.trim() : '';
  if (output.length >= 50) return { eligible: false, reason: 'has substantive output' };

  if (row.created_at) {
    const createdAtMs = Date.parse(row.created_at);
    if (!Number.isNaN(createdAtMs)) {
      const ageMs = Date.now() - createdAtMs;
      if (ageMs > maxAgeDays * 24 * 3600 * 1000) {
        return { eligible: false, reason: 'older than maxAgeDays' };
      }
    }
  }

  const metadata = safeParse<Record<string, unknown>>(row.metadata) || {};
  if (metadata.synthesis_considered) return { eligible: false, reason: 'already considered' };

  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export class SynthesisFailureDetector {
  readonly bus: EventEmitter;
  private readonly db: DatabaseAdapter;
  private readonly workspaceId: string;
  private readonly checkIntervalMs: number;
  private readonly minTokensUsed: number;
  private readonly batchSize: number;
  private readonly maxAgeDays: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;

  constructor(opts: SynthesisFailureDetectorOptions) {
    this.db = opts.db;
    this.workspaceId = opts.workspaceId;
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000;
    this.minTokensUsed = opts.minTokensUsed ?? 50_000;
    this.batchSize = opts.batchSize ?? 25;
    this.maxAgeDays = opts.maxAgeDays ?? 7;
    this.bus = opts.bus ?? new EventEmitter();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // One initial scan so a freshly-booted daemon picks up candidates
    // from the overnight backlog immediately.
    this.checkFailures().catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        '[SynthesisFailureDetector] initial scan failed',
      );
    });
    this.timer = setInterval(() => {
      this.checkFailures().catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : err },
          '[SynthesisFailureDetector] scheduled scan failed',
        );
      });
    }, this.checkIntervalMs);
    logger.info(
      { intervalMs: this.checkIntervalMs, minTokensUsed: this.minTokensUsed },
      '[SynthesisFailureDetector] started',
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass of the scan. Public + returns the candidates found
   * so tests can drive it deterministically without the interval.
   */
  async checkFailures(): Promise<SynthesisCandidate[]> {
    if (this.executing) return [];
    this.executing = true;
    const emitted: SynthesisCandidate[] = [];
    try {
      const rows = await this.fetchCandidateRows();
      for (const row of rows) {
        const q = qualifyTask(row, this.minTokensUsed, this.maxAgeDays);
        if (!q.eligible) continue;

        const candidate = this.buildCandidate(row);
        if (!candidate) continue;

        emitted.push(candidate);
        this.bus.emit('synthesis:candidate', candidate);
        await this.markConsidered(row);
      }
      if (emitted.length > 0) {
        logger.info(
          { emittedCount: emitted.length, sampleTaskId: emitted[0]?.taskId },
          '[SynthesisFailureDetector] candidates emitted',
        );
      }
    } finally {
      this.executing = false;
    }
    return emitted;
  }

  private async fetchCandidateRows(): Promise<TaskRow[]> {
    try {
      const result = await this.db
        .from<TaskRow>('agent_workforce_tasks')
        .select('id, title, description, input, output, status, tokens_used, agent_id, metadata, created_at')
        .eq('workspace_id', this.workspaceId)
        .eq('status', 'completed')
        .gt('tokens_used', this.minTokensUsed)
        .order('created_at', { ascending: false })
        .limit(this.batchSize);
      return (result.data ?? []) as TaskRow[];
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        '[SynthesisFailureDetector] fetch failed',
      );
      return [];
    }
  }

  private buildCandidate(row: TaskRow): SynthesisCandidate | null {
    const metadata = safeParse<Record<string, unknown>>(row.metadata) || {};
    const reactTraceRaw = metadata.react_trace;
    const reactTrace: ReactTraceIteration[] = Array.isArray(reactTraceRaw)
      ? (reactTraceRaw as ReactTraceIteration[])
      : [];

    const input = safeParse<Record<string, unknown>>(row.input);
    const targetUrlGuess = inferTargetUrl(reactTrace, input);

    return {
      taskId: row.id,
      title: row.title ?? '',
      description: row.description ?? null,
      input,
      tokensUsed: Number(row.tokens_used ?? 0),
      agentId: row.agent_id ?? null,
      targetUrlGuess,
      reactTrace,
      createdAt: row.created_at ?? new Date().toISOString(),
    };
  }

  private async markConsidered(row: TaskRow): Promise<void> {
    const metadata = safeParse<Record<string, unknown>>(row.metadata) || {};
    metadata.synthesis_considered = true;
    metadata.synthesis_candidate_emitted_at = new Date().toISOString();
    try {
      await this.db
        .from('agent_workforce_tasks')
        .update({ metadata: serializeMetadata(metadata) })
        .eq('id', row.id);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, taskId: row.id },
        '[SynthesisFailureDetector] failed to mark synthesis_considered',
      );
    }
  }
}
