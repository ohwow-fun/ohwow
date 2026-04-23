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
src/presence/inner-thoughts.ts line 244 has:
  unreadMessages: [], // TODO: Wire when channel message storage is implemented

The conversation/channel message storage DOES exist in the codebase. Your job is
to find it and wire it in.

Steps:
1. Run: grep -rn "conversation\|channel.*message\|inbox" src --include="*.ts" | grep -v __tests__ | grep -v node_modules | head -30
   to find where messages are stored.
2. Run: grep -rn "unread\|read_at\|is_read" src --include="*.ts" | head -20
   to find how read/unread state is tracked.
3. Read inner-thoughts.ts in full to understand the ContextSnapshot interface
   and the gatherContext() method.
4. Add a real query to gatherContext() that fetches unread messages from the DB
   for the current workspace. Look at how pendingTasks is queried for the pattern.
5. The unreadMessages field in ContextSnapshot should be typed as an array with
   at minimum: { id: string; agentId: string; content: string; created_at: string }.
   Remove the empty array literal and return real data.

If the conversation tables don't exist or have no unread concept yet, add a
graceful fallback (try/catch that returns []) so the feature degrades safely.
The goal is to remove the TODO comment and make a real attempt to wire the data.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'The TODO comment on unreadMessages line is removed',
      'gatherContext() attempts a real DB query for unread messages',
      'Graceful fallback returns [] if the query fails',
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
src/web/src/hooks/useOnboarding.ts line 529 has:
  // TODO: In the future, derive integrations from selected agent presets

The agent presets already declare which integrations they need. For example,
agents that do social media posting need Twitter/X integration; agents that
read email need Gmail integration; etc.

Steps:
1. Read src/tui/data/agent-presets.ts to understand the AgentPreset interface
   and what integration/tool fields exist on each preset.
2. Read src/web/src/hooks/useOnboarding.ts around line 529 and the surrounding
   ~50 lines to understand the current onboarding state and what selectedAgents
   looks like.
3. Implement a pure function (can be in the same file or a new utils file):
     function deriveIntegrationsFromPresets(selectedAgents: string[]): string[]
   that maps agent preset IDs to the integrations they require. For example:
   - social/twitter agents → ['twitter']
   - email agents → ['gmail']
   - calendar agents → ['gcal']
   - github agents → ['github']
4. Replace the TODO comment with a real call to this function, using the
   currently selected agent IDs from the onboarding state.

The goal is that when a user picks "Social Media Manager" during onboarding,
the integration step automatically pre-selects Twitter/X instead of showing
an empty list.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'deriveIntegrationsFromPresets function exists and maps preset IDs to integration names',
      'The TODO comment is removed and replaced with a real call',
      'At least 3 agent categories are mapped to their required integrations',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 6 — Add real contacts/CRM search to the orchestrator tool catalog
  // -------------------------------------------------------------------------
  {
    taskId: 'add-crm-contact-search-tool',
    title: 'Add search_contacts tool to orchestrator MCP catalog for CRM agent access',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
The orchestrator MCP catalog at src/mcp/catalog.ts lists tools agents can use.
Currently agents have no way to search the contacts/CRM database directly.

Your task: add a search_contacts built-in tool that lets agents query the
contacts table by name, email, company, or tag.

Steps:
1. Read src/mcp/catalog.ts to understand the MCPToolDefinition interface and
   how existing tools are structured.
2. Read src/db/ to find the contacts table schema (look for contacts migration
   or CREATE TABLE contacts).
3. Add a new tool entry to the catalog:
   {
     id: 'search_contacts',
     name: 'Search Contacts',
     description: 'Search the CRM contacts database by name, email, company, or tag',
     category: 'crm',
     icon: 'Users',
     envVarsRequired: [],
     isBuiltIn: true,
     schema: { ... }  // query: string, limit?: number
   }
4. Add the corresponding tool handler in the built-in tool executor
   (find where other built-in tools are executed — grep for isBuiltIn or
   built-in in src/orchestrator/ or src/mcp/).
5. The handler should query the contacts table with a LIKE search on
   name, email, company columns and return matching rows as JSON.

If the contacts table doesn't exist, add a migration file in src/db/migrations/
following the existing pattern, and create the minimal schema.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'search_contacts appears in the MCP catalog with correct schema',
      'Built-in tool handler queries contacts table with LIKE search',
      'Tool is categorized as crm and marked isBuiltIn: true',
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
The self-bench system at src/self-bench/ runs experiments comparing model
configurations. Currently experiment results may only live in memory.

Steps:
1. Run: grep -rn "result\|experiment\|persist\|store\|save" src/self-bench/ --include="*.ts" | head -30
   to understand what exists.
2. Check if there's a self_bench_results or experiments table in src/db/migrations/.
3. If no table exists, create src/db/migrations/<next-number>-self-bench-results.ts
   with CREATE TABLE self_bench_results (
     id TEXT PRIMARY KEY,
     experiment_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     config_a TEXT NOT NULL,
     config_b TEXT NOT NULL,
     winner TEXT,
     score_a REAL,
     score_b REAL,
     verdict TEXT,
     raw_json TEXT
   );
4. In the self-bench runner (src/self-bench/self-commit.ts or similar),
   after an experiment completes, insert the result into self_bench_results.
5. Add a getSelfBenchHistory(limit) function that reads the last N results
   from the table, for use in prompts and reporting.

The goal: experiment results survive daemon restarts and can inform future
experiment design (avoid re-running the same comparison).
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'A self_bench_results table migration exists in src/db/migrations/',
      'Experiment results are inserted into the table after completion',
      'getSelfBenchHistory() function exists and queries the table',
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
The ohwow.fun dashboard has no way to display the market intel briefs that the
runtime generates. The briefs live in ~/.ohwow/workspaces/{slug}/intel/ on the
server running the daemon.

However, ohwow.fun talks to the runtime via the daemon REST API (port 7700).
Your task is to add a proxy route that reads intel from the daemon.

Steps:
1. Check if /api/intel exists: ls src/app/api/intel/ 2>/dev/null || echo "missing"
2. Look at how other API routes proxy to the daemon:
   grep -rn "7700\|daemon.*token\|DAEMON_URL" src/app/api/ --include="*.ts" | head -20
3. Create src/app/api/intel/latest/route.ts with a GET handler that:
   - Gets the workspace slug from the auth session
   - Reads the daemon token from the workspace config
   - Proxies GET to http://localhost:7700/api/intel/latest (or the daemon port)
   - Returns the briefs JSON to the client
4. If the daemon doesn't have an /api/intel route, instead read directly:
   - Find OHWOW_DATA_DIR or equivalent env var
   - Read ~/.ohwow/workspaces/{slug}/intel/{latest-day}/briefs.json
   - Return it as JSON
5. The response shape should be: { briefs: Brief[], day: string }
   where Brief has: { id, bucket, headline, ohwow_implications, score }

This enables the dashboard to show "Market Intel" as a live feed.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npx tsc --noEmit)',
      'src/app/api/intel/latest/route.ts exists with a GET handler',
      'Handler reads intel briefs and returns them as JSON',
      'Proper error handling if intel directory is missing',
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
