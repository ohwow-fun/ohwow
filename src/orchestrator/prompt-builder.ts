/**
 * Prompt building for the local orchestrator.
 * Assembles system prompt from parallel DB queries filtered by intent sections.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { IntentSection } from './tool-definitions.js';
import { buildStaticInstructionsForIntent, buildDynamicContext, type BuildLocalSystemPromptArgs } from './system-prompt.js';
import { MODEL_CATALOG } from '../lib/ollama-models.js';
import type { ChannelType } from '../integrations/channel-types.js';
import type { ChannelRegistry } from '../integrations/channel-registry.js';
import { retrieveRelevantMemories, retrieveKnowledgeChunks, formatRelevantMemories, formatRagChunks } from '../lib/rag/retrieval.js';
import { loadOrchestratorMemory } from './session-store.js';

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
): Promise<{ staticPart: string; dynamicPart: string }> {
  const need = (s: IntentSection) => sections.has(s);

  type AgentRow = { id: string; name: string; role: string; status: string; stats?: unknown };
  type ProjectRow = { id: string; name: string; status: string };

  const agentsPromise = need('agents')
    ? deps.db.from('agent_workforce_agents').select('id, name, role, status, stats')
        .eq('workspace_id', deps.workspaceId).order('name')
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

  const [agentsResult, projectsResult, businessResult, visionResult, a2aResult, pulseResult, memoryRag] =
    await Promise.all([agentsPromise, projectsPromise, businessPromise, visionPromise, a2aPromise, pulsePromise, memoryRagPromise]);

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
    ? !!(deps.workingDirectory || await deps.hasOrchestratorFileAccess())
    : false;

  const activeAgents = agents.filter((a) => a.status === 'working').length;

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
    platform,
  };

  return {
    staticPart: buildStaticInstructionsForIntent(sections),
    dynamicPart: buildDynamicContext(args),
  };
}

export async function buildFullPrompt(
  deps: PromptBuilderDeps,
  userMessage?: string,
): Promise<{ staticPart: string; dynamicPart: string }> {
  const allSections = new Set<IntentSection>([
    'pulse', 'agents', 'projects', 'business', 'memory', 'rag',
    'vision', 'filesystem', 'channels', 'browser', 'project_instructions',
  ]);
  return buildTargetedPrompt(deps, userMessage, allSections);
}
