/**
 * Pulse Route
 * GET /api/pulse — Composite real-time evolution snapshot for the landing page.
 *
 * Surfaces the metrics that matter for observing the autonomous loop:
 * self-bench activity, patch attempts, LLM burn, findings verdicts,
 * homeostasis state, and the latest authoring/revert outcomes.
 */

import { Router } from 'express';
import type Database from 'better-sqlite3';

interface VerdictRow { verdict: string; c: number }
interface ExpRow { experiment_id: string; c: number }
interface ModelRow { model: string; calls: number; tokens: number; cost_cents: number }
interface LlmBucket { calls: number; tokens: number; cost_cents: number }
interface PatchRow {
  id: string;
  finding_id: string;
  commit_sha: string | null;
  outcome: string;
  tier: string | null;
  patch_mode: string | null;
  proposed_at: string;
  resolved_at: string | null;
}
interface FindingRow {
  id: string;
  experiment_id: string | null;
  subject: string | null;
  verdict: string;
  summary: string | null;
  created_at: string;
  category: string | null;
}

const ONE_MIN = 60_000;

export function createPulseRouter(rawDb: Database.Database, startTime: number): Router {
  const router = Router();

  router.get('/api/pulse', async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      const now = Date.now();
      const uptimeMs = now - startTime;

      // ---- LLM burn windows (5m / 1h / 24h) ----
      const bucket = (sinceSec: number): LlmBucket => {
        const row = rawDb.prepare(`
          SELECT
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
            COALESCE(SUM(cost_cents), 0) AS cost_cents
          FROM llm_calls
          WHERE workspace_id = ? AND created_at > datetime('now', ?)
        `).get(workspaceId, `-${sinceSec} seconds`) as { calls: number; tokens: number; cost_cents: number } | undefined;
        return {
          calls: row?.calls ?? 0,
          tokens: row?.tokens ?? 0,
          cost_cents: row?.cost_cents ?? 0,
        };
      };

      const llm = {
        m5: bucket(300),
        h1: bucket(3600),
        h24: bucket(86_400),
      };

      const topModels = rawDb.prepare(`
        SELECT model,
               COUNT(*) AS calls,
               COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
               COALESCE(SUM(cost_cents), 0) AS cost_cents
        FROM llm_calls
        WHERE workspace_id = ? AND created_at > datetime('now', '-1 hour')
        GROUP BY model
        ORDER BY cost_cents DESC, calls DESC
        LIMIT 6
      `).all(workspaceId) as ModelRow[];

      const topExperimentsByBurn = rawDb.prepare(`
        SELECT COALESCE(experiment_id, 'unattributed') AS experiment_id,
               COUNT(*) AS c,
               COALESCE(SUM(cost_cents), 0) AS cost_cents
        FROM llm_calls
        WHERE workspace_id = ? AND created_at > datetime('now', '-1 hour')
        GROUP BY experiment_id
        ORDER BY cost_cents DESC, c DESC
        LIMIT 6
      `).all(workspaceId) as Array<{ experiment_id: string; c: number; cost_cents: number }>;

      // ---- Self-bench findings ----
      const activeByVerdict = rawDb.prepare(`
        SELECT verdict, COUNT(*) AS c
        FROM self_findings
        WHERE status='active'
        GROUP BY verdict
      `).all() as VerdictRow[];

      const topExperimentsBySignal = rawDb.prepare(`
        SELECT experiment_id, COUNT(*) AS c
        FROM self_findings
        WHERE status='active' AND created_at > datetime('now', '-1 hour')
        GROUP BY experiment_id
        ORDER BY c DESC
        LIMIT 8
      `).all() as ExpRow[];

      const findingsRate = rawDb.prepare(`
        SELECT COUNT(*) AS c
        FROM self_findings
        WHERE created_at > datetime('now', '-5 minutes')
      `).get() as { c: number };

      const activeFindingsTotal = rawDb.prepare(`
        SELECT COUNT(*) AS c FROM self_findings WHERE status='active'
      `).get() as { c: number };

      const recentFindings = rawDb.prepare(`
        SELECT id, experiment_id, subject, verdict, summary, created_at, category
        FROM self_findings
        WHERE status='active'
        ORDER BY created_at DESC
        LIMIT 10
      `).all() as FindingRow[];

      // ---- Patches attempted (autonomous) ----
      const patchCounts = rawDb.prepare(`
        SELECT outcome, COUNT(*) AS c FROM patches_attempted_log
        WHERE workspace_id=?
        GROUP BY outcome
      `).all(workspaceId) as Array<{ outcome: string; c: number }>;

      const recentPatches = rawDb.prepare(`
        SELECT id, finding_id, commit_sha, outcome, tier, patch_mode, proposed_at, resolved_at
        FROM patches_attempted_log
        WHERE workspace_id=?
        ORDER BY proposed_at DESC
        LIMIT 8
      `).all(workspaceId) as PatchRow[];

      // ---- Business vitals (homeostasis input) ----
      const latestVitals = rawDb.prepare(`
        SELECT ts, mrr, arr, active_users, daily_cost_cents, runway_days, source
        FROM business_vitals
        WHERE workspace_id=?
        ORDER BY ts DESC
        LIMIT 1
      `).get(workspaceId) as { ts: string; mrr: number | null; arr: number | null; active_users: number | null; daily_cost_cents: number | null; runway_days: number | null; source: string } | undefined;

      const recentReflexes = rawDb.prepare(`
        SELECT metric, action_type, severity, outcome, created_at
        FROM homeostasis_action_log
        WHERE workspace_id=?
        ORDER BY created_at DESC
        LIMIT 6
      `).all(workspaceId) as Array<{ metric: string; action_type: string; severity: number; outcome: string | null; created_at: string }>;

      // ---- Recent activity events ----
      const recentActivity = rawDb.prepare(`
        SELECT title, description, activity_type, created_at
        FROM agent_workforce_activity
        WHERE workspace_id=?
        ORDER BY created_at DESC
        LIMIT 10
      `).all(workspaceId) as Array<{ title: string; description: string | null; activity_type: string | null; created_at: string }>;

      // ---- Sales / Revenue pipeline ----
      // Funnel stages come from contact_events.kind. Newly-added leads show up
      // only in agent_workforce_contacts (no 'lead:added' event yet), so stage 1
      // reads contacts.created_at while later stages read events.
      const contactCount = (whereClause: string, params: unknown[]): number => {
        const row = rawDb.prepare(
          `SELECT COUNT(*) AS c FROM agent_workforce_contacts WHERE workspace_id=? ${whereClause}`
        ).get(workspaceId, ...params) as { c: number } | undefined;
        return row?.c ?? 0;
      };
      const eventCount = (kind: string, sinceClause = ''): number => {
        const row = rawDb.prepare(
          `SELECT COUNT(DISTINCT contact_id) AS c
             FROM agent_workforce_contact_events
             WHERE workspace_id=? AND kind=? ${sinceClause}`
        ).get(workspaceId, kind) as { c: number } | undefined;
        return row?.c ?? 0;
      };

      const funnel = {
        leads:      { total: contactCount('', []), h24: contactCount("AND created_at > datetime('now','-24 hours')", []) },
        qualified:  { total: eventCount('x:qualified'),    h24: eventCount('x:qualified',    "AND COALESCE(occurred_at, created_at) > datetime('now','-24 hours')") },
        reached:    { total: eventCount('x:reached'),      h24: eventCount('x:reached',      "AND COALESCE(occurred_at, created_at) > datetime('now','-24 hours')") },
        demos:      { total: eventCount('demo:booked'),    h24: eventCount('demo:booked',    "AND COALESCE(occurred_at, created_at) > datetime('now','-24 hours')") },
        trials:     { total: eventCount('trial:started'),  h24: eventCount('trial:started',  "AND COALESCE(occurred_at, created_at) > datetime('now','-24 hours')") },
        paid:       { total: eventCount('plan:paid'),      h24: eventCount('plan:paid',      "AND COALESCE(occurred_at, created_at) > datetime('now','-24 hours')") },
      };

      // Revenue roll-ups
      const revenueSum = (sinceSec: number | null): number => {
        const sql = sinceSec === null
          ? `SELECT COALESCE(SUM(amount_cents),0) AS s FROM agent_workforce_revenue_entries WHERE workspace_id=?`
          : `SELECT COALESCE(SUM(amount_cents),0) AS s FROM agent_workforce_revenue_entries WHERE workspace_id=? AND created_at > datetime('now', ?)`;
        const row = (sinceSec === null
          ? rawDb.prepare(sql).get(workspaceId)
          : rawDb.prepare(sql).get(workspaceId, `-${sinceSec} seconds`)) as { s: number } | undefined;
        return row?.s ?? 0;
      };
      const revenue = {
        h24: revenueSum(86_400),
        d7: revenueSum(7 * 86_400),
        d30: revenueSum(30 * 86_400),
        total: revenueSum(null),
      };

      const revenueByContact = rawDb.prepare(`
        SELECT r.contact_id, c.name,
               json_extract(c.custom_fields, '$.x_source') AS source,
               SUM(r.amount_cents) AS cents
        FROM agent_workforce_revenue_entries r
        LEFT JOIN agent_workforce_contacts c ON c.id = r.contact_id
        WHERE r.workspace_id = ?
        GROUP BY r.contact_id
        ORDER BY cents DESC
        LIMIT 5
      `).all(workspaceId) as Array<{ contact_id: string | null; name: string | null; source: string | null; cents: number }>;

      // Outbound dispatch (posts / replies) via x_posted_log
      const postDispatch = rawDb.prepare(`
        SELECT source, COUNT(*) AS c
        FROM x_posted_log
        WHERE workspace_id=? AND posted_at > datetime('now','-24 hours')
        GROUP BY source
      `).all(workspaceId) as Array<{ source: string | null; c: number }>;
      const postDispatchAllTime = rawDb.prepare(`
        SELECT COUNT(*) AS c FROM x_posted_log WHERE workspace_id=?
      `).get(workspaceId) as { c: number };

      // DM activity
      const dmThreads = rawDb.prepare(`
        SELECT COUNT(*) AS c FROM x_dm_threads WHERE workspace_id=?
      `).get(workspaceId) as { c: number };
      const dmThreadsWithContact = rawDb.prepare(`
        SELECT COUNT(*) AS c FROM x_dm_threads WHERE workspace_id=? AND contact_id IS NOT NULL
      `).get(workspaceId) as { c: number };
      const dmMessages24h = rawDb.prepare(`
        SELECT direction, COUNT(*) AS c
        FROM x_dm_messages
        WHERE workspace_id=? AND observed_at > datetime('now','-24 hours')
        GROUP BY direction
      `).all(workspaceId) as Array<{ direction: string; c: number }>;

      // Contact source breakdown (where our pipeline leads come from)
      const contactsBySource = rawDb.prepare(`
        SELECT COALESCE(json_extract(custom_fields, '$.x_source'), 'manual') AS source,
               COUNT(*) AS c
        FROM agent_workforce_contacts
        WHERE workspace_id=?
        GROUP BY source
        ORDER BY c DESC
        LIMIT 6
      `).all(workspaceId) as Array<{ source: string; c: number }>;

      // Recent CRM milestones — the actual revenue events we care about
      const crmMilestones = rawDb.prepare(`
        SELECT e.kind, e.title, e.description,
               COALESCE(e.occurred_at, e.created_at) AS ts,
               c.name AS contact_name
        FROM agent_workforce_contact_events e
        LEFT JOIN agent_workforce_contacts c ON c.id = e.contact_id
        WHERE e.workspace_id=? AND e.kind IS NOT NULL
        ORDER BY ts DESC
        LIMIT 10
      `).all(workspaceId) as Array<{ kind: string | null; title: string; description: string | null; ts: string; contact_name: string | null }>;

      // Approvals backlog (human-in-the-loop bottleneck) — surfaces from the
      // tasks queue; also count the x-approvals file-based queue kinds.
      const needsApproval = rawDb.prepare(`
        SELECT COUNT(*) AS c FROM agent_workforce_tasks
        WHERE workspace_id=? AND status='needs_approval'
      `).get(workspaceId) as { c: number };

      // ---- Extended pipeline detail ----
      // Unlinked DM threads: people we've talked to but the CRM has no
      // contact row for. Every unlinked thread is a lead leak.
      const unlinkedThreads = rawDb.prepare(`
        SELECT id, primary_name, last_preview, last_seen_at, conversation_pair, counterparty_user_id
        FROM x_dm_threads
        WHERE workspace_id=? AND contact_id IS NULL
        ORDER BY last_seen_at DESC
        LIMIT 8
      `).all(workspaceId) as Array<{
        id: string;
        primary_name: string | null;
        last_preview: string | null;
        last_seen_at: string;
        conversation_pair: string;
        counterparty_user_id: string | null;
      }>;

      // Contact-event breakdown by kind (all kinds, last 30d) so the
      // pulse shows what's actually happening in the funnel, not just
      // the six canonical stages.
      const eventsByKind = rawDb.prepare(`
        SELECT COALESCE(kind, 'unspecified') AS kind, COUNT(*) AS c
        FROM agent_workforce_contact_events
        WHERE workspace_id=? AND COALESCE(occurred_at, created_at) > datetime('now','-30 days')
        GROUP BY kind
        ORDER BY c DESC
        LIMIT 10
      `).all(workspaceId) as Array<{ kind: string; c: number }>;

      // Efficiency: cost per CRM lead and cost per qualified / paid.
      const totalBurnRow = rawDb.prepare(`
        SELECT COALESCE(SUM(cost_cents),0) AS c FROM llm_calls WHERE workspace_id=?
      `).get(workspaceId) as { c: number };
      const contactTotalRow = rawDb.prepare(`
        SELECT COUNT(*) AS c FROM agent_workforce_contacts WHERE workspace_id=?
      `).get(workspaceId) as { c: number };

      const efficiency = {
        totalBurnCents: totalBurnRow.c,
        costPerLeadCents: contactTotalRow.c > 0 ? Math.round(totalBurnRow.c / contactTotalRow.c) : 0,
        costPerQualifiedCents: funnel.qualified.total > 0 ? Math.round(totalBurnRow.c / funnel.qualified.total) : 0,
        costPerPaidCents: funnel.paid.total > 0 ? Math.round(totalBurnRow.c / funnel.paid.total) : 0,
      };

      // DM thread health: linked vs unlinked rollup.
      const dmHealth = {
        threadsTotal: dmThreads.c,
        threadsLinked: dmThreadsWithContact.c,
        threadsUnlinked: dmThreads.c - dmThreadsWithContact.c,
      };

      // Next-steps pipeline: the conversation analyst → dispatcher loop.
      // Surfaces the end-to-end "what did the human need / what is the
      // loop doing about it" view.
      interface NextStepEventRow {
        id: string;
        contact_id: string;
        payload: string | null;
        created_at: string;
      }
      const rawNextSteps = rawDb.prepare(`
        SELECT e.id, e.contact_id, e.payload, e.created_at, c.name AS contact_name
        FROM agent_workforce_contact_events e
        LEFT JOIN agent_workforce_contacts c ON c.id = e.contact_id
        WHERE e.workspace_id=? AND e.kind='next_step'
        ORDER BY e.created_at DESC
        LIMIT 25
      `).all(workspaceId) as Array<NextStepEventRow & { contact_name: string | null }>;

      interface NextStepItem {
        id: string;
        contactId: string;
        contactName: string | null;
        createdAt: string;
        stepType: string;
        urgency: string;
        status: string;
        text: string;
        suggestedAction: string;
        dispatchedKind?: string;
        findingId?: string;
        taskId?: string;
      }
      const nextSteps: NextStepItem[] = [];
      for (const row of rawNextSteps) {
        if (!row.payload) continue;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
        const stepType = typeof obj.step_type === 'string' ? obj.step_type : 'unknown';
        const urgency = typeof obj.urgency === 'string' ? obj.urgency : 'low';
        const status = typeof obj.status === 'string' ? obj.status : 'open';
        const text = typeof obj.text === 'string' ? obj.text : '';
        const suggestedAction = typeof obj.suggested_action === 'string' ? obj.suggested_action : '';
        const dispatchedKind = typeof obj.dispatched_kind === 'string' ? obj.dispatched_kind : undefined;
        const findingId = typeof obj.finding_id === 'string' ? obj.finding_id : undefined;
        const taskId = typeof obj.task_id === 'string' ? obj.task_id : undefined;
        nextSteps.push({
          id: row.id,
          contactId: row.contact_id,
          contactName: row.contact_name,
          createdAt: row.created_at,
          stepType,
          urgency,
          status,
          text,
          suggestedAction,
          dispatchedKind,
          findingId,
          taskId,
        });
      }

      const nextStepsRollup = {
        open:       nextSteps.filter(s => s.status === 'open').length,
        dispatched: nextSteps.filter(s => s.status === 'dispatched').length,
        shipped:    nextSteps.filter(s => s.status === 'shipped').length,
        ignored:    nextSteps.filter(s => s.status === 'ignored').length,
      };

      // ---- Heartbeat: is the loop alive? ----
      const lastLlmCallAt = rawDb.prepare(`
        SELECT created_at FROM llm_calls
        WHERE workspace_id=?
        ORDER BY created_at DESC LIMIT 1
      `).get(workspaceId) as { created_at: string } | undefined;
      const lastFindingAt = rawDb.prepare(`
        SELECT created_at FROM self_findings
        ORDER BY created_at DESC LIMIT 1
      `).get() as { created_at: string } | undefined;

      const parseTs = (ts: string): number => {
        const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z';
        return new Date(iso).getTime();
      };
      const heartbeatAgeMs = lastLlmCallAt
        ? Date.now() - parseTs(lastLlmCallAt.created_at)
        : null;
      const heartbeat =
        heartbeatAgeMs === null ? 'idle'
        : heartbeatAgeMs < ONE_MIN ? 'live'
        : heartbeatAgeMs < 10 * ONE_MIN ? 'slow'
        : 'idle';

      res.json({
        data: {
          generatedAt: new Date().toISOString(),
          uptimeMs,
          heartbeat,
          heartbeatAgeMs,
          lastLlmCallAt: lastLlmCallAt?.created_at ?? null,
          lastFindingAt: lastFindingAt?.created_at ?? null,
          llm: { ...llm, topModels, topExperiments: topExperimentsByBurn },
          findings: {
            activeTotal: activeFindingsTotal.c,
            activeByVerdict,
            topExperimentsLastHour: topExperimentsBySignal,
            rate5m: findingsRate.c,
            recent: recentFindings,
          },
          patches: {
            byOutcome: patchCounts,
            recent: recentPatches,
          },
          business: {
            latestVitals: latestVitals ?? null,
            recentReflexes,
          },
          pipeline: {
            funnel,
            revenue,
            revenueByContact,
            contactsBySource,
            outbound: {
              postsLast24h: postDispatch,
              postsAllTime: postDispatchAllTime.c,
              dmThreads: dmThreads.c,
              dmThreadsWithContact: dmThreadsWithContact.c,
              dmMessages24h,
            },
            approvalsPending: needsApproval.c,
            crmMilestones,
            unlinkedThreads,
            eventsByKind,
            efficiency,
            dmHealth,
            nextSteps,
            nextStepsRollup,
          },
          activity: recentActivity,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
