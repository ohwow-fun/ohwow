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
import { ModelRouter, inferProviderFromModel, type ModelProvider } from '../model-router.js';
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
    // These tests install fake providers on the router so the model-hint
    // → provider inference path can actually resolve (otherwise my "drop
    // the hint when the inferred provider is not configured" logic clears
    // the hint, which is correct real-world behavior).
    beforeEach(() => {
      const fakeAnthropic: ModelProvider = {
        name: 'anthropic',
        createMessage: vi.fn(),
        isAvailable: vi.fn(async () => true),
      };
      const fakeOpenRouter: ModelProvider = {
        name: 'openrouter',
        createMessage: vi.fn(),
        isAvailable: vi.fn(async () => true),
      };
      (router as unknown as { anthropic: ModelProvider }).anthropic = fakeAnthropic;
      (router as unknown as { openrouter: ModelProvider }).openrouter = fakeOpenRouter;
    });

    it('returns no model hint when the agent has no opinion', async () => {
      const result = await router.selectForPurpose({ purpose: 'reasoning' });
      expect(result.model).toBeUndefined();
    });

    it('uses agent.default when no per-purpose override exists', async () => {
      // grok-4.20 has no slash → inference returns null → the hint survives
      // to the result via the normal (non-inference) path.
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
      // claude-sonnet-4.6 → infers anthropic → fake anthropic is configured
      // and available → routes there directly with the hint preserved.
      expect(result.model).toBe('claude-sonnet-4.6');
      expect(result.provider.name).toBe('anthropic');
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

  describe('inferProviderFromModel', () => {
    it.each<[string, string | null]>([
      ['claude-sonnet-4-6', 'anthropic'],
      ['claude-opus-4-6', 'anthropic'],
      ['claude-haiku-4-5-20251001', 'anthropic'],
      ['mlx-community/gemma-4-e4b-it-4bit', 'mlx'],
      ['anthropic/claude-sonnet-4.6', 'openrouter'],
      ['openai/gpt-4o-mini', 'openrouter'],
      ['x-ai/grok-4.20', 'openrouter'],
      ['google/gemini-2.5-flash', 'openrouter'],
      ['meta-llama/llama-3.1-405b', 'openrouter'],
      ['deepseek/deepseek-v3.2', 'openrouter'],
      ['qwen3:0.6b', 'ollama'],
      ['qwen3.5:9b', 'ollama'],
      ['llama3.1:8b', 'ollama'],
      ['gemma2:9b', 'ollama'],
      ['', null],
      ['some-random-name', null],
    ])('infers provider for %s as %s', (model, expected) => {
      expect(inferProviderFromModel(model)).toBe(expected);
    });
  });

  describe('model-hint provider override', () => {
    it('routes to Ollama when the hint is an Ollama tag and Ollama is available', async () => {
      // Install a fake Ollama provider on the private field so the test can
      // inspect how selectForPurpose resolves the hint.
      const fakeOllama: ModelProvider = {
        name: 'ollama',
        createMessage: vi.fn(),
        isAvailable: vi.fn(async () => true),
      };
      (router as unknown as { ollama: ModelProvider }).ollama = fakeOllama;

      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { default: 'qwen3:0.6b' },
      });

      expect(result.provider.name).toBe('ollama');
      expect(result.model).toBe('qwen3:0.6b');
      // getProvider should NOT have been consulted because the hint matched
      // a configured provider directly.
      expect(getProviderSpy).not.toHaveBeenCalled();
    });

    it('falls through to normal dispatch when the inferred provider is unavailable', async () => {
      const fakeOllama: ModelProvider = {
        name: 'ollama',
        createMessage: vi.fn(),
        isAvailable: vi.fn(async () => false),
      };
      (router as unknown as { ollama: ModelProvider }).ollama = fakeOllama;

      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { default: 'qwen3:0.6b' },
      });

      // Should have fallen through to the mocked getProvider which returns anthropicStub.
      expect(result.provider.name).toBe('anthropic');
      expect(getProviderSpy).toHaveBeenCalled();
      // Critically, the hint must be DROPPED on fall-through so the
      // fallback provider uses its own default model instead of trying
      // (and failing) to serve the unavailable provider's model string.
      expect(result.model).toBeUndefined();
    });

    it('drops the hint when the inferred provider is not configured at all', async () => {
      // No ollama configured on this router.
      (router as unknown as { ollama: ModelProvider | null }).ollama = null;

      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { default: 'llama3.1:8b' },
      });

      expect(result.provider.name).toBe('anthropic');
      expect(result.model).toBeUndefined();
    });

    it('routes to OpenRouter when the hint looks like a namespaced cloud model', async () => {
      const fakeOpenRouter: ModelProvider = {
        name: 'openrouter',
        createMessage: vi.fn(),
        isAvailable: vi.fn(async () => true),
      };
      (router as unknown as { openrouter: ModelProvider }).openrouter = fakeOpenRouter;

      const result = await router.selectForPurpose({
        purpose: 'generation',
        agent: { default: 'x-ai/grok-4.20' },
      });

      expect(result.provider.name).toBe('openrouter');
      expect(result.model).toBe('x-ai/grok-4.20');
    });

    it('routes to Anthropic when the hint is a claude-* model', async () => {
      const fakeAnthropic: ModelProvider = {
        name: 'anthropic',
        createMessage: vi.fn(),
        isAvailable: vi.fn(async () => true),
      };
      (router as unknown as { anthropic: ModelProvider }).anthropic = fakeAnthropic;

      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { default: 'claude-sonnet-4-6' },
      });

      expect(result.provider.name).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('honors constraints.preferModel for provider inference', async () => {
      const fakeOllama: ModelProvider = {
        name: 'ollama',
        createMessage: vi.fn(),
        isAvailable: vi.fn(async () => true),
      };
      (router as unknown as { ollama: ModelProvider }).ollama = fakeOllama;

      // Agent prefers a cloud model, but the call site overrides to a local.
      const result = await router.selectForPurpose({
        purpose: 'reasoning',
        agent: { default: 'claude-sonnet-4-6' },
        constraints: { preferModel: 'llama3.1:8b' },
      });

      expect(result.provider.name).toBe('ollama');
      expect(result.model).toBe('llama3.1:8b');
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
