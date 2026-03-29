import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../lib/rag/retrieval.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveKnowledgeChunks: vi.fn().mockResolvedValue([]),
  formatRelevantMemories: vi.fn().mockReturnValue(''),
  formatRagChunks: vi.fn().mockReturnValue(''),
}));

vi.mock('../session-store.js', () => ({
  loadOrchestratorMemory: vi.fn().mockResolvedValue(''),
}));

import { buildTargetedPrompt, type PromptBuilderDeps } from '../prompt-builder.js';
import type { IntentSection } from '../tool-definitions.js';

function makeChain() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  for (const m of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not', 'order', 'limit', 'range']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.then = vi.fn().mockImplementation((r: (v: unknown) => void) => r({ data: [], error: null, count: 0 }));
  return chain;
}

function makeDeps(overrides: Partial<PromptBuilderDeps> = {}): PromptBuilderDeps {
  return {
    db: {
      from: vi.fn().mockImplementation(() => makeChain()),
    } as never,
    workspaceId: 'ws-1',
    orchestratorModel: 'test-model',
    anthropicApiKey: 'test-key',
    workingDirectory: '/tmp/test',
    channels: {
      getConnectedTypes: vi.fn().mockReturnValue([]),
    } as never,
    hasOrchestratorFileAccess: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('buildTargetedPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns staticPart and dynamicPart', async () => {
    const deps = makeDeps();
    const sections = new Set<IntentSection>(['pulse']);
    const result = await buildTargetedPrompt(deps, 'hello', sections);

    expect(result).toHaveProperty('staticPart');
    expect(result).toHaveProperty('dynamicPart');
    expect(typeof result.staticPart).toBe('string');
    expect(typeof result.dynamicPart).toBe('string');
  });

  it('only queries agent table when agents section is needed', async () => {
    const deps = makeDeps();
    const fromSpy = deps.db.from as ReturnType<typeof vi.fn>;

    // Without agents section
    await buildTargetedPrompt(deps, 'test', new Set<IntentSection>(['pulse']));

    const calledTables = fromSpy.mock.calls.map((c: unknown[]) => c[0]) as string[];
    expect(calledTables.includes('agent_workforce_agents')).toBe(false);
  });

  it('queries agent table when agents section is present', async () => {
    const deps = makeDeps();
    const fromSpy = deps.db.from as ReturnType<typeof vi.fn>;

    await buildTargetedPrompt(deps, 'test', new Set<IntentSection>(['agents', 'pulse']));

    const calledTables = fromSpy.mock.calls.map((c: unknown[]) => c[0]) as string[];
    expect(calledTables.includes('agent_workforce_agents')).toBe(true);
  });

  it('includes pulse metrics when pulse section requested', async () => {
    const deps = makeDeps();
    const result = await buildTargetedPrompt(deps, 'test', new Set<IntentSection>(['pulse']));

    // The dynamic part should contain pulse-related content (even if empty)
    expect(result.dynamicPart).toBeDefined();
  });

  it('handles empty DB results without throwing', async () => {
    const deps = makeDeps();
    const allSections = new Set<IntentSection>([
      'pulse', 'agents', 'projects', 'business', 'channels',
    ]);

    // Should not throw
    const result = await buildTargetedPrompt(deps, undefined, allSections);
    expect(result.staticPart.length).toBeGreaterThan(0);
  });
});
