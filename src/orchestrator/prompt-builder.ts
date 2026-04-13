/**
 * Prompt building for the local orchestrator.
 * Assembles system prompt from parallel DB queries filtered by intent sections.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { IntentSection } from './tool-definitions.js';
import { buildStaticInstructionsForIntent, buildCompactStaticInstructionsForIntent, buildMicroStaticInstructions, buildDynamicContext, buildCompactDynamicContext, buildMicroDynamicContext, buildOnboardingAddendum, type BuildLocalSystemPromptArgs } from './system-prompt.js';
import { MODEL_CATALOG } from '../lib/ollama-models.js';
import type { ChannelType } from '../integrations/channel-types.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import { retrieveRelevantMemories, retrieveKnowledgeChunks, formatRelevantMemories, formatRagChunks } from '../lib/rag/retrieval.js';
import { loadOrchestratorMemory } from './session-store.js';
import { logger } from '../lib/logger.js';
import { getGitContext, isStaleBranch } from '../lib/git-utils.js';
import { detectProjectStack } from '../lib/project-detector.js';
// NOTE: extractKeywords/matchesTriggers removed — see the banner
// comment later in this file. Skill discovery is no longer
// keyword-based; the LLM picks tools from its tool list surfaced
// via runtimeToolRegistry through LocalOrchestrator.getTools().

export interface PromptBuilderDeps {
  db: DatabaseAdapter;
  workspaceId: string;
  orchestratorModel: string;
  anthropicApiKey: string;
  workingDirectory: string;
  channels: ChannelRegistry;
  hasOrchestratorFileAccess: () => Promise<boolean>;
}

export async function buildTargetedPrompt(
  deps: PromptBuilderDeps,
  userMessage: string | undefined,
  sections: Set<IntentSection>,
  browserPreActivated?: boolean,
  platform?: ChannelType,
  desktopPreActivated?: boolean,
  compact?: boolean | 'micro',
  desktopDisplayLayout?: string,
  hasMcpTools?: boolean,
): Promise<{ staticPart: string; dynamicPart: string }> {
  const need = (s: IntentSection) => sections.has(s);

  type AgentRow = { id: string; name: string; role: string; paused: number | boolean; status: string; stats?: unknown };
  type ProjectRow = { id: string; name: string; status: string };

  const agentsPromise = need('agents')
    ? deps.db.from('agent_workforce_agents').select('id, name, role, paused, status, stats')
        .eq('workspace_id', deps.workspaceId).eq('paused', 0).order('name')
    : Promise.resolve({ data: null });

  const projectsPromise = need('projects')
    ? deps.db.from('agent_workforce_projects').select('id, name, status')
        .eq('workspace_id', deps.workspaceId).eq('status', 'active')
    : Promise.resolve({ data: null });

  const businessPromise = need('business')
    ? deps.db.from('agent_workforce_workspaces')
        .select('business_name, business_type, business_description, growth_stage, team_size, monthly_revenue_cents, growth_goals, founder_focus')
        .eq('id', deps.workspaceId).single()
    : Promise.resolve({ data: null });

  const visionPromise = need('vision')
    ? deps.db.from('runtime_settings').select('value').eq('key', 'ocr_model').maybeSingle()
    : Promise.resolve({ data: null });

  const a2aPromise = need('agents')
    ? deps.db.from('a2a_connections').select('name, agent_card_cache')
        .eq('workspace_id', deps.workspaceId).eq('status', 'active')
    : Promise.resolve({ data: null });

  let pulsePromise: Promise<{
    tasksToday: number; tasksYesterday: number;
    totalLeads: number; totalCustomers: number;
    totalContacts: number; recentContactEvents: number;
    pendingApprovals: number;
  } | null>;

  if (need('pulse')) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    pulsePromise = Promise.all([
      deps.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).in('status', ['completed', 'approved'])
        .gte('completed_at', todayStart.toISOString()),
      deps.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).in('status', ['completed', 'approved'])
        .gte('completed_at', yesterdayStart.toISOString())
        .lt('completed_at', todayStart.toISOString()),
      deps.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).eq('contact_type', 'lead').eq('status', 'active'),
      deps.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).eq('contact_type', 'customer').eq('status', 'active'),
      deps.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).eq('status', 'active'),
      deps.db.from('agent_workforce_contact_events').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).gte('created_at', sevenDaysAgo.toISOString()),
      deps.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).eq('status', 'needs_approval'),
    ]).then(([t, y, l, c, tc, ce, pa]) => ({
      tasksToday: t.count || 0,
      tasksYesterday: y.count || 0,
      totalLeads: l.count || 0,
      totalCustomers: c.count || 0,
      totalContacts: tc.count || 0,
      recentContactEvents: ce.count || 0,
      pendingApprovals: pa.count || 0,
    }));
  } else {
    pulsePromise = (async () => {
      const { count } = await deps.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
        .eq('workspace_id', deps.workspaceId).eq('status', 'needs_approval');
      return {
        tasksToday: 0, tasksYesterday: 0, totalLeads: 0,
        totalCustomers: 0, totalContacts: 0, recentContactEvents: 0,
        pendingApprovals: count || 0,
      };
    })();
  }

  // --- Learned principles and discovered processes from self-improvement ---
  type PrincipleRow = { id: string; rule: string; category: string };
  type ProcessRow = { id: string; name: string; description: string | null; steps: string; status: string; frequency: number; trigger_message: string | null };

  const principlesPromise = deps.db.from('agent_workforce_principles')
    .select('id, rule, category')
    .eq('workspace_id', deps.workspaceId).eq('is_active', 1)
    .order('utility_score', { ascending: false }).limit(5);

  // Skills are NO LONGER fetched here for prompt-injection purposes.
  // They reach the LLM through the runtime tool registry, surfaced by
  // LocalOrchestrator.getTools() as regular tools the model picks by
  // description. The old "Learned Procedures" section (keyword-
  // matched, pattern-mined procedure rows) is gone — see the plan at
  // /Users/jesus/.claude/plans/idempotent-tumbling-flame.md.

  const processesPromise = deps.db.from('agent_workforce_discovered_processes')
    .select('id, name, description, steps, status, frequency, trigger_message')
    .eq('workspace_id', deps.workspaceId)
    .in('status', ['confirmed', 'automated'])
    .order('frequency', { ascending: false }).limit(5);

  const memoryRagPromise: Promise<{ memory?: string; rag?: string }> = (async () => {
    if (!need('memory') && !need('rag')) return {};

    if (userMessage?.trim()) {
      const promises: [Promise<unknown>, Promise<unknown>] = [
        need('memory')
          ? retrieveRelevantMemories({ db: deps.db, workspaceId: deps.workspaceId, query: userMessage, limit: 10 })
          : Promise.resolve(null),
        need('rag')
          ? retrieveKnowledgeChunks({ db: deps.db, workspaceId: deps.workspaceId, agentId: '__orchestrator__', query: userMessage, tokenBudget: 4000, maxChunks: 6 })
          : Promise.resolve(null),
      ];
      const [memories, chunks] = await Promise.all(promises);
      return {
        memory: memories ? formatRelevantMemories(memories as Awaited<ReturnType<typeof retrieveRelevantMemories>>) : undefined,
        rag: chunks ? formatRagChunks(chunks as Awaited<ReturnType<typeof retrieveKnowledgeChunks>>) : undefined,
      };
    }

    if (need('memory')) {
      return { memory: await loadOrchestratorMemory({ db: deps.db, workspaceId: deps.workspaceId }) };
    }
    return {};
  })();

  const [agentsResult, projectsResult, businessResult, visionResult, a2aResult, pulseResult, memoryRag, principlesResult, processesResult] =
    await Promise.all([agentsPromise, projectsPromise, businessPromise, visionPromise, a2aPromise, pulsePromise, memoryRagPromise, principlesPromise, processesPromise]);

  const agents = ((agentsResult.data || []) as AgentRow[]).map((a) => {
    const raw = typeof a.stats === 'string' ? JSON.parse(a.stats as string) : (a.stats || {}) as Record<string, unknown>;
    const total = (raw.total_tasks || 0) as number;
    const completed = (raw.completed_tasks || 0) as number;
    return {
      id: a.id, name: a.name, role: a.role, status: a.status,
      stats: total > 0 ? {
        successRate: Math.round((completed / total) * 100),
        avgDuration: (raw.avg_duration_seconds || 0) as number,
        totalTasks: total,
      } : undefined,
    };
  });

  const projects = ((projectsResult.data || []) as ProjectRow[]).map((p) => ({ ...p, taskCount: 0 }));

  const ws = businessResult.data as Record<string, unknown> | null;
  const business = ws ? {
    name: (ws.business_name as string) || 'My Business',
    type: (ws.business_type as string) || 'enterprise',
    description: ws.business_description as string | undefined,
    growthStage: ws.growth_stage as number | undefined,
    teamSize: ws.team_size as number | undefined,
    monthlyRevenueCents: ws.monthly_revenue_cents as number | undefined,
    growthGoals: ws.growth_goals as string[] | undefined,
    founderFocus: ws.founder_focus as string | undefined,
  } : { name: 'My Business', type: 'enterprise' };

  const a2aConnections = ((a2aResult.data || []) as Array<Record<string, unknown>>).map((c) => {
    const cache = typeof c.agent_card_cache === 'string' ? JSON.parse(c.agent_card_cache) : c.agent_card_cache;
    return { name: c.name as string, skills: cache?.skills?.map((s: { name: string }) => s.name) || [] };
  });

  const activeModelTag = deps.orchestratorModel || '';
  const catalogEntry = MODEL_CATALOG.find(m => m.tag === activeModelTag);
  const visionCapability = need('vision') ? {
    localModelName: catalogEntry?.label || activeModelTag || 'unknown',
    localModelHasVision: catalogEntry?.vision ?? false,
    ocrModelConfigured: !!visionResult.data,
    hasAnthropicApiKey: !!deps.anthropicApiKey,
  } : undefined;

  let projectInstructions: string | undefined;
  if (need('project_instructions') && deps.workingDirectory) {
    const parts: string[] = [];
    for (const name of ['CLAUDE.md', 'OHWOW.md']) {
      try { parts.push(readFileSync(join(deps.workingDirectory, name), 'utf-8')); } catch { /* not found */ }
    }
    if (parts.length > 0) projectInstructions = parts.join('\n\n---\n\n');
  }

  const hasFilesystemTools = need('filesystem')
    ? await deps.hasOrchestratorFileAccess()
    : false;

  const activeAgents = agents.filter((a) => a.status === 'working').length;

  // NOTE: the keyword-matched skill loader and the desktop-section
  // auto-activation loop used to live here. Both depended on
  // extractKeywords(userMessage) + matchesTriggers(skill.triggers),
  // which was the same over-matching mechanism the runAgent SOP
  // matcher used. They've been removed — full rationale in
  // /Users/jesus/.claude/plans/idempotent-tumbling-flame.md.
  //
  // Skills are now discovered exclusively via the LLM's tool list,
  // populated by runtimeToolRegistry through LocalOrchestrator.getTools().
  // The "Learned Procedures" section in system-prompt.ts was deleted
  // in lockstep; `learnedSkills` below is always an empty array and
  // serves only to keep the BuildLocalSystemPromptArgs interface
  // compatible until it's removed in a follow-up.

  const args: BuildLocalSystemPromptArgs = {
    agents: need('agents') ? agents : [],
    business: need('business') ? business : null,
    dashboardContext: {
      pendingApprovals: pulseResult?.pendingApprovals || 0,
      activeAgents,
    },
    businessPulse: need('pulse') && pulseResult ? {
      tasksCompletedToday: pulseResult.tasksToday,
      tasksCompletedYesterday: pulseResult.tasksYesterday,
      totalLeads: pulseResult.totalLeads,
      totalCustomers: pulseResult.totalCustomers,
      totalContacts: pulseResult.totalContacts,
      recentContactEvents: pulseResult.recentContactEvents,
    } : undefined,
    projects: need('projects') ? projects : undefined,
    a2aConnections: need('agents') ? a2aConnections : undefined,
    connectedChannels: need('channels') ? deps.channels.getConnectedTypes() : undefined,
    orchestratorMemory: memoryRag.memory,
    ragContext: memoryRag.rag,
    workingDirectory: need('filesystem') ? (deps.workingDirectory || undefined) : undefined,
    hasFilesystemTools: need('filesystem') ? hasFilesystemTools : false,
    projectInstructions,
    visionCapability,
    hasBrowserTools: need('browser'),
    browserPreActivated,
    hasDesktopTools: need('desktop'),
    desktopPreActivated,
    desktopDisplayLayout,
    hasMcpTools,
    platform,
    learnedPrinciples: (principlesResult.data || []) as PrincipleRow[],
    learnedSkills: [],
    knownWorkflows: (processesResult.data || []) as ProcessRow[],
    gitContext: (() => {
      if (!need('filesystem') || !deps.workingDirectory) return undefined;
      try {
        const gc = getGitContext(deps.workingDirectory);
        if (!gc) return undefined;
        const stale = isStaleBranch(deps.workingDirectory);
        return {
          branch: gc.branch,
          commitsBehindMain: gc.commitsBehindMain,
          uncommittedChanges: gc.uncommittedChanges,
          mainBranch: gc.mainBranch,
          isStale: stale?.isStale ?? false,
          staleBranchWarning: stale?.recommendation,
          recentCommits: gc.recentCommits,
        };
      } catch { return undefined; }
    })(),
    hasLspTools: need('filesystem') || need('dev'),
    hasMeetingTools: process.platform === 'darwin',
    projectStack: (() => {
      if (!need('dev') || !deps.workingDirectory) return undefined;
      try { return detectProjectStack(deps.workingDirectory) ?? undefined; }
      catch { return undefined; }
    })(),
  };

  // Fire-and-forget: increment times_applied for principles injected into the prompt
  const principleIds = ((principlesResult.data || []) as PrincipleRow[]).map(p => p.id);
  if (principleIds.length > 0) {
    (async () => {
      for (const id of principleIds) {
        try {
          const { data } = await deps.db.from('agent_workforce_principles')
            .select('times_applied').eq('id', id).single();
          if (data) {
            const current = (data as Record<string, unknown>).times_applied as number || 0;
            await deps.db.from('agent_workforce_principles')
              .update({ times_applied: current + 1 }).eq('id', id);
          }
        } catch { /* best-effort tracking */ }
      }
    })().catch(err => logger.debug({ err }, 'Failed to increment principle usage'));
  }

  // NOTE: the times_used incrementer used to live here and only ran
  // for skills injected into the system prompt via the old keyword
  // matcher. `learnedSkills` is always [] now, so there's nothing to
  // increment from this path. Code-skill usage is tracked in
  // `runtime-skill-metrics.ts` via success_count/fail_count on the
  // tool-executor dispatch path.

  let staticPart: string;
  let dynamicPart: string;

  if (compact === 'micro') {
    staticPart = buildMicroStaticInstructions();
    dynamicPart = buildMicroDynamicContext(args) + buildOnboardingAddendum(agents.length);
  } else if (compact) {
    staticPart = buildCompactStaticInstructionsForIntent(sections);
    dynamicPart = buildCompactDynamicContext(args) + buildOnboardingAddendum(agents.length);
  } else {
    staticPart = buildStaticInstructionsForIntent(sections);
    dynamicPart = buildDynamicContext(args) + buildOnboardingAddendum(agents.length);
  }

  // Team-member awareness safety net. When someone introduces themselves
  // in a fresh chat ("Hi, I'm Mario"), the orchestrator should check
  // whether they're a registered team_member with a guide agent and
  // activate that guide's persona on the session. The cloud chat route
  // already forwards personaAgentId directly when a cloud-authenticated
  // team member opens chat, so this rule is a fallback for cases where
  // the persona pre-activation path didn't fire (local TUI, channel
  // chat, or a first turn that skipped the cloud proxy).
  staticPart += `\n\n## Team member self-introduction

If the user introduces themselves with a name on the first turn of a new conversation, call list_team_members. If exactly one matches by name and has an assigned_guide_agent_id, call activate_guide_persona with that team_member_id BEFORE continuing the reply. From that point on the conversation runs as that member's Chief of Staff agent. If the match is ambiguous (multiple candidates) ask them to confirm their full name before activating. If there is no match, continue as the orchestrator without pressure — they may simply be a visitor.`;

  return { staticPart, dynamicPart };
}

export async function buildFullPrompt(
  deps: PromptBuilderDeps,
  userMessage?: string,
  compact?: boolean | 'micro',
): Promise<{ staticPart: string; dynamicPart: string }> {
  const allSections = new Set<IntentSection>([
    'pulse', 'agents', 'projects', 'business', 'memory', 'rag',
    'vision', 'filesystem', 'channels', 'browser', 'project_instructions',
  ]);
  return buildTargetedPrompt(deps, userMessage, allSections, undefined, undefined, undefined, compact);
}
