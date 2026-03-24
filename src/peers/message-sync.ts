/**
 * Message Sync
 * Periodically syncs message history from connected peers.
 * Uses INSERT OR IGNORE to deduplicate by primary key.
 */

import type Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { syncMessages, parsePeerRow } from './peer-client.js';
import { logger } from '../lib/logger.js';

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

export class MessageSync {
  private lastSyncAt: string;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: DatabaseAdapter,
    private rawDb: Database.Database,
    private syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
  ) {
    this.lastSyncAt = new Date().toISOString();
  }

  start(): void {
    this.interval = setInterval(() => {
      this.sync().catch((err) => {
        logger.error({ err }, '[MessageSync] Sync cycle failed');
      });
    }, this.syncIntervalMs);
    logger.info(`[MessageSync] Started (interval: ${this.syncIntervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('[MessageSync] Stopped');
  }

  private async sync(): Promise<void> {
    const { data: peers } = await this.db
      .from('workspace_peers')
      .select('*')
      .eq('status', 'connected');

    if (!peers?.length) return;

    for (const row of peers) {
      const peer = parsePeerRow(row as Record<string, unknown>);
      try {
        const { whatsapp, telegram } = await syncMessages(peer, this.lastSyncAt);
        this.mergeMessages('whatsapp_chat_messages', whatsapp);
        this.mergeMessages('telegram_chat_messages', telegram);
      } catch {
        // Non-fatal: peer may be temporarily unreachable
      }
    }

    this.lastSyncAt = new Date().toISOString();
  }

  private mergeMessages(table: string, messages: Record<string, unknown>[]): void {
    if (!messages.length) return;

    for (const msg of messages) {
      const cols = Object.keys(msg);
      const placeholders = cols.map(() => '?').join(', ');
      try {
        this.rawDb.prepare(
          `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
        ).run(...cols.map((c) => msg[c]));
      } catch {
        // Skip individual message errors (schema mismatch, etc.)
      }
    }
  }
}
