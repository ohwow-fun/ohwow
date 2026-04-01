/**
 * Memory maintenance — periodic hygiene for memory tables.
 * Handles dedup sweeps, stale archival, and cleanup.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { normalizeMemory, jaccardSimilarity, isJunkMemory } from './memory-utils.js';

interface MaintenanceResult {
  exactDuplicatesRemoved: number;
  semanticDuplicatesMerged: number;
  junkRemoved: number;
  staleArchived: number;
  consolidated: number;
}

interface MemoryRow {
  id: string;
  content: string;
  created_at: string;
  times_used: number;
  last_used_at: string | null;
}

const SIMILARITY_THRESHOLD = 0.85;
const STALE_DAYS = 90;

/**
 * Run maintenance on agent memories for a workspace.
 * Deduplicates, removes junk, archives stale entries.
 */
export async function runAgentMemoryMaintenance(
  db: DatabaseAdapter,
  workspaceId: string,
  options?: { agentId?: string; anthropicApiKey?: string },
): Promise<MaintenanceResult> {
  const result = await runMaintenance(db, 'agent_workforce_agent_memory', workspaceId);

  // Run consolidation if agent ID and API key are provided
  if (options?.agentId && options?.anthropicApiKey) {
    try {
      const { consolidateMemoriesLocal } = await import('./memory-consolidation.js');
      const consolidation = await consolidateMemoriesLocal(
        db,
        workspaceId,
        options.agentId,
        options.anthropicApiKey,
      );
      result.consolidated = consolidation.memoriesConsolidated;
    } catch {
      // Non-fatal
    }
  }

  return result;
}

/**
 * Run maintenance on orchestrator memories for a workspace.
 */
