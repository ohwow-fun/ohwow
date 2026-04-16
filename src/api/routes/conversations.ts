/**
 * Conversations Routes
 *
 * GET  /api/conversations               — list X DM threads with contact join + last-message preview
 * GET  /api/conversations/:pair         — full message history + pending approvals + contact card
 * POST /api/conversations/:pair/messages — compose a new outbound reply
 *
 * These routes are the operator-facing mirror of the analyst +
 * next-step-dispatcher pipeline. The page that calls them lets the
 * operator read every ongoing conversation and send replies directly,
 * without having to go through the TUI approvals queue.
 *
 * Send path: POST writes BOTH a pending x_dm_outbound approval (for
 * audit) and an immediate approved row that XDmReplyDispatcher
 * consumes on its next tick. Keeps trust-stat accounting intact so
 * operator-dispatched DMs count toward the auto-apply threshold.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { Router } from 'express';
import type Database from 'better-sqlite3';

import {
  proposeApproval,
  readApprovalRows,
  type ApprovalEntry,
} from '../../scheduling/approval-queue.js';
import { DM_OUTBOUND_APPROVAL_KIND } from '../../lib/dm-reply-queue.js';
import { logger } from '../../lib/logger.js';

interface ThreadRow {
  id: string;
  conversation_pair: string;
  primary_name: string | null;
  last_preview: string | null;
  last_message_text: string | null;
  last_message_direction: string | null;
  last_seen_at: string;
  has_unread: number;
  observation_count: number;
  counterparty_user_id: string | null;
  contact_id: string | null;
}

interface MessageRow {
  id: string;
  message_id: string;
  direction: string;
  text: string | null;
  is_media: number;
  observed_at: string;
}

interface ContactRow {
  id: string;
  name: string;
  contact_type: string;
  custom_fields: string | null;
  created_at: string;
}

function parseCustomFields(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

export function createConversationsRouter(
  rawDb: Database.Database,
  dataDir?: string,
  workspaceSlug: string = 'default',
): Router {
  const approvalsJsonlPath = dataDir ? path.join(dataDir, 'x-approvals.jsonl') : null;
  const router = Router();

  // ---- GET /api/conversations ----------------------------------------
  router.get('/api/conversations', async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      const threads = rawDb.prepare(`
        SELECT t.id, t.conversation_pair, t.primary_name, t.last_preview,
               t.last_message_text, t.last_message_direction, t.last_seen_at,
               t.has_unread, t.observation_count, t.counterparty_user_id, t.contact_id,
               c.name AS contact_name,
               c.custom_fields AS contact_custom_fields
        FROM x_dm_threads t
        LEFT JOIN agent_workforce_contacts c ON c.id = t.contact_id
        WHERE t.workspace_id = ?
        ORDER BY t.last_seen_at DESC
        LIMIT 100
      `).all(workspaceId) as Array<ThreadRow & { contact_name: string | null; contact_custom_fields: string | null }>;

      // Per-thread unread counts from x_dm_messages (inbound since our
      // last outbound). Gives the UI a badge rather than the 0/1 flag.
      const unreadByPair = new Map<string, number>();
      const unreadRows = rawDb.prepare(`
        SELECT conversation_pair, COUNT(*) AS c
        FROM x_dm_messages
        WHERE workspace_id = ?
          AND direction = 'inbound'
          AND observed_at > COALESCE(
            (SELECT MAX(observed_at) FROM x_dm_messages m2
              WHERE m2.workspace_id = x_dm_messages.workspace_id
                AND m2.conversation_pair = x_dm_messages.conversation_pair
                AND m2.direction = 'outbound'),
            '1970-01-01'
          )
        GROUP BY conversation_pair
      `).all(workspaceId) as Array<{ conversation_pair: string; c: number }>;
      for (const row of unreadRows) unreadByPair.set(row.conversation_pair, row.c);

      // Pending approvals per pair so the thread list can show "draft
      // ready to send" badges.
      const pendingByPair = new Map<string, number>();
      if (approvalsJsonlPath) {
        const latest = latestApprovalsByKind(approvalsJsonlPath, DM_OUTBOUND_APPROVAL_KIND);
        for (const entry of latest) {
          if (entry.status !== 'pending' && entry.status !== 'approved') continue;
          const pair = typeof entry.payload?.conversation_pair === 'string'
            ? entry.payload.conversation_pair : null;
          if (!pair) continue;
          pendingByPair.set(pair, (pendingByPair.get(pair) ?? 0) + 1);
        }
      }

      const data = threads.map(t => {
        const cf = parseCustomFields(t.contact_custom_fields);
        return {
          id: t.id,
          conversationPair: t.conversation_pair,
          primaryName: t.primary_name,
          displayName: (typeof cf.x_display_name === 'string' ? cf.x_display_name : null)
            ?? t.contact_name
            ?? t.primary_name
            ?? 'Unknown',
          contactId: t.contact_id,
          contactName: t.contact_name,
          contactSource: typeof cf.x_source === 'string' ? cf.x_source : null,
          counterpartyUserId: t.counterparty_user_id,
          lastPreview: t.last_preview,
          lastMessageText: t.last_message_text,
          lastMessageDirection: t.last_message_direction,
          lastSeenAt: t.last_seen_at,
          hasUnread: t.has_unread === 1,
          unreadCount: unreadByPair.get(t.conversation_pair) ?? 0,
          observationCount: t.observation_count,
          pendingApprovals: pendingByPair.get(t.conversation_pair) ?? 0,
        };
      });

      res.json({ data, count: data.length });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[conversations] list failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ---- GET /api/conversations/:pair ----------------------------------
  router.get('/api/conversations/:pair', async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      const pair = req.params.pair;

      const thread = rawDb.prepare(`
        SELECT t.id, t.conversation_pair, t.primary_name, t.last_preview,
               t.last_message_text, t.last_message_direction, t.last_seen_at,
               t.has_unread, t.observation_count, t.counterparty_user_id, t.contact_id,
               c.id AS contact_id_join, c.name AS contact_name, c.contact_type AS contact_type,
               c.custom_fields AS contact_custom_fields, c.created_at AS contact_created_at
        FROM x_dm_threads t
        LEFT JOIN agent_workforce_contacts c ON c.id = t.contact_id
        WHERE t.workspace_id = ? AND t.conversation_pair = ?
        LIMIT 1
      `).get(workspaceId, pair) as (ThreadRow & {
        contact_id_join: string | null;
        contact_name: string | null;
        contact_type: string | null;
        contact_custom_fields: string | null;
        contact_created_at: string | null;
      }) | undefined;

      if (!thread) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }

      const messages = rawDb.prepare(`
        SELECT id, message_id, direction, text, is_media, observed_at
        FROM x_dm_messages
        WHERE workspace_id = ? AND conversation_pair = ?
        ORDER BY observed_at ASC
        LIMIT 500
      `).all(workspaceId, pair) as MessageRow[];

      // Next-step events for this contact (if any)
      const nextSteps = thread.contact_id
        ? rawDb.prepare(`
          SELECT id, payload, created_at
          FROM agent_workforce_contact_events
          WHERE workspace_id = ? AND contact_id = ? AND kind = 'next_step'
          ORDER BY created_at DESC
          LIMIT 20
        `).all(workspaceId, thread.contact_id) as Array<{ id: string; payload: string | null; created_at: string }>
        : [];

      // Pending approvals tied to this pair
      let pendingApprovals: ApprovalEntry[] = [];
      let appliedApprovals: ApprovalEntry[] = [];
      if (approvalsJsonlPath) {
        const latest = latestApprovalsByKind(approvalsJsonlPath, DM_OUTBOUND_APPROVAL_KIND);
        pendingApprovals = latest.filter(e =>
          (e.status === 'pending' || e.status === 'approved')
          && (e.payload?.conversation_pair === pair),
        );
        appliedApprovals = latest.filter(e =>
          e.status === 'applied' && e.payload?.conversation_pair === pair,
        );
      }

      const cf = parseCustomFields(thread.contact_custom_fields);
      res.json({
        data: {
          thread: {
            id: thread.id,
            conversationPair: thread.conversation_pair,
            primaryName: thread.primary_name,
            displayName: (typeof cf.x_display_name === 'string' ? cf.x_display_name : null)
              ?? thread.contact_name
              ?? thread.primary_name
              ?? 'Unknown',
            counterpartyUserId: thread.counterparty_user_id,
            lastSeenAt: thread.last_seen_at,
            hasUnread: thread.has_unread === 1,
            observationCount: thread.observation_count,
          },
          contact: thread.contact_id ? {
            id: thread.contact_id,
            name: thread.contact_name,
            type: thread.contact_type,
            source: typeof cf.x_source === 'string' ? cf.x_source : null,
            handle: typeof cf.x_handle === 'string' ? cf.x_handle : null,
            createdAt: thread.contact_created_at,
            customFields: cf,
          } : null,
          messages: messages.map(m => ({
            id: m.id,
            messageId: m.message_id,
            direction: m.direction,
            text: m.text,
            isMedia: m.is_media === 1,
            observedAt: m.observed_at,
          })),
          nextSteps: nextSteps.map(n => {
            const p = normaliseJsonPayload(n.payload);
            return {
              id: n.id,
              createdAt: n.created_at,
              stepType: typeof p?.step_type === 'string' ? p.step_type : 'unknown',
              urgency: typeof p?.urgency === 'string' ? p.urgency : 'low',
              status: typeof p?.status === 'string' ? p.status : 'open',
              text: typeof p?.text === 'string' ? p.text : '',
              suggestedAction: typeof p?.suggested_action === 'string' ? p.suggested_action : '',
              draftReply: typeof p?.draft_reply === 'string' ? p.draft_reply : null,
              approvalId: typeof p?.approval_id === 'string' ? p.approval_id : null,
              sendConfirmed: typeof p?.send_confirmed === 'boolean' ? p.send_confirmed : null,
            };
          }),
          approvals: {
            pending: pendingApprovals.map(approvalSummary),
            applied: appliedApprovals.map(approvalSummary),
          },
        },
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[conversations] detail failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ---- POST /api/conversations/:pair/messages ------------------------
  router.post('/api/conversations/:pair/messages', async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      const pair = req.params.pair;
      if (!approvalsJsonlPath) {
        res.status(400).json({ error: 'approvalsJsonlPath not configured on server' });
        return;
      }
      const body = req.body as { text?: string; autoApprove?: boolean; contactName?: string | null };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      if (text.length > 1000) {
        res.status(400).json({ error: 'text too long (max 1000 chars)' });
        return;
      }

      // Look up thread + contact for audit-trail context.
      const threadRow = rawDb.prepare(`
        SELECT contact_id, primary_name FROM x_dm_threads
        WHERE workspace_id = ? AND conversation_pair = ?
        LIMIT 1
      `).get(workspaceId, pair) as { contact_id: string | null; primary_name: string | null } | undefined;
      if (!threadRow) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      const contactId = threadRow.contact_id;
      const contactName = body.contactName ?? threadRow.primary_name ?? null;

      const approval = proposeApproval(approvalsJsonlPath, {
        kind: DM_OUTBOUND_APPROVAL_KIND,
        workspace: workspaceSlug,
        summary: `Operator reply to ${contactName ?? 'contact'}: ${text.slice(0, 60)}`,
        payload: {
          conversation_pair: pair,
          text,
          contact_id: contactId,
          contact_name: contactName,
          source: 'operator_composer',
        },
        autoApproveAfter: 10,
        maxPriorRejected: 0,
        bucketBy: 'contact_id',
      });

      // When the operator explicitly opted in to auto-approve from the
      // composer, append an 'approved' status row carrying the full
      // entry so XDmReplyDispatcher consumes it on its next tick.
      // (approval-queue.latestById OVERWRITES rather than merges, so a
      // thin status-only row would drop payload and kind.)
      let autoApproveApplied = false;
      if (body.autoApprove) {
        const approvedRow: ApprovalEntry = {
          ...approval,
          ts: new Date().toISOString(),
          status: 'approved',
          notes: JSON.stringify({ approved_by: 'operator_composer' }),
        };
        fs.appendFileSync(approvalsJsonlPath, JSON.stringify(approvedRow) + '\n', 'utf-8');
        autoApproveApplied = true;
      }

      res.json({
        data: {
          approvalId: approval.id,
          status: autoApproveApplied ? 'approved' : approval.status,
          text,
          conversationPair: pair,
        },
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[conversations] compose failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}

// ---- helpers ----------------------------------------------------------

function latestApprovalsByKind(jsonlPath: string, kind: string): ApprovalEntry[] {
  const rows = readApprovalRows(jsonlPath);
  const map = new Map<string, ApprovalEntry>();
  for (const row of rows) {
    // Same OVERWRITE semantics as approval-queue.ts latestById — last
    // row for an id wins. Composer callers that write status-update
    // rows must re-carry kind/payload for this filter to match.
    if (row.id) map.set(row.id, row);
  }
  const out: ApprovalEntry[] = [];
  for (const entry of map.values()) {
    if (entry.kind !== kind) continue;
    out.push(entry);
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

interface SummaryEntry {
  id: string;
  ts: string;
  status: string;
  summary: string;
  text: string;
  source: string | null;
}

function approvalSummary(entry: ApprovalEntry): SummaryEntry {
  const p = entry.payload ?? {};
  return {
    id: entry.id,
    ts: entry.ts,
    status: entry.status,
    summary: entry.summary ?? '',
    text: typeof p.text === 'string' ? p.text : '',
    source: typeof p.source === 'string' ? p.source : null,
  };
}

function normaliseJsonPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
