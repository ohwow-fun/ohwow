/**
 * TUI Root Component
 * First-run: shows experience choice (terminal vs web), then onboarding.
 * Returning users: abbreviated flow or skip to dashboard.
 * Initializes DB early to check workspace/agent state for smart routing.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { join } from 'path';
import { homedir } from 'os';
import { tryLoadConfig, isFirstRun, DEFAULT_PORT } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { initDatabase } from '../db/init.js';
import { createSqliteAdapter } from '../db/sqlite-adapter.js';
import { createRpcHandlers } from '../db/rpc-handlers.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type Database from 'better-sqlite3';
import { OnboardingWizard } from './screens/onboarding-wizard.js';
import type { ExistingWorkspaceState } from './screens/onboarding-wizard.js';
import { Dashboard } from './screens/dashboard.js';
import { ExperienceChoiceStep } from './screens/onboarding/ExperienceChoiceStep.js';
import { WebOnboardingWaiter } from './screens/onboarding/WebOnboardingWaiter.js';
import { startOnboardingServer, type OnboardingServerHandle } from '../api/onboarding-server.js';
import { openPath } from '../lib/platform-utils.js';

type AppView = 'experience_choice' | 'onboarding' | 'web_onboarding' | 'dashboard';

interface DbState {
  rawDb: Database.Database;
  db: DatabaseAdapter;
}

/** Check if the workspace has business data and agents in the DB. */
function checkDbOnboardingState(rawDb: Database.Database): { hasBusinessData: boolean; hasAgents: boolean } {
  let hasBusinessData = false;
  let hasAgents = false;
  let workspaceId: string | null = null;

  // Each workspace DB holds exactly one row in agent_workforce_workspaces:
  // the id starts as 'local' (seeded in migration 018) and gets rewritten
  // to the cloud workspace UUID by the daemon's consolidation step at boot
  // when a license key is configured. Read it positionally instead of
  // hardcoding 'local' so cloud-connected workspaces aren't reported as
  // empty post-consolidation.
  try {
    const row = rawDb.prepare(
      'SELECT id, business_name FROM agent_workforce_workspaces LIMIT 1'
    ).get() as { id: string; business_name: string } | undefined;
    if (row?.business_name) {
      hasBusinessData = true;
      workspaceId = row.id;
    } else if (row?.id) {
      workspaceId = row.id;
    }
  } catch {
    // Table may not exist yet
  }

  if (workspaceId) {
    try {
      const row = rawDb.prepare(
        'SELECT COUNT(*) as n FROM agent_workforce_agents WHERE workspace_id = ?'
      ).get(workspaceId) as { n: number } | undefined;
      hasAgents = (row?.n ?? 0) > 0;
    } catch {
      // Table may not exist yet
    }
  }

  return { hasBusinessData, hasAgents };
}

/**
 * Load existing workspace state for returning users.
 * Returns null if this is a first-run (no business data or agents).
 */
function loadExistingState(rawDb: Database.Database, config: RuntimeConfig | null): ExistingWorkspaceState | undefined {
  const { hasBusinessData, hasAgents } = checkDbOnboardingState(rawDb);
  if (!hasBusinessData || !hasAgents) return undefined;

  try {
    // Workspace info — the table is per-DB-singleton, so LIMIT 1 picks up
    // whatever id consolidation rewrote it to (cloud UUID or 'local').
    const workspace = rawDb.prepare(
      'SELECT id, business_name, business_type FROM agent_workforce_workspaces LIMIT 1'
    ).get() as { id: string; business_name: string; business_type: string } | undefined;
    if (!workspace?.business_name) return undefined;

    // Agent list with status and stats — scope by the resolved workspace id
    const agents = rawDb.prepare(
      'SELECT name, role, status, stats FROM agent_workforce_agents WHERE workspace_id = ?'
    ).all(workspace.id) as Array<{ name: string; role: string; status: string; stats: string }>;

    // Task count — same scope
    const taskRow = rawDb.prepare(
      'SELECT COUNT(*) as n FROM agent_workforce_tasks WHERE workspace_id = ?'
    ).get(workspace.id) as { n: number } | undefined;

    // Model info from config
    const modelTag = config?.ollamaModel || null;
    const modelName = modelTag; // Use the tag as display name

    // Aggregate stats from agents
    let totalCostCents = 0;
    let totalTokens = 0;
    let totalRequests = 0;

    const agentHealth = agents.map(a => {
      let stats = { total_tasks: 0, cost_cents: 0, tokens_used: 0 };
      try {
        stats = { ...stats, ...JSON.parse(a.stats || '{}') };
      } catch { /* ignore */ }
      totalCostCents += stats.cost_cents || 0;
      totalTokens += stats.tokens_used || 0;
      totalRequests += stats.total_tasks || 0;

      return {
        name: a.name,
        role: a.role,
        status: (a.status === 'idle' || a.status === 'working' || a.status === 'error' ? a.status : 'idle') as 'idle' | 'working' | 'error',
        taskCount: stats.total_tasks || 0,
        costCents: stats.cost_cents || 0,
      };
    });

    return {
      businessName: workspace.business_name,
      businessType: workspace.business_type || 'saas_startup',
      modelName,
      modelTag,
      agents: agentHealth,
      totalTasks: taskRow?.n ?? 0,
      totalCostCents,
      totalTokens,
      totalRequests,
    };
  } catch {
    return undefined;
  }
}

