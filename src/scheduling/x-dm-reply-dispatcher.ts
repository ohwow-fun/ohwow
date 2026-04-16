/**
 * XDmReplyDispatcher — send operator-approved DM replies via CDP.
 *
 * Every tick this scheduler:
 *   1. Reads x-approvals.jsonl for kind='x_dm_outbound' entries whose
 *      status is 'approved' or 'auto_applied' and which have not yet
 *      been marked 'applied'.
 *   2. For each (oldest first):
 *        a. Extracts conversation_pair + text from the approval payload.
 *        b. Takes the workspace CDP lane (serializes with the DM poller
 *           and content-cadence posting paths).
 *        c. Calls sendDmViaBrowser({ ..., dryRun: false }).
 *        d. On success: inserts a row into x_dm_messages with a
 *           synthetic message_id 'outbound-<uuid>' (X does not surface
 *           the real id until the next inbox refresh), stamps the
 *           thread's last_message_* columns, appends a JSONL
 *           `kind=outbound_sent` ledger entry, and marks the approval
 *           'applied' so the next tick skips it.
 *        e. On failure: logs the error, leaves the approval approved.
 *           Operator can re-trigger by toggling the JSONL row or the
 *           next dispatcher tick will retry naturally. We do NOT mark
 *           consumed on failure — a broken send that silently eats
 *           the approval is worse than a re-try.
 *
 * Trust gate
 * ----------
 * The dispatcher is the CONSUMER side; the trust gate (autoApproveAfter,
 * maxPriorRejected, bucketBy) lives with the PRODUCER of proposals,
 * which today is the operator via the CLI. When a future autonomous
 * producer (e.g. agent-authored replies) calls proposeApproval with
 * kind='x_dm_outbound', it should pass autoApproveAfter=10,
 * maxPriorRejected=0, bucketBy=null — DMs are higher-stakes than
 * tweets and warrant a long human review period.
 *
 * Lane contention
 * ---------------
 * Uses withCdpLane(workspaceId) so sends serialize with the DM poller
 * and the content-cadence bypass posting path. Orchestrator-mediated
 * posts via engine.executeTask are not yet inside the lane; that's a
 * known gap that also applies here.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { withCdpLane } from '../execution/browser/cdp-lane.js';
import { logger } from '../lib/logger.js';
import {
  sendDmViaBrowser,
  type ComposeResult,
  type SendDmInput,
} from '../orchestrator/tools/x-posting.js';
import {
  listApprovalsForKind,
  markApprovalApplied,
  type ApprovalEntry,
} from './approval-queue.js';

/** Default tick interval. Kept shorter than the poller (hourly) so an
 * operator approval → actual send round-trip is bounded. */
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
/** Cap on how many approvals we drain per tick. Each send holds the
 * CDP lane for ~5s and navigates, so we prefer smaller batches over
 * starving other schedulers for a tick. */
const MAX_SENDS_PER_TICK = 5;
/** Kind filter we read from the approvals queue. */
const APPROVAL_KIND = 'x_dm_outbound';

export interface XDmReplyDispatcherOptions {
  /** Absolute path to the shared x-approvals.jsonl file. */
  approvalsJsonlPath: string;
  /** Workspace data dir. When set, outbound_sent events are appended
   * to x-dms-YYYY-MM-DD.jsonl alongside the poller's entries. */
  dataDir?: string;
  /** Override the browser send. Tests inject a fake. */
  sender?: (input: SendDmInput) => Promise<ComposeResult>;
}

