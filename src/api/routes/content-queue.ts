/**
 * Content Queue Route
 *
 * GET /api/content-queue — single flat view of the ohwow content engine
 * for the cloud dashboard's Content Calendar screen.
 *
 * The content engine has three emit paths (distiller → x_post_drafts,
 * content-cadence → agent_workforce_tasks, x-humor → tasks/cadence)
 * and a post-publish log (posted_log). Each lives in its own surface.
 * The dashboard needs a unified queue without stitching four fetches
 * together with inconsistent envelopes, so this route does it in one.
 *
 * Returns:
 *   pending:    pending x_post_drafts awaiting approve/reject
 *   inflight:   agent_workforce_tasks created by content dispatchers,
 *               still pending or running
 *   shipped:    posted_log last 7d (x + threads)
 *   failures:   agent_workforce_tasks from content dispatchers that
 *               ended status='failed' in last 7d
 *   automations: ohwow:content-cadence / x-draft-distiller / x-humor
 *               with enabled/fire_count/last_fired_at
 *   distiller:  derived observability — {last24h_fire_count,
 *               pending_drafts_24h, approved_drafts_24h,
 *               rejected_drafts_24h, emit_rate_per_fire} so the UI
 *               can surface "ran N times, emitted 0" when it's true
 *
 * No writes; see /api/x-drafts/:id/{approve,reject} for mutation.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

interface XPostDraftRow {
  id: string;
  workspace_id: string;
  body: string;
  source_finding_id: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  title: string | null;
  description: string | null;
  input: string | null;
  status: string;
  metadata: string | Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

interface PostedLogRow {
  id: string;
  workspace_id: string;
  platform: string;
  text_hash: string;
  text_preview: string;
  posted_at: string;
  source: string | null;
  task_id: string | null;
}

interface AutomationRow {
  id: string;
  name: string;
  enabled: number | boolean;
  fire_count: number | null;
  last_fired_at: string | null;
  status: string;
}

const CONTENT_AUTOMATION_NAMES = new Set([
  'ohwow:content-cadence',
  'ohwow:x-draft-distiller',
  'ohwow:x-humor',
]);

function parseMetadata(raw: TaskRow['metadata']): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isContentDispatcherTask(task: TaskRow): boolean {
  const meta = parseMetadata(task.metadata);
  const dispatcher = typeof meta.dispatcher === 'string' ? meta.dispatcher : '';
  return dispatcher === 'content_cadence' || dispatcher === 'x_humor';
}

export function createContentQueueRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/content-queue', async (req, res) => {
    try {
      const { workspaceId } = req;
      if (!workspaceId) {
        res.status(400).json({ error: 'workspace not resolved' });
        return;
      }

      const now = Date.now();
      const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

      // 1. Pending X drafts (distiller output gated on operator approval)
      const { data: allDraftsData } = await db
        .from<XPostDraftRow>('x_post_drafts')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(200);
      const allDrafts: XPostDraftRow[] = allDraftsData ?? [];
      const pending = allDrafts.filter((d) => d.status === 'pending');

      // Distiller stats (24h window)
      const drafts24h = allDrafts.filter((d) => d.created_at >= cutoff24h);
      const distiller = {
        pending_24h: drafts24h.filter((d) => d.status === 'pending').length,
        approved_24h: drafts24h.filter((d) => d.status === 'approved').length,
        rejected_24h: drafts24h.filter((d) => d.status === 'rejected').length,
        total_24h: drafts24h.length,
      };

      // 2. In-flight content-dispatcher tasks
      const { data: recentTasks } = await db
        .from<TaskRow>('agent_workforce_tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .gte('created_at', cutoff7d)
        .order('created_at', { ascending: false })
        .limit(200);
      const contentTasks: TaskRow[] = (recentTasks ?? []).filter(isContentDispatcherTask);
      const inflight = contentTasks.filter(
        (t) => t.status === 'pending' || t.status === 'running',
      );
      const failures = contentTasks.filter((t) => t.status === 'failed');

      // 3. Shipped posts last 7d
      const { data: shippedData } = await db
        .from<PostedLogRow>('posted_log')
        .select('*')
        .eq('workspace_id', workspaceId)
        .gte('posted_at', cutoff7d)
        .order('posted_at', { ascending: false })
        .limit(100);
      const shipped: PostedLogRow[] = shippedData ?? [];

      // 4. Automation states (filtered to the content ones).
      // Runtime stores automations in `local_triggers`; the cloud
      // mirror uses `agent_workforce_workflows`. The runtime table
      // has no workspace_id column (the whole DB is workspace-scoped)
      // so we filter by name only.
      const { data: autoData } = await db
        .from<AutomationRow>('local_triggers')
        .select('id, name, enabled, fire_count, last_fired_at, status')
        .limit(200);
      const automations = (autoData ?? [])
        .filter((a) => CONTENT_AUTOMATION_NAMES.has(a.name))
        .map((a) => ({
          id: a.id,
          name: a.name,
          enabled: Boolean(a.enabled),
          fire_count: a.fire_count ?? 0,
          last_fired_at: a.last_fired_at,
          status: a.status,
        }));

      res.json({
        data: {
          pending: pending.map((d) => ({
            id: d.id,
            body: d.body,
            source_finding_id: d.source_finding_id,
            created_at: d.created_at,
            source: 'x-draft-distiller',
            platform: 'x',
          })),
          inflight: inflight.map((t) => {
            const meta = parseMetadata(t.metadata);
            return {
              id: t.id,
              title: t.title,
              status: t.status,
              agent_id: t.agent_id,
              created_at: t.created_at,
              dispatcher: typeof meta.dispatcher === 'string' ? meta.dispatcher : null,
              platform: typeof meta.platform === 'string' ? meta.platform : null,
            };
          }),
          shipped: shipped.map((p) => ({
            id: p.id,
            platform: p.platform,
            text_preview: p.text_preview,
            posted_at: p.posted_at,
            source: p.source,
            task_id: p.task_id,
            kind: p.source && p.source.startsWith('reply_to:') ? 'reply' : 'post',
          })),
          failures: failures.map((t) => {
            const meta = parseMetadata(t.metadata);
            return {
              id: t.id,
              title: t.title,
              error: t.error,
              completed_at: t.completed_at,
              created_at: t.created_at,
              dispatcher: typeof meta.dispatcher === 'string' ? meta.dispatcher : null,
              platform: typeof meta.platform === 'string' ? meta.platform : null,
            };
          }),
          automations,
          distiller,
          generated_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.error({ err }, '[content-queue] list failed');
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  return router;
}
