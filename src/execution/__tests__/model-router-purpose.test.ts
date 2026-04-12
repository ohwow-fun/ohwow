/**
 * Unit tests for ModelRouter.selectForPurpose — the Shape C entry point.
 *
 * These tests instantiate a real ModelRouter and spy on getProvider to
 * assert: (a) Purpose→TaskType mapping is correct, (b) agent.localOnly and
 * constraints.localOnly clamp to local mode, (c) agent.purposes overrides
 * agent.default, (d) constraints.preferModel wins over both, and (e) the
 * resolved policy shape, maxCostCents, and model hint all surface back
 * through the selection result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter, type ModelProvider } from '../model-router.js';
import type { AgentModelPolicy, Purpose } from '../execution-policy.js';

function makeStubProvider(name: string): ModelProvider {
  return {
    name,
    createMessage: vi.fn(),
    isAvailable: vi.fn(async () => true),
  };
}

describe('ModelRouter.selectForPurpose', () => {
  let router: ModelRouter;
  let ollamaStub: ModelProvider;
  let anthropicStub: ModelProvider;
  let getProviderSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Minimal router construction — no real providers configured so we never
    // touch the network. All selection goes through the mocked getProvider.
    router = new ModelRouter({ modelSource: 'auto' });
    ollamaStub = makeStubProvider('ollama');
    anthropicStub = makeStubProvider('anthropic');

    // Default spy returns the anthropic stub so we can watch it get called.
    getProviderSpy = vi
      .spyOn(router, 'getProvider')
      .mockImplementation(async () => anthropicStub);
  });

  describe('Purpose → TaskType dispatch', () => {
    // Each row: purpose, expected taskType passed to getProvider, and the
    // expected operationType (defined only for legacy purposes; undefined
    // for Shape C ones so the router doesn't double-apply execution policy).
    it.each<[Purpose, string, string | undefined]>([
      ['orchestrator_chat',   'orchestrator',      'orchestrator_chat'],
      ['agent_task',          'agent_task',        'agent_task'],
      ['planning',            'planning',          'planning'],
      ['browser_automation',  'browser',           'browser_automation'],
      ['memory_extraction',   'memory_extraction', 'memory_extraction'],
      ['ocr',                 'ocr',               'ocr'],
      ['workflow_step',       'agent_task',        'workflow_step'],
      ['simple_classification','memory_extraction','simple_classification'],
      ['desktop_control',     'agent_task',        'desktop_control'],
      ['reasoning',           'agent_task',        undefined],
      ['generation',          'agent_task',        undefined],
      ['summarization',       'memory_extraction', undefined],
      ['extraction',          'memory_extraction', undefined],
      ['critique',            'planning',          undefined],
      ['translation',         'agent_task',        undefined],
      ['embedding',           'memory_extraction', undefined],
    ])('routes purpose=%s to taskType=%s (operationType=%s)', async (purpose, expectedTaskType, expectedOpType) => {
      await router.selectForPurpose({ purpose });
      expect(getProviderSpy).toHaveBeenCalledWith(
        expectedTaskType,
        undefined,
        expectedOpType,
        undefined,
      );
    });
  });

  describe('OperationType passthrough', () => {
    it('passes operationType only for legacy purposes', async () => {
      await router.selectForPurpose({ purpose: 'planning' });
      const call = getProviderSpy.mock.calls[0];
      expect(call?.[2]).toBe('planning');
    });

    it('passes undefined operationType for Shape C purposes', async () => {
      await router.selectForPurpose({ purpose: 'reasoning' });
      const call = getProviderSpy.mock.calls[0];
      expect(call?.[2]).toBeUndefined();
    });
  });

  describe('localOnly clamping', () => {
    it('forces local mode when agent.localOnly is true', async () => {
      const agent: AgentModelPolicy = { localOnly: true };
      // Capture modelSource at the moment getProvider is called
      let observed: string | null = null;
      getProviderSpy.mockImplementation(async () => {
        // The router sets this.modelSource = 'local' before calling getProvider
        // and restores it after. We can peek via the private field.
        observed = (router as unknown as { modelSource: string }).modelSource;
        return ollamaStub;
      });

      await router.selectForPurpose({ purpose: 'reasoning', agent });

      expect(observed).toBe('local');
      // And it should have been restored afterwards:
      expect((router as unknown as { modelSource: string }).modelSource).toBe('auto');
    });

    it('forces local mode when constraints.localOnly is true', async () => {
      let observed: string | null = null;
      getProviderSpy.mockImplementation(async () => {
        observed = (router as unknown as { modelSource: string }).modelSource;
        return ollamaStub;
      });

      await router.selectForPurpose({
        purpose: 'generation',
        constraints: { localOnly: true },
      });

      expect(observed).toBe('local');
      expect((router as unknown as { modelSource: string }).modelSource).toBe('auto');
    });

    it('restores modelSource even if getProvider throws', async () => {
      getProviderSpy.mockImplementation(async () => {
        throw new Error('providers offline');
      });

      await expect(
        router.selectForPurpose({
          purpose: 'reasoning',
          agent: { localOnly: true },
        }),
      ).rejects.toThrow('providers offline');

      expect((router as unknown as { modelSource: string }).modelSource).toBe('auto');
    });
  });

  describe('model hint resolution', () => {
    it('returns no model hint when the agent has no opinion', async () => {
      const result = await router.selectForPurpose({ purpose: 'reasoning' });
      expect(result.model).toBeUndefined();
    });

    it('uses agent.default when no per-purpose override exists', async () => {
      const agent: AgentModelPolicy = { default: 'grok-4.20' };
      const result = await router.selectForPurpose({ purpose: 'reasoning', agent });
      expect(result.model).toBe('grok-4.20');
    });

    it('prefers agent.purposes[p] over agent.default', async () => {
      const agent: AgentModelPolicy = {
        default: 'grok-4.20',
        purposes: { generation: 'claude-sonnet-4.6' },
      };
      const result = await router.selectForPurpose({ purpose: 'generation', agent });
      expect(result.model).toBe('claude-sonnet-4.6');
    });

    it('falls back to agent.default for unspecified purposes', async () => {
      const agent: AgentModelPolicy = {
        default: 'grok-4.20',
        purposes: { generation: 'claude-sonnet-4.6' },
      };
      const result = await router.selectForPurpose({ purpose: 'critique', agent });
      expect(result.model).toBe('grok-4.20');
    });

    it('constraints.preferModel wins over agent.purposes and agent.default', async () => {
      const agent: AgentModelPolicy = {
        default: 'grok-4.20',
        purposes: { generation: 'claude-sonnet-4.6' },
      };
      const result = await router.selectForPurpose({
        purpose: 'generation',
        agent,
        constraints: { preferModel: 'claude-opus-4-6' },
      });
      expect(result.model).toBe('claude-opus-4-6');
    });

    it('treats "auto" as no hint', async () => {
      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { default: 'auto' },
      });
      expect(result.model).toBeUndefined();
    });
  });

  describe('constraint passthrough', () => {
    it('passes difficulty to getProvider', async () => {
      await router.selectForPurpose({
        purpose: 'reasoning',
        constraints: { difficulty: 'complex' },
      });
      const call = getProviderSpy.mock.calls[0];
      expect(call?.[1]).toBe('complex');
    });

    it('prefers constraints.maxCostCents over agent.maxCostCents', async () => {
      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { maxCostCents: 100 },
        constraints: { maxCostCents: 25 },
      });
      expect(result.maxCostCents).toBe(25);
    });

    it('falls back to agent.maxCostCents when constraints omit it', async () => {
      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { maxCostCents: 100 },
      });
      expect(result.maxCostCents).toBe(100);
    });
  });

  describe('return shape', () => {
    it('includes provider, purpose, and policy in the result', async () => {
      const result = await router.selectForPurpose({ purpose: 'summarization' });
      expect(result.provider.name).toBe('anthropic');
      expect(result.purpose).toBe('summarization');
      expect(result.policy.modelSource).toBeDefined();
      expect(result.policy.fallback).toBeDefined();
    });

    it('reflects the resolved policy for legacy purposes', async () => {
      const result = await router.selectForPurpose({ purpose: 'planning' });
      // planning → cloud modelSource per DEFAULT_POLICIES
      expect(result.policy.modelSource).toBe('cloud');
    });

    it('reflects the resolved policy for Shape C purposes', async () => {
      const result = await router.selectForPurpose({ purpose: 'extraction' });
      // extraction → local modelSource per PURPOSE_DEFAULTS
      expect(result.policy.modelSource).toBe('local');
    });

    it('clamps policy to local+none when agent.localOnly is set', async () => {
      getProviderSpy.mockResolvedValue(ollamaStub);
      const result = await router.selectForPurpose({
        purpose: 'critique',
        agent: { localOnly: true },
      });
      expect(result.policy.modelSource).toBe('local');
      expect(result.policy.fallback).toBe('none');
    });
  });
});