export class XDmReplyDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;
  private readonly sender: (input: SendDmInput) => Promise<ComposeResult>;
  private readonly approvalsJsonlPath: string;
  private readonly dataDir: string | null;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    options: XDmReplyDispatcherOptions,
  ) {
    this.approvalsJsonlPath = options.approvalsJsonlPath;
    this.dataDir = options.dataDir ?? null;
    this.sender = options.sender ?? sendDmViaBrowser;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info({ intervalMs }, '[XDmReplyDispatcher] started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('[XDmReplyDispatcher] stopped');
  }

  /** Single dispatch tick. Public for integration tests. */
  async tick(): Promise<void> {
    if (this.executing) return;
    this.executing = true;
    const startedAt = Date.now();
    try {
      const approvals = listApprovalsForKind(this.approvalsJsonlPath, APPROVAL_KIND);
      if (approvals.length === 0) return;
      const batch = approvals.slice(0, MAX_SENDS_PER_TICK);
      let sent = 0;
      let failed = 0;
      for (const approval of batch) {
        const ok = await this.dispatchOne(approval);
        if (ok) sent++;
        else failed++;
      }
      logger.info(
        {
          approvalsTotal: approvals.length,
          attempted: batch.length,
          sent,
          failed,
          ms: Date.now() - startedAt,
        },
        '[XDmReplyDispatcher] tick complete',
      );
    } catch (err) {
      logger.error({ err }, '[XDmReplyDispatcher] tick failed');
    } finally {
      this.executing = false;
    }
  }

  /**
   * Validate payload, take the CDP lane, send, then persist results.
   * Returns true when the send succeeded AND the approval was marked
   * applied; false when the approval is malformed OR the send failed.
   */
  private async dispatchOne(approval: ApprovalEntry): Promise<boolean> {
    const payload = approval.payload ?? {};
    const conversationPair = typeof payload.conversation_pair === 'string'
      ? payload.conversation_pair
      : null;
    const handle = typeof payload.handle === 'string' ? payload.handle : null;
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';

    if (!text) {
      logger.warn(
        { approvalId: approval.id },
        '[XDmReplyDispatcher] approval payload missing text; marking applied to avoid infinite retry',
      );
      markApprovalApplied(this.approvalsJsonlPath, approval.id, {
        posted: false,
        by: 'x_dm_reply_dispatcher',
        reason: 'payload_missing_text',
      });
      return false;
    }
    if (!conversationPair && !handle) {
      logger.warn(
        { approvalId: approval.id },
        '[XDmReplyDispatcher] approval payload missing conversation_pair and handle; marking applied',
      );
      markApprovalApplied(this.approvalsJsonlPath, approval.id, {
        posted: false,
        by: 'x_dm_reply_dispatcher',
        reason: 'payload_missing_target',
      });
      return false;
    }

    let result: ComposeResult;
    try {
      result = await withCdpLane(
        this.workspaceId,
        () => this.sender({
          conversationPair: conversationPair ?? undefined,
          handle: handle ?? undefined,
          text,
          dryRun: false,
        }),
        { label: 'x-dm-reply-dispatcher:send' },
      );
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        '[XDmReplyDispatcher] send threw; leaving approval for retry',
      );
      return false;
    }

    if (!result.success) {
      logger.warn(
        { approvalId: approval.id, message: result.message },
        '[XDmReplyDispatcher] send failed; leaving approval for retry',
      );
      return false;
    }

    const nowIso = new Date().toISOString();
    const syntheticId = `outbound-${randomUUID()}`;
    const landedPair = conversationPair ?? (result.landedAt ?? null);

    if (landedPair) {
      try {
        await this.db.from('x_dm_messages').insert({
          workspace_id: this.workspaceId,
          conversation_pair: landedPair,
          message_id: syntheticId,
          direction: 'outbound',
          text,
          is_media: 0,
          observed_at: nowIso,
        });
      } catch (err) {
        // Non-fatal: the approval still gets marked applied because X
        // has accepted the message; a failed mirror-write here just
        // means the next poller tick will ingest the real row from
        // the inbox with the real message_id.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE|constraint/i.test(errMsg)) {
          logger.warn(
            { err: errMsg, approvalId: approval.id, landedPair },
            '[XDmReplyDispatcher] x_dm_messages outbound insert failed',
          );
        }
      }

      try {
        await this.db
          .from('x_dm_threads')
          .update({
            last_message_id: syntheticId,
            last_message_text: text,
            last_message_direction: 'outbound',
            last_seen_at: nowIso,
          })
          .eq('workspace_id', this.workspaceId)
          .eq('conversation_pair', landedPair);
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : err, approvalId: approval.id, landedPair },
          '[XDmReplyDispatcher] thread last-message patch failed',
        );
      }
    }

    this.appendJsonl({
      kind: 'outbound_sent',
      ts: nowIso,
      pair: landedPair,
      message_id: syntheticId,
      text,
      approval_id: approval.id,
    });

    markApprovalApplied(this.approvalsJsonlPath, approval.id, {
      posted: true,
      by: 'x_dm_reply_dispatcher',
      message_id: syntheticId,
      landed_pair: landedPair,
    });

    logger.info(
      { approvalId: approval.id, pair: landedPair, messageId: syntheticId },
      '[XDmReplyDispatcher] sent DM',
    );
    return true;
  }

  private appendJsonl(entry: Record<string, unknown>): void {
    if (!this.dataDir) return;
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dataDir, `x-dms-${day}.jsonl`);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, file },
        '[XDmReplyDispatcher] JSONL append failed',
      );
    }
  }
}
