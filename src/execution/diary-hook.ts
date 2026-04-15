/**
 * Diary hook.
 *
 * Listens for `task:completed` and appends a compact JSONL entry to
 * `<dataDir>/diary.jsonl`. Gives the agent something concrete to learn
 * from without needing a full memory / reflection layer.
 *
 * Design choices:
 * - One line per completed task. JSONL so `jq` / `tail` work out of the box.
 * - No blocking of the emitter: writes are fire-and-forget with error logging.
 * - No recursion guard needed — the hook doesn't spawn tasks, only writes a file.
 * - Small output cap so the diary stays readable by humans too.
 * - We look the task row up by id to get title, duration, output preview.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { logger } from '../lib/logger.js';

export interface DiaryHookOptions {
  /** Absolute path to the workspace data dir. Diary file lands inside it. */
  dataDir: string;
  /** Max chars of task output to snapshot per entry. Default 200. */
  outputPreviewChars?: number;
}

interface TaskCompletedEvent {
  taskId: string;
  agentId: string;
  status: string;
  tokensUsed: number;
  costCents: number;
}

export function installDiaryHook(
  engine: EventEmitter,
  db: Database.Database,
  opts: DiaryHookOptions,
): () => void {
  const diaryPath = path.join(opts.dataDir, 'diary.jsonl');
  const previewChars = opts.outputPreviewChars ?? 200;

  const handler = (event: TaskCompletedEvent) => {
    try {
      const row = db
        .prepare(
          `SELECT t.id, t.title, t.status, t.duration_seconds, t.tokens_used,
                  t.cost_cents, t.model_used, t.output, t.agent_id,
                  a.name AS agent_name
           FROM agent_workforce_tasks t
           LEFT JOIN agent_workforce_agents a ON a.id = t.agent_id
           WHERE t.id = ?`,
        )
        .get(event.taskId) as
        | {
            id: string;
            title: string | null;
            status: string;
            duration_seconds: number | null;
            tokens_used: number | null;
            cost_cents: number | null;
            model_used: string | null;
            output: string | null;
            agent_id: string;
            agent_name: string | null;
          }
        | undefined;

      if (!row) return;

      const entry = {
        ts: new Date().toISOString(),
        task_id: row.id,
        agent_id: row.agent_id,
        agent_name: row.agent_name ?? null,
        status: row.status,
        model: row.model_used ?? null,
        tokens: row.tokens_used ?? 0,
        cost_cents: row.cost_cents ?? 0,
        duration_seconds: row.duration_seconds ?? null,
        title: truncate(row.title ?? '', 80),
        output_preview: truncate((row.output ?? '').replace(/\s+/g, ' '), previewChars),
      };

      fs.appendFile(diaryPath, JSON.stringify(entry) + '\n', (err) => {
        if (err) logger.warn({ err, diaryPath }, '[diary-hook] append failed');
      });
    } catch (err) {
      logger.warn({ err, taskId: event.taskId }, '[diary-hook] entry build failed');
    }
  };

  engine.on('task:completed', handler);
  logger.info({ diaryPath }, '[diary-hook] installed');
  return () => engine.off('task:completed', handler);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
