/**
 * Outbound Queue
 *
 * SQLite-backed queue that buffers control-plane reports (task reports,
 * session metadata syncs) when the runtime is offline. Items are drained
 * on reconnect or during successful heartbeats.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export interface OutboundQueueItem {
  id: string;
  type: 'task_report' | 'session_sync' | 'conversation_sync';
  payload: string; // JSON
  created_at: string;
  attempts: number;
  last_attempt_at: string | null;
}

const MAX_ATTEMPTS = 10;

export class OutboundQueue {
  constructor(private db: DatabaseAdapter) {}

  /**
   * Enqueue a report for later delivery.
   */
  async enqueue(type: OutboundQueueItem['type'], payload: unknown): Promise<void> {
    const item = {
      id: randomUUID(),
      type,
      payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
      attempts: 0,
      last_attempt_at: null,
    };

    await this.db.from('outbound_queue').insert(item);
    logger.info(`[OutboundQueue] Enqueued ${type} (id=${item.id})`);
  }

  /**
   * Process all queued items using the provided sender function.
   * Removes items on success, increments attempts on failure,
   * and drops items that exceed MAX_ATTEMPTS.
   */
  async drain(sender: (type: OutboundQueueItem['type'], payload: string) => Promise<boolean>): Promise<void> {
    const { data } = await this.db
      .from<OutboundQueueItem>('outbound_queue')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(50);

    if (!data || (data as unknown[]).length === 0) return;

    const items = data as unknown as OutboundQueueItem[];
    let sent = 0;
    const dropped = 0;

    for (const item of items) {
      try {
        const ok = await sender(item.type, item.payload);
        if (ok) {
          await this.db.from('outbound_queue').delete().eq('id', item.id);
          sent++;
        } else {
          await this.recordFailure(item);
        }
      } catch {
        await this.recordFailure(item);
      }
    }

    if (sent > 0 || dropped > 0) {
      logger.info(`[OutboundQueue] Drained: ${sent} sent, ${dropped} dropped`);
    }
  }

  /**
   * Returns the number of pending items in the queue.
   */
  async pendingCount(): Promise<number> {
    const { count } = await this.db
      .from('outbound_queue')
      .select('*', { count: 'exact', head: true });

    return count ?? 0;
  }

  private async recordFailure(item: OutboundQueueItem): Promise<void> {
    const newAttempts = (item.attempts ?? 0) + 1;
    if (newAttempts >= MAX_ATTEMPTS) {
      await this.db.from('outbound_queue').delete().eq('id', item.id);
      logger.warn(`[OutboundQueue] Dropped ${item.type} (id=${item.id}) after ${MAX_ATTEMPTS} attempts`);
      return;
    }

    await this.db.from('outbound_queue').update({
      attempts: newAttempts,
      last_attempt_at: new Date().toISOString(),
    }).eq('id', item.id);
  }
}
