/**
 * Seed task definitions for the self-evolution system.
 * High-priority product tasks — real feature work, not trivial additions.
 */

export const SEED_TASKS = [
  // -------------------------------------------------------------------------
  // BATCH 1 — Wire the LLM executor into production (Phase 6/7)
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-llm-executor-production',
    title: 'Wire real LLM executor into conductor production path (Phase 6)',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
The autonomy conductor at src/autonomy/conductor.ts has a StubConductorExecutor
(lines 67-116) that returns no-op rounds. The real LLM executor already exists
at src/autonomy/executors/llm-executor.ts and is wired into the eval harness but
"never wired into production today" (its own comment says so).

src/autonomy/wire-daemon.ts (lines 127-148) uses defaultMakeStubExecutor() as
fallback for impl + qa rounds while only wiring the LLM executor for PLAN rounds
via dark-launch config.

Your task: update wire-daemon.ts to use the LlmPlanExecutor for ALL three round
kinds (plan, impl, qa) when the OHWOW_REAL_EXECUTOR=true env var is set, instead
of only using it for plan. Specifically:

1. Read src/autonomy/wire-daemon.ts and find the section around line 127 where
   the stub is used for impl + qa.
2. Read src/autonomy/executors/llm-executor.ts to understand makeLlmPlanExecutor
   and how it delegates to a fallback executor for non-plan rounds.
3. In wire-daemon.ts, add a check: if process.env.OHWOW_REAL_EXECUTOR === 'true',
   wire ALL round kinds through the LLM executor (not just plan). The LlmPlanExecutor
   already handles plan; for impl and qa, you need to call the executor factory
   with kind='impl' and kind='qa' as well — check if it supports that or falls back.
4. Export a new boolean constant IS_REAL_EXECUTOR_ENABLED from wire-daemon.ts
   so callers can check if the real executor is active.

This is the critical Phase 6 connection that makes the conductor actually do
real AI work rather than returning stub no-ops.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'wire-daemon.ts reads OHWOW_REAL_EXECUTOR env var',
      'IS_REAL_EXECUTOR_ENABLED boolean is exported from wire-daemon.ts',
      'When OHWOW_REAL_EXECUTOR=true, all round kinds route through LLM executor',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 2 — Wire channel message storage for inner-thoughts unreadMessages
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
  // BATCH 3 — Wire onboarding integration presets from agent selections
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
  // BATCH 4 — Add real contacts/CRM search to the orchestrator tool catalog
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
  // BATCH 5 — Wire market intel buyer_intent → outreach pipeline
  // -------------------------------------------------------------------------
  {
    taskId: 'wire-market-intel-outreach-trigger',
    title: 'Wire buyer_intent market intel signals into the outreach trigger pipeline',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
The market intel system at scripts/intel/market-intel.mjs generates briefs with
bucket=buyer_intent. These briefs exist in ~/.ohwow/workspaces/default/intel/ but
nothing reads them to trigger follow-up actions.

Your task: create a new scheduler module that reads buyer_intent briefs from the
intel directory and enqueues outreach tasks for the configured workspace.

Steps:
1. Read src/scheduling/ to understand existing scheduler patterns (e.g.,
   approved-draft-queue.ts, synthesis-auto-learner.ts).
2. Read the intel brief format by checking scripts/intel/market-intel.mjs for
   how briefs.json is structured.
3. Create src/scheduling/intel-outreach-trigger.ts that:
   - Exports class IntelOutreachTrigger with a tick() method
   - On each tick, reads the latest intel day's briefs.json
   - Filters for bucket=buyer_intent items not yet processed
   - For each unprocessed signal, creates a task in the agent_workforce_tasks
     table with a prompt like "Follow up on buyer intent signal: {headline}"
   - Tracks processed signals in a seen-file at the intel day directory
4. Export the class and wire it into the daemon startup in src/daemon/start.ts
   (find where other schedulers are initialized and follow that pattern).

The seen-file should use the existing loadSeen/appendSeen pattern if it exists
in src/lib/, otherwise implement a simple JSON array in the intel dir.
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'src/scheduling/intel-outreach-trigger.ts exists with IntelOutreachTrigger class',
      'tick() method reads briefs.json and creates tasks for buyer_intent signals',
      'Processed signals are tracked to avoid duplicate task creation',
    ],
  },

  // -------------------------------------------------------------------------
  // BATCH 6 — A2A agent card endpoint (Google A2A spec compliance)
  // -------------------------------------------------------------------------
  {
    taskId: 'implement-a2a-agent-card-endpoint',
    title: 'Implement /.well-known/agent.json A2A agent card endpoint in Express API',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -30',
    description: `
Google's Agent-to-Agent (A2A) protocol requires agents to expose a
/.well-known/agent.json endpoint with capability metadata. The ohwow runtime
has an A2A module at src/a2a/ but check if this endpoint exists in the API.

Steps:
1. Run: grep -rn "well-known\|agent.json\|agentCard" src/api/ src/a2a/ | head -20
   to check if it already exists.
2. Read src/api/routes/ to understand Express route registration patterns.
3. Read src/a2a/ to understand the AgentCard interface shape (likely from the
   Google A2A spec: name, description, url, version, capabilities, skills).
4. If the endpoint doesn't exist, create src/api/routes/a2a-agent-card.ts that:
   - Handles GET /.well-known/agent.json
   - Returns a JSON body with: name, description, url, version, capabilities
     (streaming: false, pushNotifications: false, stateTransitionHistory: false)
   - Reads the workspace name and configured base URL from config
   - Sets Content-Type: application/json
5. Register the route in src/api/routes/index.ts or the main router file.

If the endpoint already exists, instead extend it: add a skills[] array that
lists the configured agents from the workspace as A2A skills with id, name,
description, and inputModes: ['text'].
    `,
    acceptanceCriteria: [
      'TypeScript typecheck passes (npm run typecheck)',
      'GET /.well-known/agent.json route exists in Express API',
      'Response includes name, description, url, version, capabilities fields',
      'Route is registered in the main API router',
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
  // BATCH 9 — Add list_agents REST endpoint to Express API
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
  // BATCH 10 — Fix hardcoded model strings across seed templates
  // -------------------------------------------------------------------------
  {
    taskId: 'fix-seed-templates-hardcoded-model',
    title: 'Replace hardcoded claude-sonnet-4-20250514 in seed-templates.ts with a named constant',
    targetRepo: '/Users/jesus/Documents/ohwow/ohwow',
    validationCmd: 'npm run typecheck 2>&1 | tail -20',
    description: `
src/lib/seed-templates.ts contains 12+ inline occurrences of the string
'claude-sonnet-4-20250514' embedded directly inside agent config objects.
This is a maintenance burden — updating the default seed model requires
a search-and-replace across the whole file.

Fix: at the top of the file (after the existing JSDoc comment) add:

  /** Default LLM model used by seed-template agents. Override via SEED_TEMPLATE_MODEL env var. */
  const SEED_AGENT_MODEL = process.env.SEED_TEMPLATE_MODEL ?? 'claude-sonnet-4-5';

Then replace every occurrence of 'claude-sonnet-4-20250514' in that file
with the constant SEED_AGENT_MODEL. There are occurrences on lines ~24, 40,
56, 72, 88, 104, 120, 136, 152, 168, 188, 189, 209 (check the file for the
exact count — do not leave any behind).

Do NOT touch any other file. Do NOT change the shape of the exported
SEED_TEMPLATES array. Do NOT modify package.json.
    `,
    acceptanceCriteria: [
      'No string literal "claude-sonnet-4-20250514" remains in src/lib/seed-templates.ts',
      'SEED_AGENT_MODEL constant is defined at the top of the file',
      'TypeScript typecheck passes (npm run typecheck)',
      'No other files were changed',
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
