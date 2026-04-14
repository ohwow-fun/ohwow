/**
 * DeliverableExecutor — executes the real-world action associated with an
 * approved deliverable.
 *
 * Background: before this module existed, approving a task flipped its status
 * to 'approved' and parked the deliverable in 'approved' but nothing actually
 * fired the underlying action (post a tweet, send an email, etc.). Content
 * piled up with no bridge between "human reviewed" and "thing happened".
 *
 * Design:
 *   - Handlers are registered by `deferred_action.type`.
 *   - Called from two sites: approvals.ts (post-approval) and
 *     task-completion.ts (trust-output path).
 *   - On success, the deliverable transitions approved -> delivered and
 *     delivery_result captures the handler's return value. On failure the
 *     deliverable stays in 'approved' and delivery_result records the error,
 *     so retries are possible.
 *   - Defaults to dry-run mode for safety. Flip runtime_settings
 *     `deliverable_executor_live` = "true" to perform real external actions.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import { composeTweetViaBrowser } from '../orchestrator/tools/x-posting.js';

export interface DeliverableRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  deliverable_type: string;
  provider: string | null;
  content: string;
  status: string;
}

export interface ExecutorContext {
  db: DatabaseAdapter;
  liveMode: boolean;
}

export interface HandlerResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

type Handler = (
  content: Record<string, unknown>,
  ctx: ExecutorContext,
) => Promise<HandlerResult>;

export class DeliverableExecutor {
  private handlers = new Map<string, Handler>();
  constructor(private db: DatabaseAdapter) {
    this.register('post_tweet', postTweetHandler);
  }

  register(actionType: string, handler: Handler): void {
    this.handlers.set(actionType, handler);
  }

  /**
   * Resolve and run the handler for a deliverable. Updates the deliverable
   * row in place: on success marks it delivered with delivery_result; on
   * failure leaves status untouched and records the error in delivery_result.
   */
  async execute(deliverableId: string): Promise<HandlerResult> {
    const { data } = await this.db.from('agent_workforce_deliverables')
      .select('*')
      .eq('id', deliverableId)
      .maybeSingle();
    const row = data as DeliverableRow | null;
    if (!row) return { ok: false, error: 'deliverable not found' };

    const content = parseContent(row.content);
    const actionType = inferActionType(row, content);
    if (!actionType) {
      return { ok: false, error: 'no action_spec or inferrable action type' };
    }

    const handler = this.handlers.get(actionType);
    if (!handler) {
      return { ok: false, error: `no handler registered for ${actionType}` };
    }

    const liveMode = await readLiveMode(this.db);
    const ctx: ExecutorContext = { db: this.db, liveMode };

    let outcome: HandlerResult;
    try {
      outcome = await handler(content, ctx);
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      delivery_result: JSON.stringify({ ...outcome, actionType, liveMode, at: now }),
      updated_at: now,
    };
    if (outcome.ok) {
      patch.status = 'delivered';
      patch.delivered_at = now;
    }
    await this.db.from('agent_workforce_deliverables')
      .update(patch)
      .eq('id', deliverableId);

    logger.info({ deliverableId, actionType, liveMode, ok: outcome.ok }, '[DeliverableExecutor] execute');
    return outcome;
  }

  /**
   * Convenience: execute the deliverable(s) linked to a task. Used from the
   * approve endpoint and from the trust-output path after a task completes.
   */
  async executeForTask(taskId: string): Promise<HandlerResult[]> {
    const { data } = await this.db.from('agent_workforce_deliverables')
      .select('id,status')
      .eq('task_id', taskId);
    const rows = (data as Array<{ id: string; status: string }>) ?? [];
    const results: HandlerResult[] = [];
    for (const r of rows) {
      if (r.status !== 'approved') continue;
      results.push(await this.execute(r.id));
    }
    return results;
  }
}

function parseContent(raw: unknown): Record<string, unknown> {
  // The DB adapter sometimes returns TEXT JSON columns already parsed as
  // objects; handle both shapes so the handler sees a consistent object.
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Prefer an explicit action_spec in the deliverable content; otherwise infer
 * from provider + deliverable_type. Keeps back-compat with the existing
 * {text} deliverables while letting new dispatchers be explicit.
 */
function inferActionType(row: DeliverableRow, content: Record<string, unknown>): string | null {
  const spec = content.action_spec as Record<string, unknown> | undefined;
  if (spec && typeof spec.type === 'string') return spec.type;
  if (row.provider === 'x') return 'post_tweet';
  return null;
}

async function readLiveMode(db: DatabaseAdapter): Promise<boolean> {
  try {
    const { data } = await db.from('runtime_settings')
      .select('value')
      .eq('key', 'deliverable_executor_live')
      .maybeSingle();
    const val = (data as { value: string } | null)?.value;
    return val === 'true' || val === '1';
  } catch { return false; }
}

const postTweetHandler: Handler = async (content, ctx) => {
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!text) return { ok: false, error: 'post_tweet: content.text missing' };
  const dryRun = !ctx.liveMode;
  try {
    const res = await composeTweetViaBrowser({ text, dryRun });
    if (!res.success) {
      return { ok: false, error: res.message || 'compose failed', result: res as unknown as Record<string, unknown> };
    }
    return { ok: true, result: { dryRun, ...(res as unknown as Record<string, unknown>) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
