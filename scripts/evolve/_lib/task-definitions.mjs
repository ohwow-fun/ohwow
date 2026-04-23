/**
 * Seed task definitions for the self-evolution system.
 * High-priority product tasks — real feature work, not trivial additions.
 */

export const SEED_TASKS = [
  // -------------------------------------------------------------------------
  // BATCH 1 — Replace hardcoded model strings in seed-templates.ts
  // -------------------------------------------------------------------------
  {
    taskId: 'fix-seed-templates-hardcoded-model',
    title: 'Replace hardcoded claude-sonnet-4-20250514 in seed-templates.ts with a named constant',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -20',
    description: `
EXACT TASK — do exactly this and nothing else:

File to edit: src/lib/seed-templates.ts

Step 1: Read the file. It starts with a JSDoc comment block (lines 1-9) then
exports const SEED_TEMPLATES = [...].

Step 2: After line 9 (the closing */ of the JSDoc block), insert these two lines:
  /** Default LLM model used by seed-template agents. Override via SEED_TEMPLATE_MODEL env var. */
  const SEED_AGENT_MODEL = process.env.SEED_TEMPLATE_MODEL ?? 'claude-sonnet-4-5';

Step 3: The file has exactly 13 occurrences of the string 'claude-sonnet-4-20250514'
(on lines 24, 40, 40, 56, 72, 88, 104, 120, 136, 152, 168, 188, 189, 209).
Replace ALL 13 occurrences of 'claude-sonnet-4-20250514' with SEED_AGENT_MODEL.

The replacement turns this:
  config: { model: 'claude-sonnet-4-20250514', temperature: 0.3 ... }
into:
  config: { model: SEED_AGENT_MODEL, temperature: 0.3 ... }

Step 4: Verify with: grep -c "claude-sonnet-4-20250514" src/lib/seed-templates.ts
The count must be 0.

IMPORTANT:
- Do NOT touch any other file.
- Do NOT change the shape of the exported SEED_TEMPLATES array.
- Do NOT modify package.json.
- The constant SEED_AGENT_MODEL is NOT exported — it is file-private.
- Use bash with sed to do the replacement:
  sed -i '' 's/claude-sonnet-4-20250514/SEED_AGENT_MODEL/g' src/lib/seed-templates.ts
  Then manually insert the const declaration after line 9.
    `,
    acceptanceCriteria: [
      'No string literal "claude-sonnet-4-20250514" remains in src/lib/seed-templates.ts',
      'SEED_AGENT_MODEL constant is defined near the top of the file',
      'TypeScript typecheck passes (npm run typecheck)',
      'No other files were changed',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 2 — A2A agent card endpoint (Google A2A spec compliance)
  // -------------------------------------------------------------------------
  {
    taskId: 'implement-a2a-agent-card-endpoint',
    title: 'Implement /.well-known/agent.json A2A agent card endpoint in Express API',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
EXACT TASK — add a /.well-known/agent.json GET route to the existing A2A router.

FILES TO READ FIRST:
1. src/a2a/types.ts — has A2AAgentCard and A2ASkill interfaces (around line 36-65)
2. src/api/routes/a2a.ts — existing router file; add the new route here
3. src/api/server.ts lines 638 area — shows app.use(createA2ARouter(db))

WHAT TO ADD in src/api/routes/a2a.ts (BEFORE the closing "return router;" line):

  // /.well-known/agent.json — A2A agent card (no auth required, public)
  router.get('/.well-known/agent.json', async (req, res) => {
    try {
      const baseUrl = process.env.OHWOW_PUBLIC_URL || 'http://localhost:7700';
      const card = {
        name: 'ohwow runtime',
        description: 'Local-first AI business operating system with autonomous agents',
        url: baseUrl,
        version: '1.0.0',
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        authentication: {
          schemes: ['bearer'],
        },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      };
      res.set('Content-Type', 'application/json');
      res.json(card);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

The route is intentionally placed WITHOUT auth middleware because A2A card
endpoints must be publicly readable for peer discovery. The existing auth
middleware in server.ts is mounted at /api/* so this /.well-known/* path
is not covered by it.

IMPORTANT:
- Only modify src/api/routes/a2a.ts
- Do NOT add a new import for A2AAgentCard — just use the inline object literal
- Do NOT register a new router in server.ts — it already uses createA2ARouter
- The route must be /.well-known/agent.json (not /agent-card, not /agent.json)
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'GET /.well-known/agent.json route exists in src/api/routes/a2a.ts',
      'Response includes name, description, url, version, capabilities fields',
      'Route returns Content-Type: application/json',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 3 — Wire market intel buyer_intent → outreach pipeline
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-market-intel-outreach-trigger',
    title: 'Wire buyer_intent market intel signals into the outreach trigger pipeline',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
WRITE THIS FILE EXACTLY. No exploration needed. Just create the file.

Target file: src/scheduling/intel-outreach-trigger.ts

Use write_file with path="src/scheduling/intel-outreach-trigger.ts" and this exact content:

/**
 * IntelOutreachTrigger — reads market intel briefs and creates agent tasks
 * for buyer_intent signals that haven't been processed yet.
 *
 * Call tick() on a schedule (e.g. hourly) from the daemon.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';

interface IntelBrief {
  id: string;
  bucket: string;
  headline: string;
  ohwow_implications: string;
  score: number;
}

export class IntelOutreachTrigger {
  private db: DatabaseAdapter;
  private workspaceId: string;
  private workspaceName: string;

  constructor(db: DatabaseAdapter, workspaceId: string, workspaceName = 'default') {
    this.db = db;
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
  }

  async tick(): Promise<void> {
    const intelDir = path.join(
      os.homedir(), '.ohwow', 'workspaces', this.workspaceName, 'intel'
    );
    if (!fs.existsSync(intelDir)) return;

    // Find the latest day directory (YYYY-MM-DD)
    const days = fs.readdirSync(intelDir)
      .filter(d => /^\\d{4}-\\d{2}-\\d{2}$/.test(d))
      .sort()
      .reverse();
    if (days.length === 0) return;

    const dayDir = path.join(intelDir, days[0]);
    const briefsPath = path.join(dayDir, 'briefs.json');
    if (!fs.existsSync(briefsPath)) return;

    let briefs: IntelBrief[] = [];
    try {
      briefs = JSON.parse(fs.readFileSync(briefsPath, 'utf8')) as IntelBrief[];
    } catch {
      return;
    }

    const seenPath = path.join(dayDir, 'outreach-seen.json');
    let seen: string[] = [];
    try {
      seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')) as string[];
    } catch { /* first run — seen list starts empty */ }

    const unseen = briefs.filter(
      b => b.bucket === 'buyer_intent' && !seen.includes(b.id)
    );

    for (const brief of unseen) {
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        await this.db.from('agent_workforce_tasks').insert({
          id,
          workspace_id: this.workspaceId,
          title: \`Follow up on buyer intent signal: \${brief.headline}\`,
          description: brief.ohwow_implications || brief.headline,
          status: 'pending',
          priority: 'high',
          source: 'intel_outreach_trigger',
          created_at: now,
          updated_at: now,
        });
        seen.push(brief.id);
        logger.info(
          { briefId: brief.id, headline: brief.headline },
          '[intel-outreach] task created for buyer_intent signal',
        );
      } catch (err) {
        logger.warn({ err, briefId: brief.id }, '[intel-outreach] failed to create task');
      }
    }

    if (unseen.length > 0) {
      fs.writeFileSync(seenPath, JSON.stringify(seen, null, 2));
    }
  }
}

After writing the file, run: npm run typecheck 2>&1 | tail -20
Fix any TypeScript errors you see. Common issues:
- If DatabaseAdapter.from().insert() returns a Promise, await it (it already does in the code above).
- If the insert signature differs, look at how other files call db.from().insert() and match that pattern.

Do NOT modify any existing files. Do NOT wire this into daemon startup.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'src/scheduling/intel-outreach-trigger.ts exists with IntelOutreachTrigger class',
      'tick() method reads briefs.json and creates tasks for buyer_intent signals',
      'Processed signals are tracked in outreach-seen.json to avoid duplicates',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 4 — Wire channel message storage for inner-thoughts unreadMessages
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-unread-messages-inner-thoughts',
    title: 'Wire unreadMessages from conversation store into inner-thoughts context snapshot',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
EXACT TASK — make two precise edits to src/presence/inner-thoughts.ts.

BACKGROUND (do NOT re-read these files — all context is here):
- The ContextSnapshot type (in src/presence/types.ts line 69) defines:
    unreadMessages: Array<{ channel: string; from: string; preview: string }>;
- The DB has a table orchestrator_conversations with columns:
    id, workspace_id, title, source, channel, last_message_at, message_count, is_archived
  and a table orchestrator_messages with columns:
    id, conversation_id, workspace_id, role, content, model, created_at
- The gatherContext() method is at line 171 of src/presence/inner-thoughts.ts
- Line 244 currently reads:
    unreadMessages: [], // TODO: Wire when channel message storage is implemented

EDIT 1 — Add a query for recent messages INSIDE gatherContext(), right before the "return {" on line 241.
Add this block (after the existing fleet sensing at line 219):

    // Fetch recent inbound messages from the last 24 hours as a proxy for "unread"
    let unreadMessages: Array<{ channel: string; from: string; preview: string }> = [];
    try {
      const msgCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentMsgRows } = await this.db
        .from('orchestrator_messages')
        .select('id, conversation_id, role, content, created_at')
        .eq('workspace_id', this.workspaceId)
        .eq('role', 'user')
        .gte('created_at', msgCutoff)
        .order('created_at', { ascending: false })
        .limit(5);
      if (recentMsgRows) {
        unreadMessages = (recentMsgRows as Array<Record<string, unknown>>).map(m => ({
          channel: 'chat',
          from: 'user',
          preview: String(m.content).slice(0, 120),
        }));
      }
    } catch {
      // conversations table may not exist yet — degrade gracefully
    }

EDIT 2 — On line 244, replace:
    unreadMessages: [], // TODO: Wire when channel message storage is implemented
with:
    unreadMessages,

That's it. Do not change anything else in the file. Do not modify types.ts.
After making both edits, run: npm run typecheck 2>&1 | tail -20
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'The TODO comment on unreadMessages line is removed',
      'gatherContext() queries orchestrator_messages for recent user messages',
      'Graceful try/catch fallback returns [] if the query fails',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 5 — Wire onboarding integration presets from agent selections
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-onboarding-integration-presets',
    title: 'Derive onboarding integrations from selected agent presets instead of hardcoding',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
TARGET FILE (the ONLY file to edit): src/web/src/hooks/useOnboarding.ts

DO NOT read any other files. DO NOT explore. Apply this exact change:

1. Add this pure function BEFORE the \`useOnboarding\` hook definition (before the line "export function useOnboarding"):

\`\`\`typescript
/**
 * Maps selected agent preset IDs to the MCP integrations they require.
 * Agents that manage social media need Twitter; email agents need Gmail; etc.
 */
function deriveIntegrationsFromPresets(selectedAgentIds: Set<string>): McpIntegration[] {
  const needed = new Set<string>();

  for (const id of selectedAgentIds) {
    // Social media agents
    if (id.includes('social') || id.includes('linkedin') || id.includes('sponsor')) {
      needed.add('twitter');
      needed.add('linkedin');
    }
    // Email / campaign agents
    if (id.includes('email') || id.includes('campaign') || id.includes('outreach') || id.includes('follow_up')) {
      needed.add('gmail');
    }
    // Calendar / scheduling agents
    if (id.includes('schedule') || id.includes('calendar') || id.includes('dispatch') || id.includes('meeting')) {
      needed.add('gcal');
    }
    // GitHub / dev agents
    if (id.includes('github') || id.includes('code') || id.includes('developer')) {
      needed.add('github');
    }
  }

  const INTEGRATION_DEFS: Record<string, McpIntegration> = {
    twitter: {
      id: 'twitter',
      name: 'Twitter / X',
      description: 'Post and read tweets for your social media agents',
      envVarsRequired: [{ key: 'TWITTER_API_KEY', label: 'API Key', secret: true }, { key: 'TWITTER_API_SECRET', label: 'API Secret', secret: true }],
    },
    linkedin: {
      id: 'linkedin',
      name: 'LinkedIn',
      description: 'Post updates and manage LinkedIn presence',
      envVarsRequired: [{ key: 'LINKEDIN_CLIENT_ID', label: 'Client ID', secret: false }, { key: 'LINKEDIN_CLIENT_SECRET', label: 'Client Secret', secret: true }],
    },
    gmail: {
      id: 'gmail',
      name: 'Gmail',
      description: 'Read and send emails on behalf of your agents',
      envVarsRequired: [{ key: 'GMAIL_CLIENT_ID', label: 'Client ID', secret: false }, { key: 'GMAIL_CLIENT_SECRET', label: 'Client Secret', secret: true }],
    },
    gcal: {
      id: 'gcal',
      name: 'Google Calendar',
      description: 'Read and create calendar events',
      envVarsRequired: [{ key: 'GCAL_CLIENT_ID', label: 'Client ID', secret: false }, { key: 'GCAL_CLIENT_SECRET', label: 'Client Secret', secret: true }],
    },
    github: {
      id: 'github',
      name: 'GitHub',
      description: 'Read repositories, issues, and pull requests',
      envVarsRequired: [{ key: 'GITHUB_TOKEN', label: 'Personal Access Token', secret: true }],
    },
  };

  return Array.from(needed).map(id => INTEGRATION_DEFS[id]).filter(Boolean);
}
\`\`\`

2. Replace these exact lines (around line 528-531):
\`\`\`
  const goToIntegrationSetup = useCallback(() => {
    // TODO: In the future, derive integrations from selected agent presets
    // For now, show empty (no integrations needed) and auto-advance to ready
    setState(s => ({ ...s, screen: 'integration_setup' }));
  }, []);
\`\`\`

With:
\`\`\`
  const goToIntegrationSetup = useCallback(() => {
    setState(s => ({
      ...s,
      screen: 'integration_setup',
      integrations: deriveIntegrationsFromPresets(s.selectedAgentIds),
    }));
  }, []);
\`\`\`

3. Check if McpEnvVar interface already has a \`secret\` field. If it does not, add it:
   Find the McpEnvVar interface (should be near McpIntegration around line 83) and add \`secret?: boolean;\` if not present.

That is the complete change. Do not touch any other file.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'deriveIntegrationsFromPresets function exists in useOnboarding.ts',
      'The TODO comment is removed and goToIntegrationSetup now calls deriveIntegrationsFromPresets',
      'At least 4 integrations are mapped (twitter, linkedin, gmail, gcal)',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 6 — Wire real mesh peer count into inner-thoughts context
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-mesh-peer-count-inner-thoughts-v2',
    title: 'Add connectedPeerCount to ContextSnapshot and populate it from MeshCoordinator',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
TARGET FILES (edit ONLY these two files):
  1. src/presence/types.ts
  2. src/presence/inner-thoughts.ts

DO NOT read any other files. DO NOT explore. Apply these exact changes:

=== CHANGE 1: src/presence/types.ts ===

The ContextSnapshot interface currently ends with:
  /** Current time of day context. */
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
}

Add ONE new field BEFORE the closing brace:
  /** Number of peer nodes currently in the mesh (including self). 1 = solo operation. */
  connectedPeerCount: number;

So the interface becomes:
  /** Current time of day context. */
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  /** Number of peer nodes currently in the mesh (including self). 1 = solo operation. */
  connectedPeerCount: number;
}

=== CHANGE 2: src/presence/inner-thoughts.ts ===

The InnerThoughtsLoop constructor signature is currently:
  constructor(
    private db: DatabaseAdapter,
    private workspace: GlobalWorkspace,
    private modelRouter: ModelRouter,
    private workspaceId: string,
  ) {}

Add an optional meshCoordinator parameter. First add this import at the top of the file
(after the existing imports):
  import type { MeshCoordinator } from '../peers/mesh-coordinator.js';

Then change the constructor to:
  constructor(
    private db: DatabaseAdapter,
    private workspace: GlobalWorkspace,
    private modelRouter: ModelRouter,
    private workspaceId: string,
    private meshCoordinator?: MeshCoordinator,
  ) {}

In gatherContext(), the return statement currently is:
    return {
      pendingTasks,
      recentCompletions,
      unreadMessages,
      overnightActivity: {
        tasksCompleted: overnightCompleted.count ?? 0,
        tasksStarted: overnightStarted.count ?? 0,
        errors: overnightFailed.count ?? 0,
      },
      userIdleMs,
      timeOfDay,
    };

Change it to:
    return {
      pendingTasks,
      recentCompletions,
      unreadMessages,
      overnightActivity: {
        tasksCompleted: overnightCompleted.count ?? 0,
        tasksStarted: overnightStarted.count ?? 0,
        errors: overnightFailed.count ?? 0,
      },
      userIdleMs,
      timeOfDay,
      connectedPeerCount: this.meshCoordinator?.deviceCount ?? 1,
    };

That is the complete change. Do not touch any other file.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'ContextSnapshot interface in src/presence/types.ts has connectedPeerCount: number',
      'InnerThoughtsLoop constructor accepts optional meshCoordinator parameter',
      'gatherContext() populates connectedPeerCount from meshCoordinator.deviceCount',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 7 — Presence: wire real peer count from mesh into inner-thoughts
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-mesh-peer-count-inner-thoughts',
    title: 'Wire real mesh peer count into inner-thoughts context (replace hardcoded 0)',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
The InnerThoughtsEngine at src/presence/inner-thoughts.ts generates "thoughts"
about what's happening on the platform. One dimension it should consider is
how many peer nodes are currently connected via the mesh network.

Steps:
1. Read src/presence/inner-thoughts.ts fully to understand the ContextSnapshot
   interface and gatherContext().
2. Read src/mesh/mesh-coordinator.ts or similar to find how to get the current
   connected peer count (look for connectedPeers, peerCount, getPeers(), etc.).
3. Add a connectedPeerCount: number field to the ContextSnapshot interface in
   inner-thoughts.ts.
4. In gatherContext(), populate it by calling the mesh coordinator or reading
   from the peers table. If InnerThoughtsEngine doesn't have a reference to
   the mesh, add an optional meshCoordinator parameter to the constructor.
5. Update the distill() prompt in inner-thoughts.ts to mention peer count when
   relevant (e.g., "X peer nodes connected" in the context summary).

The purpose: if the daemon has 3 peer nodes syncing work, the thoughts should
reflect "distributed team active" rather than assuming solo operation.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'ContextSnapshot interface has a connectedPeerCount: number field',
      'gatherContext() populates connectedPeerCount from mesh state',
      'No hardcoded 0 for peer count',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 8 — Self-bench: implement real experiment result persistence
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-self-bench-result-persistence',
    title: 'Persist self-bench experiment results to SQLite instead of in-memory only',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
TARGET: Create TWO new files only. Do not read or modify any existing files.

=== FILE 1: src/db/migrations/151-self-bench-results.sql ===

Write exactly this content:

-- Self-bench experiment result log.
-- Tracks which A/B comparisons the system has run and their outcomes,
-- so future experiment selection avoids redundant comparisons.
CREATE TABLE IF NOT EXISTS self_bench_results (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id    TEXT NOT NULL,
  experiment_id   TEXT NOT NULL,
  config_a        TEXT NOT NULL,
  config_b        TEXT NOT NULL,
  winner          TEXT,
  score_a         REAL,
  score_b         REAL,
  verdict         TEXT,
  raw_json        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_self_bench_workspace
  ON self_bench_results(workspace_id, created_at DESC);


=== FILE 2: src/self-bench/self-bench-results-store.ts ===

Write exactly this content:

/**
 * self-bench-results-store — persistence for A/B experiment outcomes.
 *
 * Inserts experiment results into self_bench_results so they survive
 * daemon restarts and inform future experiment selection.
 */

import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export interface SelfBenchResult {
  experimentId: string;
  configA: string;
  configB: string;
  winner?: string;
  scoreA?: number;
  scoreB?: number;
  verdict?: string;
  rawJson?: string;
}

export interface SelfBenchResultRow {
  id: string;
  workspace_id: string;
  experiment_id: string;
  config_a: string;
  config_b: string;
  winner: string | null;
  score_a: number | null;
  score_b: number | null;
  verdict: string | null;
  raw_json: string | null;
  created_at: string;
}

export class SelfBenchResultsStore {
  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
  ) {}

  /** Persist a completed experiment result. */
  async save(result: SelfBenchResult): Promise<string> {
    const id = randomUUID();
    await this.db
      .from('self_bench_results')
      .insert({
        id,
        workspace_id: this.workspaceId,
        experiment_id: result.experimentId,
        config_a: result.configA,
        config_b: result.configB,
        winner: result.winner ?? null,
        score_a: result.scoreA ?? null,
        score_b: result.scoreB ?? null,
        verdict: result.verdict ?? null,
        raw_json: result.rawJson ?? null,
      });
    logger.debug(\`[SelfBenchResultsStore] saved result \${id} for experiment \${result.experimentId}\`);
    return id;
  }

  /** Retrieve the last N results for this workspace. */
  async getSelfBenchHistory(limit = 20): Promise<SelfBenchResultRow[]> {
    const { data, error } = await this.db
      .from('self_bench_results')
      .select('*')
      .eq('workspace_id', this.workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      logger.warn(\`[SelfBenchResultsStore] getSelfBenchHistory error: \${error}\`);
      return [];
    }
    return (data ?? []) as SelfBenchResultRow[];
  }

  /** Check whether a specific A/B pair was already tested recently (24h). */
  async wasRecentlyTested(configA: string, configB: string, windowHours = 24): Promise<boolean> {
    const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    const { count } = await this.db
      .from('self_bench_results')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', this.workspaceId)
      .eq('config_a', configA)
      .eq('config_b', configB)
      .gte('created_at', cutoff);
    return (count ?? 0) > 0;
  }
}

Do not modify any other files.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'src/db/migrations/151-self-bench-results.sql exists with CREATE TABLE self_bench_results',
      'src/self-bench/self-bench-results-store.ts exists with SelfBenchResultsStore class',
      'getSelfBenchHistory() method exists and queries the table',
      'wasRecentlyTested() method exists to avoid duplicate experiments',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 9 — Wire LLM executor into conductor production path (Phase 6)
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-llm-executor-production',
    title: 'Use IS_REAL_EXECUTOR_ENABLED flag in wireConductor to force real executor without modelRouter',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
CONTEXT: src/autonomy/wire-daemon.ts already exports:
  export const IS_REAL_EXECUTOR_ENABLED = process.env.OHWOW_REAL_EXECUTOR === 'true';

But this flag is NEVER READ in wireConductor(). The real LLM executor is only used
when opts.modelRouter is provided. So IS_REAL_EXECUTOR_ENABLED is exported but
does nothing.

YOUR TASK: In wireConductor() in src/autonomy/wire-daemon.ts, modify the
makeExecutor factory (currently at lines ~144-167) so that when
IS_REAL_EXECUTOR_ENABLED is true AND opts.modelRouter is NOT provided, it still
creates a real LlmPlanExecutor using a default Anthropic client.

Read src/autonomy/executors/llm-executor.ts to understand:
- What makeLlmPlanExecutor() needs: { model, client, fallback, meter }
- What type "client" is (look for LlmClient or similar interface)
- Whether there's a default/direct Anthropic client factory

Then in wire-daemon.ts, add a branch:
  if (IS_REAL_EXECUTOR_ENABLED && !opts.modelRouter) {
    // Create a minimal LlmPlanExecutor with a direct Anthropic client
    // for environments where modelRouter isn't available but operator
    // has explicitly opted into the real executor.
    const meter = newLlmMeter();
    const client = /* direct anthropic client from llm-executor.ts */;
    return makeLlmPlanExecutor({
      model: DEFAULT_LLM_MODEL,
      client,
      fallback: defaultMakeStubExecutor(),
      meter,
    });
  }

If the Anthropic client constructor requires an API key, read it from
process.env.ANTHROPIC_API_KEY with a fallback to empty string (the executor
will fail gracefully at runtime if the key is missing).

Only modify src/autonomy/wire-daemon.ts. No other files.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'IS_REAL_EXECUTOR_ENABLED is read in wireConductor(), not just exported',
      'When IS_REAL_EXECUTOR_ENABLED=true and modelRouter is absent, real executor is created',
      'No other files were changed',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 10 — Add list_agents REST endpoint to Express API
  // -------------------------------------------------------------------------
  {
    taskId: 'add-list-agents-rest-endpoint',
    title: 'Add GET /api/agents endpoint to Express API for agent workforce listing',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
The ohwow Express API at src/api/ likely has endpoints for tasks, workspace info,
and other data but may be missing a simple agent listing endpoint that clients
(ohwow.fun, mobile, A2A peers) can use.

Steps:
1. Run: grep -rn "router\\.get\|router\\.post\|app\\.get" src/api/ --include="*.ts" | head -30
   to map existing endpoints.
2. Check if GET /api/agents already exists (grep for 'agents' in src/api/routes/).
3. If missing, create src/api/routes/agents.ts with:
   - GET /api/agents — returns agent_workforce_agents rows for the active workspace,
     with fields: id, name, status, model, created_at, last_active_at, task_count
   - GET /api/agents/:id — returns a single agent's full config + recent task history
4. Use the DatabaseAdapter pattern from other route files (don't raw-SQL outside db/).
5. Add appropriate auth middleware (look at how other routes are protected).
6. Register the router in src/api/routes/index.ts or equivalent.

The response shape for GET /api/agents should be:
  { agents: AgentRow[], total: number, workspace: string }
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'GET /api/agents endpoint exists and returns agent list',
      'GET /api/agents/:id endpoint exists and returns single agent',
      'Routes are registered in the API router',
      'Auth middleware is applied',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 11 — ohwow.fun: wire market intel reading API route
  // -------------------------------------------------------------------------
  {
    taskId: 'add-ohwow-fun-intel-api-route',
    title: 'Add GET /api/intel/latest route to ohwow.fun to surface market intel in dashboard',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow.fun',
    validationCmd: 'npx tsc --noEmit 2>&1 | tail -20',
    description: `
WRITE THIS FILE EXACTLY. No exploration needed. Create the single file below.

Target: src/app/api/intel/latest/route.ts

Use write_file with this exact content:

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveWorkspaceFromRequest } from '@/lib/agents/resolve-workspace';
import { resolveDaemonTarget } from '@/lib/local-runtime/daemon-target';
import { logger } from '@/lib/logger';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface IntelBrief {
  id: string;
  bucket: string;
  headline: string;
  ohwow_implications: string;
  score: number;
}

export interface IntelLatestResponse {
  briefs: IntelBrief[];
  day: string | null;
  source: 'daemon' | 'local' | 'empty';
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const workspace = await resolveWorkspaceFromRequest(supabase, request, user.id);
  if (!workspace) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 401 });
  }

  const { workspaceId } = workspace;

  // Try proxying to the daemon first
  const target = await resolveDaemonTarget(supabase, workspaceId, user.id);
  if (target) {
    try {
      const proxyRes = await fetch(\`\${target.url}/api/intel/latest\`, {
        headers: { Authorization: target.authorization },
      });
      if (proxyRes.ok) {
        const data = (await proxyRes.json()) as IntelLatestResponse;
        return NextResponse.json({ ...data, source: 'daemon' as const });
      }
      logger.warn({ status: proxyRes.status }, 'intel/latest: daemon proxy failed, falling back to local read');
    } catch (err) {
      logger.warn({ err }, 'intel/latest: daemon proxy error, falling back to local read');
    }
  }

  // Fallback: read directly from disk (dev mode where dashboard and daemon share filesystem)
  try {
    const intelDir = join(homedir(), '.ohwow', 'workspaces', 'default', 'intel');
    if (!existsSync(intelDir)) {
      return NextResponse.json({ briefs: [], day: null, source: 'empty' } satisfies IntelLatestResponse);
    }

    const days = readdirSync(intelDir)
      .filter(d => /^\\d{4}-\\d{2}-\\d{2}$/.test(d))
      .sort()
      .reverse();

    if (days.length === 0) {
      return NextResponse.json({ briefs: [], day: null, source: 'empty' } satisfies IntelLatestResponse);
    }

    const latestDay = days[0];
    const briefsPath = join(intelDir, latestDay, 'briefs.json');

    if (!existsSync(briefsPath)) {
      return NextResponse.json({ briefs: [], day: latestDay, source: 'empty' } satisfies IntelLatestResponse);
    }

    const briefs = JSON.parse(readFileSync(briefsPath, 'utf8')) as IntelBrief[];
    return NextResponse.json({ briefs, day: latestDay, source: 'local' } satisfies IntelLatestResponse);
  } catch (err) {
    logger.warn({ err }, 'intel/latest: local read failed');
    return NextResponse.json({ briefs: [], day: null, source: 'empty' } satisfies IntelLatestResponse);
  }
}

After writing the file, run: npx tsc --noEmit 2>&1 | tail -20
Fix any TypeScript errors. The most common issue is the satisfies operator needing TypeScript 4.9+
(if it errors, replace "satisfies IntelLatestResponse" with just the object literal without satisfies).
Do NOT modify any other files.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npx tsc --noEmit)',
      'src/app/api/intel/latest/route.ts exists with a GET handler',
      'Handler tries daemon proxy first via resolveDaemonTarget, then falls back to local disk read',
      'Response shape is { briefs: IntelBrief[], day: string | null, source: string }',
      'Proper error handling if intel directory or briefs.json is missing',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 12 — Replace hardcoded model in ohwow.fun fix-generator
  // -------------------------------------------------------------------------
  {
    taskId: 'fix-hardcoded-models-ohwow-fun',
    title: 'Replace hardcoded Claude model strings in ohwow.fun with config-driven selection',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow.fun',
    validationCmd: 'npx tsc --noEmit 2>&1 | tail -20',
    description: `
Two files in ohwow.fun hardcode specific Claude model strings that should use the
existing config-driven model selection pattern instead:

1. src/lib/autofix/fix-generator.ts line 57:
   model: 'claude-sonnet-4-20250514'
   This is inside callAnthropic() which makes a raw fetch to the Anthropic API.
   Replace with a constant imported from a shared location (or inline constant
   AUTOFIX_MODEL = process.env.AUTOFIX_MODEL || 'claude-sonnet-4-5' at the top of the file).

2. src/lib/agents/co-evolution/model-tier.ts line 34:
   if (progress < 0.8) return 'claude-sonnet-4-20250514';
   This is the mid-refinement tier in getEvolutionModelTier(). Replace with a
   named constant CO_EVOLUTION_MID_TIER_MODEL = 'claude-sonnet-4-5' at the top
   of that file (the function already uses 'claude-haiku-4-20250414' which is
   similarly hardcoded — leave haiku as-is since that one is intentional breadth
   model selection; only fix the sonnet reference on line 34).

The goal is to make these model strings obvious and easy to update centrally.
Use env-variable fallback pattern: process.env.X || 'model-string' is acceptable.
Do NOT change the existing getSiteBuilderModel() infrastructure — it's already correct.
    `,
    acceptanceCriteria: [
      'No hardcoded "claude-sonnet-4-20250514" strings remain in src/',
      'TypeScript typecheck passes (npx tsc --noEmit)',
      'Model references use a named constant or env-variable fallback',
    ],
  },
];