export async function runOrchestratorMemoryMaintenance(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<MaintenanceResult> {
  return runMaintenance(db, 'orchestrator_memory', workspaceId);
}

async function runMaintenance(
  db: DatabaseAdapter,
  table: 'agent_workforce_agent_memory' | 'orchestrator_memory',
  workspaceId: string,
): Promise<MaintenanceResult> {
  const result: MaintenanceResult = {
    exactDuplicatesRemoved: 0,
    semanticDuplicatesMerged: 0,
    junkRemoved: 0,
    staleArchived: 0,
    consolidated: 0,
  };

  // Fetch all active memories
  const selectFields = table === 'agent_workforce_agent_memory'
    ? 'id, content, created_at, times_used, last_used_at'
    : 'id, content, created_at';

  const { data } = await db
    .from<MemoryRow>(table)
    .select(selectFields)
    .eq('workspace_id', workspaceId)
    .eq('is_active', 1)
    .order('created_at', { ascending: true });

  if (!data || data.length === 0) return result;

  const memories = data ?? [];
  const now = new Date();

  // 1. Remove junk
  for (const mem of memories) {
    if (isJunkMemory(mem.content)) {
      await deactivate(db, table, mem.id);
      result.junkRemoved++;
    }
  }

  // Filter out already-deactivated junk for the dedup pass
  const junkIds = new Set<string>();
  if (result.junkRemoved > 0) {
    for (const mem of memories) {
      if (isJunkMemory(mem.content)) junkIds.add(mem.id);
    }
  }
  const cleanMemories = memories.filter(m => !junkIds.has(m.id));

  // 2. Exact dedup sweep — group by normalized content, keep newest
  const byNormalized = new Map<string, MemoryRow[]>();
  for (const mem of cleanMemories) {
    const key = normalizeMemory(mem.content);
    const group = byNormalized.get(key) ?? [];
    group.push(mem);
    byNormalized.set(key, group);
  }

  const survivorIds = new Set<string>();
  for (const [, group] of byNormalized) {
    if (group.length <= 1) {
      survivorIds.add(group[0].id);
      continue;
    }
    // Keep the newest, deactivate the rest
    group.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    survivorIds.add(group[0].id);
    for (let i = 1; i < group.length; i++) {
      await deactivate(db, table, group[i].id);
      result.exactDuplicatesRemoved++;
    }
  }

  // 3. Semantic dedup sweep — compare surviving memories pairwise
  const survivors = cleanMemories.filter(m => survivorIds.has(m.id));
  const merged = new Set<string>();

  for (let i = 0; i < survivors.length; i++) {
    if (merged.has(survivors[i].id)) continue;
    for (let j = i + 1; j < survivors.length; j++) {
      if (merged.has(survivors[j].id)) continue;
      if (jaccardSimilarity(survivors[i].content, survivors[j].content) >= SIMILARITY_THRESHOLD) {
        // Keep the newer one (higher index since sorted ascending by created_at)
        await deactivate(db, table, survivors[i].id);
        merged.add(survivors[i].id);
        result.semanticDuplicatesMerged++;
        break; // This memory is now merged, move on
      }
    }
  }

  // 4. Archive stale memories (not used in 90+ days, low usage)
  for (const mem of survivors) {
    if (merged.has(mem.id)) continue;

    const lastActivity = mem.last_used_at
      ? new Date(mem.last_used_at)
      : new Date(mem.created_at);
    const daysSinceActivity = (now.getTime() - lastActivity.getTime()) / 86400000;

    if (daysSinceActivity > STALE_DAYS && (mem.times_used ?? 0) <= 1) {
      await deactivate(db, table, mem.id);
      result.staleArchived++;
    }
  }

  return result;
}

async function deactivate(
  db: DatabaseAdapter,
  table: string,
  id: string,
): Promise<void> {
  await db.from(table)
    .update({ is_active: 0, updated_at: new Date().toISOString() })
    .eq('id', id);
}

// ============================================================================
// MEMORY HARD CAP (cloud-compatible: 1000 active memories per agent)
// ============================================================================

const MEMORY_CAP_PER_AGENT = 1000;

/**
 * Enforce the 1000 active memory hard cap per agent.
 * Deactivates memories with the lowest relevance_score when over the cap.
 * Returns the number of memories deactivated.
 */
export async function enforceMemoryCap(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId?: string,
): Promise<number> {
  let totalDeactivated = 0;

  try {
    // Get all agent IDs to process
    let agentIds: string[];
    if (agentId) {
      agentIds = [agentId];
    } else {
      const { data: agents } = await db.from('agent_workforce_agents')
        .select('id').eq('workspace_id', workspaceId);
      agentIds = (agents ?? []).map((a) => (a as Record<string, unknown>).id as string);
    }

    for (const aid of agentIds) {
      // Count active memories for this agent
      const { count } = await db.from('agent_workforce_agent_memory')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('agent_id', aid)
        .eq('is_active', 1);

      const activeCount = count ?? 0;
      if (activeCount <= MEMORY_CAP_PER_AGENT) continue;

      const excess = activeCount - MEMORY_CAP_PER_AGENT;

      // Fetch the lowest-relevance memories to deactivate
      const { data: toDeactivate } = await db
        .from<{ id: string }>('agent_workforce_agent_memory')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('agent_id', aid)
        .eq('is_active', 1)
        .order('relevance_score', { ascending: true })
        .limit(excess);

      if (toDeactivate) {
        for (const row of toDeactivate) {
          await deactivate(db, 'agent_workforce_agent_memory', row.id);
          totalDeactivated++;
        }
      }
    }
  } catch {
    // Non-critical
  }

  return totalDeactivated;
}

// ============================================================================
// EXPERIMENT ARCHIVAL (cloud-compatible: 90-day compression)
// ============================================================================

export interface ArchiveResult {
  principlesArchived: number;
  skillsArchived: number;
  processesArchived: number;
  practiceSessionsArchived: number;
}

/**
 * Archive old experiment data (principles, skills, discovered processes,
 * practice sessions) older than the specified number of days.
 * Deactivates rather than deletes, preserving audit trail.
 * Compatible with cloud's archiveOldExperiments(90).
 */
export async function archiveOldExperiments(
  db: DatabaseAdapter,
  workspaceId: string,
  maxAgeDays = 90,
): Promise<ArchiveResult> {
  const result: ArchiveResult = {
    principlesArchived: 0,
    skillsArchived: 0,
    processesArchived: 0,
    practiceSessionsArchived: 0,
  };

  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Archive low-utility principles older than cutoff
    const { data: oldPrinciples } = await db
      .from<{ id: string }>('agent_workforce_principles')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('is_active', 1)
      .lt('created_at', cutoff)
      .lt('utility_score', 1); // Keep high-utility principles regardless of age

    if (oldPrinciples) {
      for (const row of oldPrinciples) {
        await db.from('agent_workforce_principles')
          .update({ is_active: 0, updated_at: new Date().toISOString() })
          .eq('id', row.id);
        result.principlesArchived++;
      }
    }

    // Archive old skills with low support
    const { data: oldSkills } = await db
      .from<{ id: string }>('agent_workforce_skills')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('is_active', 1)
      .lt('created_at', cutoff)
      .lt('pattern_support', 5); // Keep well-supported skills

    if (oldSkills) {
      for (const row of oldSkills) {
        await db.from('agent_workforce_skills')
          .update({ is_active: 0, updated_at: new Date().toISOString() })
          .eq('id', row.id);
        result.skillsArchived++;
      }
    }

    // Archive old discovered processes that weren't validated
    const { data: oldProcesses } = await db
      .from<{ id: string }>('agent_workforce_discovered_processes')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'discovered') // Only archive unvalidated ones
      .lt('created_at', cutoff);

    if (oldProcesses) {
      for (const row of oldProcesses) {
        await db.from('agent_workforce_discovered_processes')
          .update({ status: 'archived' })
          .eq('id', row.id);
        result.processesArchived++;
      }
    }

    // Archive old practice sessions
    const { data: oldSessions } = await db
      .from<{ id: string }>('agent_workforce_practice_sessions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .lt('created_at', cutoff);

    if (oldSessions) {
      for (const row of oldSessions) {
        await db.from('agent_workforce_practice_sessions')
          .update({ status: 'archived' })
          .eq('id', row.id);
        result.practiceSessionsArchived++;
      }
    }
  } catch {
    // Non-critical
  }

  return result;
}
