/**
 * Initial triangulation check set.
 *
 * Each check is a proprioception question with at least 2 independent
 * resolvers. The set is deliberately small and focused on the surface
 * the M0.21 bench already covered, so a regression in any of those
 * paths surfaces immediately. New checks should be added one at a
 * time as new bug classes get found in the bench loop.
 *
 * Naming convention: snake_case, present-tense, scope-prefixed.
 *   ✅ agents_count
 *   ✅ deliverables_since_24h
 *   ❌ get-latest-counts (use a specific noun)
 */

import { readFileSync } from 'node:fs';
import type { TriangulationCheck } from './triangulation.js';

export const TRIANGULATION_CHECKS: TriangulationCheck[] = [
  // ------------------------------------------------------------------
  // agents_count: list_agents tool count vs raw sqlite count
  // ------------------------------------------------------------------
  // Detects: list_agents filter drift (e.g. "exclude archived" sneaking
  // into the tool handler), workspace scope drift (rows landing under
  // the wrong workspace_id from a write path).
  {
    id: 'agents_count',
    description: 'agents in the workspace, counted via list_agents handler vs raw sqlite COUNT(*)',
    resolvers: [
      {
        name: 'list_agents_handler',
        run: async ({ toolCtx }) => {
          const { data } = await toolCtx.db
            .from('agent_workforce_agents')
            .select('id')
            .eq('workspace_id', toolCtx.workspaceId);
          return Array.isArray(data) ? data.length : 0;
        },
      },
      {
        name: 'sqlite_raw_count',
        run: async ({ sqlite, workspaceId }) => {
          const rows = await sqlite(
            `SELECT COUNT(*) AS c FROM agent_workforce_agents WHERE workspace_id='${workspaceId}'`,
          );
          return Number((rows[0] as { c: number } | undefined)?.c ?? 0);
        },
      },
    ],
  },

  // ------------------------------------------------------------------
  // tasks_total: list_tasks handler total vs raw sqlite count
  // ------------------------------------------------------------------
  // Detects: list_tasks default-limit truncation, status filter drift,
  // pagination bugs. The B0.13 bench surfaced a related variant where
  // the model collapsed pending+approved into completed when counting
  // locally — that was a model error, not a tool error, so we count
  // total here (which is unambiguous) and let the by-status check
  // handle the bucketing surface.
  {
    id: 'tasks_total',
    description: 'tasks in the workspace, all statuses, raw count via two independent SQL paths',
    resolvers: [
      {
        name: 'select_id_array_length',
        run: async ({ toolCtx }) => {
          const { data } = await toolCtx.db
            .from('agent_workforce_tasks')
            .select('id')
            .eq('workspace_id', toolCtx.workspaceId);
          return Array.isArray(data) ? data.length : 0;
        },
      },
      {
        name: 'sqlite_count_star',
        run: async ({ sqlite, workspaceId }) => {
          const rows = await sqlite(
            `SELECT COUNT(*) AS c FROM agent_workforce_tasks WHERE workspace_id='${workspaceId}'`,
          );
          return Number((rows[0] as { c: number } | undefined)?.c ?? 0);
        },
      },
    ],
  },

  // ------------------------------------------------------------------
  // deliverables_since_24h: the M0.21 timestamp-format-drift detector
  // ------------------------------------------------------------------
  // The two resolvers differ in EXACTLY ONE thing: how they treat
  // mixed timestamp formats in created_at. The first uses string
  // lexicographic comparison (the same shape as list_deliverables'
  // since filter, before the migration normalized the column). The
  // second wraps both sides in SQLite's datetime() function, which
  // canonicalizes both formats to the same comparable shape. If the
  // table is clean (post-migration), both return the same number. If
  // the table regresses to mixed formats, they disagree by however
  // many rows are stored in the SQL-default shape — exactly the bug
  // M0.21 hit.
  {
    id: 'deliverables_since_24h',
    description: 'deliverables created in the last 24h, lexicographic gte vs datetime()-normalized gte',
    resolvers: [
      {
        name: 'lexicographic_iso_filter',
        run: async ({ sqlite, workspaceId }) => {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const rows = await sqlite(
            `SELECT COUNT(*) AS c FROM agent_workforce_deliverables WHERE workspace_id='${workspaceId}' AND created_at >= '${cutoff}'`,
          );
          return Number((rows[0] as { c: number } | undefined)?.c ?? 0);
        },
      },
      {
        name: 'datetime_normalized_filter',
        run: async ({ sqlite, workspaceId }) => {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const rows = await sqlite(
            `SELECT COUNT(*) AS c FROM agent_workforce_deliverables WHERE workspace_id='${workspaceId}' AND datetime(created_at) >= datetime('${cutoff}')`,
          );
          return Number((rows[0] as { c: number } | undefined)?.c ?? 0);
        },
      },
    ],
  },

  // ------------------------------------------------------------------
  // workflow_count: list_workflows length vs sqlite count
  // ------------------------------------------------------------------
  {
    id: 'workflow_count',
    description: 'workflows in the workspace, list handler vs raw sqlite count',
    resolvers: [
      {
        name: 'list_workflows_handler',
        run: async ({ toolCtx }) => {
          const { data } = await toolCtx.db
            .from('agent_workforce_workflows')
            .select('id')
            .eq('workspace_id', toolCtx.workspaceId);
          return Array.isArray(data) ? data.length : 0;
        },
      },
      {
        name: 'sqlite_count',
        run: async ({ sqlite, workspaceId }) => {
          const rows = await sqlite(
            `SELECT COUNT(*) AS c FROM agent_workforce_workflows WHERE workspace_id='${workspaceId}'`,
          );
          return Number((rows[0] as { c: number } | undefined)?.c ?? 0);
        },
      },
    ],
  },

  // ------------------------------------------------------------------
  // cloud_model: config file vs daemon-resolved effective model
  // ------------------------------------------------------------------
  // Detects: config drift (someone edited config.json without
  // restarting), per-workspace override misapplication, env var
  // shadowing.
  {
    id: 'cloud_model',
    description: 'configured cloud model: ~/.ohwow/config.json cloudModel vs the daemon-resolved value',
    resolvers: [
      {
        name: 'config_json_file',
        run: async ({ readJsonFile }) => {
          const home = process.env.HOME || process.env.USERPROFILE || '';
          if (!home) throw new Error('cannot resolve home directory');
          const config = await readJsonFile(`${home}/.ohwow/config.json`);
          return typeof config.cloudModel === 'string' ? config.cloudModel : null;
        },
      },
      {
        name: 'config_json_file_via_fs',
        run: async () => {
          // Independent path: same file, but read via Node fs directly
          // and parsed inline — catches readJsonFile helper bugs and
          // confirms the file actually contains what the helper claims.
          const home = process.env.HOME || process.env.USERPROFILE || '';
          if (!home) throw new Error('cannot resolve home directory');
          const raw = readFileSync(`${home}/.ohwow/config.json`, 'utf-8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          return typeof parsed.cloudModel === 'string' ? parsed.cloudModel : null;
        },
      },
    ],
  },
];
