/**
 * Log-tail watcher.
 *
 * Week-2 reflex #1: closes the loop between Eyes (`log_tail`) and the
 * self-improvement pipeline (`self_findings`). Every N minutes the
 * watcher calls `executeLogTail` for each configured service and, if
 * the returned `error_density` exceeds a threshold, writes a
 * `self_findings` row with verdict='warning' so PatchAuthor and other
 * downstream experiments can treat production errors the same way
 * they treat copy-lint violations.
 *
 * Services to watch come from the `OHWOW_LOG_TAIL_WATCH` env var
 * (comma-separated list of `supabase|vercel|fly|modal`). When unset,
 * the watcher runs but skips every service — no network, no spawns,
 * no rows written. Keeps the daemon boot path green on a bare clone.
 *
 * Threshold defaults to 0.15 (15% of lines match the error regex) —
 * overridable via OHWOW_LOG_TAIL_ERROR_THRESHOLD.
 */

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { executeLogTail, LOG_TAIL_SERVICES, type LogTailService, type LogTailPayload } from '../execution/observability/index.js';
import { logger } from '../lib/logger.js';

const DEFAULT_TICK_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD = 0.15;
export const LOG_TAIL_WATCHER_EXPERIMENT_ID = 'log-tail-watcher';

export interface LogTailWatcherDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Test seam: override the underlying log_tail call. */
  runLogTail?: (service: LogTailService, lines: number) => Promise<{ content: string; is_error?: boolean }>;
}

export class LogTailWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private db: DatabaseAdapter,
    private deps: LogTailWatcherDeps = {},
    private tickIntervalMs: number = DEFAULT_TICK_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info('[LogTailWatcher] Starting');
    this.tick().catch((err) => logger.error({ err }, '[LogTailWatcher] initial tick failed'));
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error({ err }, '[LogTailWatcher] tick failed'));
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[LogTailWatcher] Stopped');
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const env = this.deps.env ?? process.env;
      const services = parseServiceList(env.OHWOW_LOG_TAIL_WATCH);
      if (services.length === 0) return;

      const threshold = parseThreshold(env.OHWOW_LOG_TAIL_ERROR_THRESHOLD);
      const lines = parseLines(env.OHWOW_LOG_TAIL_WATCH_LINES);
      const run = this.deps.runLogTail ?? ((service, n) => executeLogTail({ service, lines: n }));

      for (const service of services) {
        const t0 = Date.now();
        const result = await run(service, lines);
        let payload: LogTailPayload;
        try {
          payload = JSON.parse(result.content) as LogTailPayload;
        } catch {
          continue;
        }
        if (!payload.ok) {
          logger.debug({ service, reason: payload.reason }, '[LogTailWatcher] tail not ok, skipping');
          continue;
        }
        if (payload.error_density < threshold) continue;

        await this.writeFinding(service, payload, Date.now() - t0);
      }
    } finally {
      this.running = false;
    }
  }

  private async writeFinding(
    service: LogTailService,
    payload: LogTailPayload,
    durationMs: number,
  ): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))();
    const subject = `${service}:${payload.target ?? 'default'}`;
    const summary = `error_density=${payload.error_density.toFixed(3)} across ${payload.lines_returned} recent log lines from ${service}`;
    const evidence = {
      service,
      target: payload.target,
      error_density: payload.error_density,
      lines_returned: payload.lines_returned,
      sample: extractErrorSample(payload.output ?? '', 5),
    };
    try {
      await this.db.from('self_findings').insert({
        id: crypto.randomUUID(),
        experiment_id: LOG_TAIL_WATCHER_EXPERIMENT_ID,
        category: 'production_logs',
        subject,
        hypothesis: `${service} logs show elevated error density`,
        verdict: 'warning',
        summary,
        evidence: JSON.stringify(evidence),
        ran_at: now.toISOString(),
        duration_ms: durationMs,
        status: 'active',
      });
      logger.info({ service, subject, error_density: payload.error_density }, '[LogTailWatcher] finding written');
    } catch (err) {
      logger.warn({ err, service }, '[LogTailWatcher] failed to write finding');
    }
  }
}

export function parseServiceList(raw: string | undefined): LogTailService[] {
  if (!raw) return [];
  const valid = new Set<string>(LOG_TAIL_SERVICES);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => valid.has(s)) as LogTailService[];
}

export function parseThreshold(raw: string | undefined): number {
  if (!raw) return DEFAULT_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return DEFAULT_THRESHOLD;
  return parsed;
}

function parseLines(raw: string | undefined): number {
  if (!raw) return 200;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 200;
  return Math.min(2000, Math.floor(parsed));
}

/**
 * Pull up to `limit` lines from the output that match an error-like
 * pattern. Used as evidence for downstream experiments.
 */
export function extractErrorSample(output: string, limit: number): string[] {
  const re = /error|fail|panic|fatal|exception|timeout|\b5\d{2}\b/i;
  const matches: string[] = [];
  for (const line of output.split('\n')) {
    if (matches.length >= limit) break;
    if (re.test(line)) matches.push(line.slice(0, 240));
  }
  return matches;
}
