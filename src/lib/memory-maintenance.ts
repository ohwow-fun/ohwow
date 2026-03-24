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