export function App() {
  // Initialize DB once (synchronous via better-sqlite3)
  const dbState = useMemo<DbState>(() => {
    const config = tryLoadConfig();
    const dbPath = config?.dbPath ?? join(homedir(), '.ohwow', 'data', 'runtime.db');
    const rawDb = initDatabase(dbPath);
    const rpcHandlers = createRpcHandlers(rawDb);
    const db = createSqliteAdapter(rawDb, { rpcHandlers });
    return { rawDb, db };
  }, []);

  const [config, setConfig] = useState<RuntimeConfig | null>(() => {
    const loaded = tryLoadConfig();
    if (!loaded) return null;
    return loaded;
  });

  // Load existing workspace state for returning users
  const existingState = useMemo(() => {
    if (isFirstRun()) return undefined;
    return loadExistingState(dbState.rawDb, config);
  }, [dbState.rawDb, config]);

  // Determine initial view: returning users with a ready model skip straight to dashboard
  const [initialCheck, setInitialCheck] = useState<'checking' | 'ready' | 'needs_model'>(() => {
    if (!existingState) return 'needs_model'; // First run, go to onboarding
    return 'checking'; // Returning user, need to check model availability
  });

  const firstRun = !existingState;

  const [view, setView] = useState<AppView>(() => {
    if (firstRun) return 'experience_choice'; // First run: show choice gate
    return 'onboarding'; // Returning: will be overridden by model check
  });

  // Experience choice state
  const [choiceIndex, setChoiceIndex] = useState(0);

  // Web onboarding server handle
  const [webServer, setWebServer] = useState<OnboardingServerHandle | null>(null);

  // For returning users, check if the model is available and skip onboarding
  useEffect(() => {
    if (initialCheck !== 'checking' || !config || !existingState) return;
    let cancelled = false;

    (async () => {
      try {
        if (config.modelSource === 'cloud') {
          if (config.anthropicApiKey || config.anthropicOAuthToken) {
            if (!cancelled) { setInitialCheck('ready'); setView('dashboard'); }
            return;
          }
        } else {
          const res = await fetch(`${config.ollamaUrl}/api/tags`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            const data = await res.json() as { models?: Array<{ name: string }> };
            const modelBase = (config.orchestratorModel || config.ollamaModel).split(':')[0];
            const hasModel = (data.models || []).some((m: { name: string }) => m.name.startsWith(modelBase));
            if (hasModel) {
              if (!cancelled) { setInitialCheck('ready'); setView('dashboard'); }
              return;
            }
          }
        }
      } catch {
        // Probe failed, show onboarding
      }
      if (!cancelled) { setInitialCheck('needs_model'); setView('onboarding'); }
    })();

    return () => { cancelled = true; };
  }, [initialCheck, config, existingState]);

  // Track whether the user just completed onboarding this session (for welcome flow)
  const [justOnboarded, setJustOnboarded] = useState(false);

  // Track whether dashboard should show the nudge banner
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean>(() => {
    if (!config) return true;
    const { hasBusinessData, hasAgents } = checkDbOnboardingState(dbState.rawDb);
    return !hasBusinessData || !hasAgents;
  });

  const handleOnboardingComplete = (newConfig: RuntimeConfig) => {
    // Shut down the onboarding server if it was running
    if (webServer) {
      webServer.shutdown();
      setWebServer(null);
    }
    setConfig(newConfig);
    setNeedsOnboarding(false);
    setJustOnboarded(true);
    setView('dashboard');
  };

  const handleSkip = () => {
    const loaded = tryLoadConfig();
    if (loaded) {
      setConfig(loaded);
    }
    setNeedsOnboarding(!existingState);
    setView('dashboard');
  };

  const handleStartOnboarding = () => {
    setView('onboarding');
  };

  // Handle experience choice: start web onboarding server and open browser
  const handleChooseWeb = useCallback(async () => {
    const port = config?.port || DEFAULT_PORT;
    try {
      const handle = await startOnboardingServer(dbState.db, dbState.rawDb, port);
      setWebServer(handle);
      setView('web_onboarding');
      // Open the browser
      const url = `http://localhost:${port}/ui/onboarding`;
      try { openPath(url); } catch {
        // Browser didn't open automatically; URL is shown in the waiter
      }
    } catch {
      // Port in use or other error; fall back to terminal onboarding
      setView('onboarding');
    }
  }, [config, dbState.db, dbState.rawDb]);

  const handleWebOnboardingComplete = useCallback(() => {
    // Reload config that was saved by the web onboarding
    const loaded = tryLoadConfig();
    if (loaded) {
      handleOnboardingComplete(loaded);
    } else {
      // Config wasn't saved yet; keep waiting or fall back
      setView('onboarding');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleWebOnboardingCancel = useCallback(() => {
    if (webServer) {
      webServer.shutdown();
      setWebServer(null);
    }
    setView('onboarding');
  }, [webServer]);

  // Cleanup web server on unmount
  useEffect(() => {
    return () => { webServer?.shutdown(); };
  }, [webServer]);

  // Show brief loading while checking model availability for returning users
  if (initialCheck === 'checking') {
    return (
      <Box padding={1}>
        <Text color="gray">Checking model availability...</Text>
      </Box>
    );
  }

  // Experience choice gate (first-run only)
  if (view === 'experience_choice') {
    return (
      <ExperienceChoice
        choiceIndex={choiceIndex}
        onChangeIndex={setChoiceIndex}
        onChooseTerminal={() => setView('onboarding')}
        onChooseWeb={handleChooseWeb}
        onSkip={handleSkip}
      />
    );
  }

  // Web onboarding waiter
  if (view === 'web_onboarding' && webServer) {
    return (
      <WebOnboardingWaiter
        port={webServer.port}
        sessionToken={webServer.sessionToken}
        onComplete={handleWebOnboardingComplete}
        onCancel={handleWebOnboardingCancel}
      />
    );
  }

  if (view === 'onboarding') {
    return (
      <OnboardingWizard
        db={dbState.db}
        onComplete={handleOnboardingComplete}
        onSkip={handleSkip}
        existingState={existingState}
      />
    );
  }

  if (!config) {
    return (
      <OnboardingWizard
        db={dbState.db}
        onComplete={handleOnboardingComplete}
        onSkip={handleSkip}
        existingState={existingState}
      />
    );
  }

  return (
    <Dashboard
      config={config}
      db={dbState.db}
      rawDb={dbState.rawDb}
      needsOnboarding={needsOnboarding}
      justOnboarded={justOnboarded}
      onStartOnboarding={handleStartOnboarding}
      onConfigChange={setConfig}
    />
  );
}

/** Wrapper for ExperienceChoiceStep that handles keyboard input */
function ExperienceChoice({
  choiceIndex,
  onChangeIndex,
  onChooseTerminal,
  onChooseWeb,
  onSkip,
}: {
  choiceIndex: number;
  onChangeIndex: (i: number) => void;
  onChooseTerminal: () => void;
  onChooseWeb: () => void;
  onSkip: () => void;
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      onChangeIndex(0);
    } else if (key.downArrow) {
      onChangeIndex(1);
    } else if (key.return) {
      if (choiceIndex === 0) onChooseTerminal();
      else onChooseWeb();
    } else if (input === '1') {
      onChooseTerminal();
    } else if (input === '2') {
      onChooseWeb();
    } else if (input === 's') {
      onSkip();
    }
  });

  return <ExperienceChoiceStep selectedIndex={choiceIndex} />;
}
