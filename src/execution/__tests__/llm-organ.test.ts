/**
 * Unit tests for the `llm` organ shared core.
 *
 * Covers input validation, prompt normalization, agent policy loading,
 * provider invocation, and telemetry in the return shape. A stub router
 * stands in for the real ModelRouter so we can assert exactly what
 * selectForPurpose was called with per test.
 */

import { describe, it, expect, vi } from 'vitest';
import { runLlmCall, VALID_PURPOSES, type LlmCallDeps } from '../llm-organ.js';
import type { ModelProvider, ModelResponse, CreateMessageParams, ModelResponseWithTools, OpenAITool } from '../model-router.js';
import type { AgentModelPolicy } from '../execution-policy.js';

type StubSelection = {
  provider: ModelProvider;
  model?: string;
  purpose: string;
  policy: { modelSource: string; fallback: string; creditBudget?: number };
  maxCostCents?: number;
};

function makeProvider(name: string, response: Partial<ModelResponse> = {}): ModelProvider {
  return {
    name,
    createMessage: vi.fn(async (_params: CreateMessageParams): Promise<ModelResponse> => ({
      content: 'stubbed response',
      inputTokens: 10,
      outputTokens: 20,
      model: response.model ?? 'stub-model',
      provider: (response.provider ?? 'ollama') as ModelResponse['provider'],
      costCents: response.costCents,
    })),
    isAvailable: vi.fn(async () => true),
  };
}

function makeDeps(opts: {
  selection?: StubSelection;
  agentPolicy?: AgentModelPolicy;
  currentAgentId?: string;
  selectForPurposeImpl?: (args: unknown) => Promise<StubSelection>;
}): LlmCallDeps {
  const defaultProvider = makeProvider('ollama');
  const defaultSelection: StubSelection = opts.selection ?? {
    provider: defaultProvider,
    model: undefined,
    purpose: 'reasoning',
    policy: { modelSource: 'auto', fallback: 'local' },
    maxCostCents: undefined,
  };

  const selectForPurpose = vi.fn(
    opts.selectForPurposeImpl ?? (async () => defaultSelection),
  );

  const fromBuilder: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({
      data: opts.agentPolicy
        ? { config: JSON.stringify({ model_policy: opts.agentPolicy }) }
        : null,
      error: null,
    })),
  };

  return {
    modelRouter: { selectForPurpose } as unknown as LlmCallDeps['modelRouter'],
    db: {
      from: vi.fn(() => fromBuilder),
      rpc: vi.fn(),
    } as unknown as LlmCallDeps['db'],
    workspaceId: 'test-workspace',
    currentAgentId: opts.currentAgentId,
  };
}

describe('llm-organ', () => {
  describe('VALID_PURPOSES', () => {
    it('covers every legacy OperationType plus the Shape C extensions', () => {
      expect(VALID_PURPOSES).toContain('orchestrator_chat');
      expect(VALID_PURPOSES).toContain('agent_task');
      expect(VALID_PURPOSES).toContain('planning');
      expect(VALID_PURPOSES).toContain('memory_extraction');
      expect(VALID_PURPOSES).toContain('ocr');
      // Shape C additions
      expect(VALID_PURPOSES).toContain('reasoning');
      expect(VALID_PURPOSES).toContain('generation');
      expect(VALID_PURPOSES).toContain('summarization');
      expect(VALID_PURPOSES).toContain('extraction');
      expect(VALID_PURPOSES).toContain('critique');
      expect(VALID_PURPOSES).toContain('translation');
      expect(VALID_PURPOSES).toContain('embedding');
    });
  });

  describe('input validation', () => {
    it('rejects calls with no prompt', async () => {
      const deps = makeDeps({});
      const result = await runLlmCall(deps, {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('prompt');
      }
    });

    it('rejects calls with an empty string prompt', async () => {
      const deps = makeDeps({});
      const result = await runLlmCall(deps, { prompt: '   ' });
      expect(result.ok).toBe(false);
    });

    it('rejects prompt objects with zero messages', async () => {
      const deps = makeDeps({});
      const result = await runLlmCall(deps, {
        prompt: { system: 'hello', messages: [] },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('messages');
      }
    });

    it('rejects invalid purpose strings', async () => {
      const deps = makeDeps({});
      const result = await runLlmCall(deps, {
        prompt: 'hi',
        purpose: 'telepathy',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('telepathy');
      }
    });

    it('defaults to reasoning when purpose is omitted', async () => {
      const stubRouter = vi.fn(async (args: { purpose: string }) => ({
        provider: makeProvider('ollama'),
        model: undefined,
        purpose: args.purpose,
        policy: { modelSource: 'auto', fallback: 'local' },
        maxCostCents: undefined,
      }));
      const deps: LlmCallDeps = {
        modelRouter: { selectForPurpose: stubRouter } as unknown as LlmCallDeps['modelRouter'],
        db: { from: vi.fn(() => ({ insert: vi.fn(async () => ({ data: null, error: null })) })), rpc: vi.fn() } as unknown as LlmCallDeps['db'],
        workspaceId: 'test-workspace',
      };
      const result = await runLlmCall(deps, { prompt: 'hi' });
      expect(result.ok).toBe(true);
      expect(stubRouter).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'reasoning' }),
      );
    });
  });

  describe('prompt normalization', () => {
    it('wraps a plain string into a single user message', async () => {
      const provider = makeProvider('ollama');
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
        },
      });
      await runLlmCall(deps, { prompt: 'hello world', system: 'be terse' });
      expect(provider.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'be terse',
          messages: [{ role: 'user', content: 'hello world' }],
        }),
      );
    });

    it('preserves role/content for structured prompts', async () => {
      const provider = makeProvider('ollama');
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
        },
      });
      await runLlmCall(deps, {
        prompt: {
          system: 'you are a poet',
          messages: [
            { role: 'user', content: 'write a haiku' },
            { role: 'assistant', content: 'here it is' },
            { role: 'user', content: 'one more' },
          ],
        },
      });
      expect(provider.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'you are a poet',
          messages: [
            { role: 'user', content: 'write a haiku' },
            { role: 'assistant', content: 'here it is' },
            { role: 'user', content: 'one more' },
          ],
        }),
      );
    });
  });

  describe('agent policy loading', () => {
    it('skips policy load when currentAgentId is absent', async () => {
      const selectForPurpose = vi.fn(async () => ({
        provider: makeProvider('ollama'),
        model: undefined,
        purpose: 'reasoning' as const,
        policy: { modelSource: 'auto', fallback: 'local' },
        maxCostCents: undefined,
      }));
      const from = vi.fn(() => ({
        insert: vi.fn(async () => ({ data: null, error: null })),
      }));
      const deps: LlmCallDeps = {
        modelRouter: { selectForPurpose } as unknown as LlmCallDeps['modelRouter'],
        db: { from, rpc: vi.fn() } as unknown as LlmCallDeps['db'],
        workspaceId: 'test-workspace',
      };
      await runLlmCall(deps, { prompt: 'hi' });
      // `from` may be called once for the telemetry row (llm_calls). It
      // must NOT be called for agent_workforce_agents because we have no
      // currentAgentId to load a policy for.
      const agentLookupCall = (from.mock.calls as unknown[][]).find(
        (c) => c[0] === 'agent_workforce_agents',
      );
      expect(agentLookupCall).toBeUndefined();
      expect(selectForPurpose).toHaveBeenCalledWith(
        expect.objectContaining({ agent: undefined }),
      );
    });

    it('loads policy from the DB and passes it to the router', async () => {
      // Agents never pin a model. Policy only carries hard constraints.
      const policy: AgentModelPolicy = {
        localOnly: false,
        maxCostCents: 200,
      };
      const deps = makeDeps({
        agentPolicy: policy,
        currentAgentId: 'agent-42',
      });
      await runLlmCall(deps, { prompt: 'hi', purpose: 'generation' });
      const routerStub = deps.modelRouter as unknown as {
        selectForPurpose: ReturnType<typeof vi.fn>;
      };
      expect(routerStub.selectForPurpose).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: 'generation',
          agent: policy,
        }),
      );
    });

    it('tolerates DB errors and falls back to no policy', async () => {
      const selectForPurpose = vi.fn(async () => ({
        provider: makeProvider('ollama'),
        model: undefined,
        purpose: 'reasoning' as const,
        policy: { modelSource: 'auto', fallback: 'local' },
        maxCostCents: undefined,
      }));
      const deps: LlmCallDeps = {
        modelRouter: { selectForPurpose } as unknown as LlmCallDeps['modelRouter'],
        db: {
          from: () => ({
            // Policy-lookup shape
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  throw new Error('db down');
                },
              }),
            }),
            // Telemetry insert shape — never throws
            insert: async () => ({ data: null, error: null }),
          }),
          rpc: vi.fn(),
        } as unknown as LlmCallDeps['db'],
        workspaceId: 'test-workspace',
        currentAgentId: 'agent-7',
      };
      const result = await runLlmCall(deps, { prompt: 'hi' });
      expect(result.ok).toBe(true);
      expect(selectForPurpose).toHaveBeenCalledWith(
        expect.objectContaining({ agent: undefined }),
      );
    });
  });

  describe('return shape + telemetry', () => {
    it('surfaces model_used, provider, tokens, cost, and latency', async () => {
      const provider = makeProvider('anthropic', {
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        costCents: 42,
      });
      const deps = makeDeps({
        selection: {
          provider,
          model: 'claude-haiku-4-5-20251001',
          purpose: 'summarization',
          policy: { modelSource: 'local', fallback: 'cloud' },
          maxCostCents: undefined,
        },
      });
      const result = await runLlmCall(deps, {
        prompt: 'summarize this',
        purpose: 'summarization',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.model_used).toBe('claude-haiku-4-5-20251001');
        expect(result.data.provider).toBe('anthropic');
        expect(result.data.purpose).toBe('summarization');
        expect(result.data.tokens).toEqual({ input: 10, output: 20 });
        expect(result.data.cost_cents).toBe(42);
        expect(typeof result.data.latency_ms).toBe('number');
        expect(result.data.latency_ms).toBeGreaterThanOrEqual(0);
        expect(result.data.policy.modelSource).toBe('local');
        expect(result.data.cap_warning).toBeUndefined();
      }
    });

    it('emits cap_warning when cost exceeds maxCostCents', async () => {
      const provider = makeProvider('openrouter', { costCents: 500 });
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
          maxCostCents: 100,
        },
      });
      const result = await runLlmCall(deps, { prompt: 'big request' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.cap_warning).toContain('500');
        expect(result.data.cap_warning).toContain('100');
      }
    });

    it('omits cap_warning when the provider reports no cost', async () => {
      const provider = makeProvider('ollama', { costCents: undefined });
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'local', fallback: 'cloud' },
          maxCostCents: 100,
        },
      });
      const result = await runLlmCall(deps, { prompt: 'hi' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.cap_warning).toBeUndefined();
        expect(result.data.cost_cents).toBe(0);
      }
    });
  });

  describe('error handling', () => {
    it('returns a typed error when the router throws', async () => {
      const deps: LlmCallDeps = {
        modelRouter: {
          selectForPurpose: async () => {
            throw new Error('no provider available');
          },
        } as unknown as LlmCallDeps['modelRouter'],
        db: {
          from: vi.fn(() => ({ insert: vi.fn(async () => ({ data: null, error: null })) })),
          rpc: vi.fn(),
        } as unknown as LlmCallDeps['db'],
        workspaceId: 'test-workspace',
      };
      const result = await runLlmCall(deps, { prompt: 'hi' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('no provider available');
      }
    });

    it('returns a typed error when the provider throws', async () => {
      const provider: ModelProvider = {
        name: 'ollama',
        createMessage: async () => {
          throw new Error('connection refused');
        },
        isAvailable: async () => true,
      };
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
          maxCostCents: undefined,
        },
      });
      const result = await runLlmCall(deps, { prompt: 'hi' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('connection refused');
        expect(result.error).toContain('ollama');
      }
    });
  });

  describe('routing history', () => {
    /**
     * Build a fake DB that returns a canned array of llm_calls rows when
     * queried for historical success rate, plus a no-op insert for
     * telemetry writes. The agent-policy lookup path is left empty so it
     * returns no policy.
     */
    function fakeDbWithHistory(history: number[]): LlmCallDeps['db'] {
      return {
        from: (table: string) => {
          if (table === 'llm_calls') {
            const builder: Record<string, unknown> = {
              select: () => builder,
              eq: () => builder,
              order: () => builder,
              limit: async () => ({
                data: history.map((success) => ({ success })),
                error: null,
              }),
              insert: async () => ({ data: null, error: null }),
            };
            return builder;
          }
          // agent_workforce_agents + any other table
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            }),
            insert: async () => ({ data: null, error: null }),
          };
        },
        rpc: vi.fn(),
      } as unknown as LlmCallDeps['db'];
    }

    it('computes avgTruthScore from llm_calls success rate and forwards it', async () => {
      const selectForPurpose = vi.fn(async () => ({
        provider: makeProvider('ollama'),
        model: undefined,
        purpose: 'reasoning' as const,
        policy: { modelSource: 'auto', fallback: 'local' },
        maxCostCents: undefined,
      }));
      const deps: LlmCallDeps = {
        modelRouter: { selectForPurpose } as unknown as LlmCallDeps['modelRouter'],
        db: fakeDbWithHistory([1, 1, 1, 0, 1, 1, 0, 1, 1, 1]), // 8/10 = 80%
        workspaceId: 'test-workspace',
      };

      await runLlmCall(deps, { prompt: 'hi' });

      expect(selectForPurpose).toHaveBeenCalledWith(
        expect.objectContaining({
          routingHistory: { avgTruthScore: 80, attempts: 10 },
        }),
      );
    });

    it('sends undefined routingHistory when fewer than 3 rows exist', async () => {
      const selectForPurpose = vi.fn(async () => ({
        provider: makeProvider('ollama'),
        model: undefined,
        purpose: 'reasoning' as const,
        policy: { modelSource: 'auto', fallback: 'local' },
        maxCostCents: undefined,
      }));
      const deps: LlmCallDeps = {
        modelRouter: { selectForPurpose } as unknown as LlmCallDeps['modelRouter'],
        db: fakeDbWithHistory([1, 0]),
        workspaceId: 'test-workspace',
      };

      await runLlmCall(deps, { prompt: 'hi' });

      expect(selectForPurpose).toHaveBeenCalledWith(
        expect.objectContaining({ routingHistory: undefined }),
      );
    });

    it('flags a majority-failure history as a low truth score', async () => {
      const selectForPurpose = vi.fn(async () => ({
        provider: makeProvider('ollama'),
        model: undefined,
        purpose: 'reasoning' as const,
        policy: { modelSource: 'auto', fallback: 'local' },
        maxCostCents: undefined,
      }));
      const deps: LlmCallDeps = {
        modelRouter: { selectForPurpose } as unknown as LlmCallDeps['modelRouter'],
        db: fakeDbWithHistory([0, 0, 0, 1, 0]), // 1/5 = 20%
        workspaceId: 'test-workspace',
      };

      await runLlmCall(deps, { prompt: 'hi' });

      expect(selectForPurpose).toHaveBeenCalledWith(
        expect.objectContaining({
          routingHistory: { avgTruthScore: 20, attempts: 5 },
        }),
      );
    });
  });

  describe('content blocks', () => {
    it('always returns a content array (single text block when no tools)', async () => {
      const deps = makeDeps({});
      const result = await runLlmCall(deps, { prompt: 'hello' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.content).toEqual([{ type: 'text', text: 'stubbed response' }]);
      }
    });
  });

  describe('tool use', () => {
    function makeToolCapableProvider(toolCalls: ModelResponseWithTools['toolCalls']): ModelProvider {
      const createMessageWithTools = vi.fn(async (
        _params: CreateMessageParams & { tools: OpenAITool[] },
      ): Promise<ModelResponseWithTools> => ({
        content: 'thinking out loud',
        inputTokens: 5,
        outputTokens: 7,
        model: 'tool-capable-model',
        provider: 'anthropic',
        costCents: 1,
        toolCalls,
      }));
      return {
        name: 'anthropic',
        createMessage: vi.fn(async (): Promise<ModelResponse> => ({
          content: 'should not be called',
          inputTokens: 0,
          outputTokens: 0,
          model: 'tool-capable-model',
          provider: 'anthropic',
        })),
        createMessageWithTools,
        isAvailable: vi.fn(async () => true),
      };
    }

    it('dispatches to createMessageWithTools when tools array is non-empty', async () => {
      const provider = makeToolCapableProvider([
        { id: 'call-1', type: 'function', function: { name: 'test_tool', arguments: '{"q":"42"}' } },
      ]);
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
        },
      });
      const result = await runLlmCall(deps, {
        prompt: 'use the tool',
        tools: [
          { name: 'test_tool', description: 'a test', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(provider.createMessageWithTools).toHaveBeenCalledTimes(1);
        // Text + one tool_use block
        expect(result.data.content).toHaveLength(2);
        expect(result.data.content[0]).toEqual({ type: 'text', text: 'thinking out loud' });
        expect(result.data.content[1]).toEqual({
          type: 'tool_use',
          id: 'call-1',
          name: 'test_tool',
          input: { q: '42' },
        });
      }
    });

    it('returns multiple tool_use blocks when the model emits parallel calls', async () => {
      const provider = makeToolCapableProvider([
        { id: 'call-a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
        { id: 'call-b', type: 'function', function: { name: 'tool_b', arguments: '{"k":1}' } },
      ]);
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
        },
      });
      const result = await runLlmCall(deps, {
        prompt: 'do things',
        tools: [{ name: 'tool_a' }, { name: 'tool_b' }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const toolUseBlocks = result.data.content.filter((b) => b.type === 'tool_use');
        expect(toolUseBlocks).toHaveLength(2);
      }
    });

    it('preserves raw arguments when the provider returns invalid JSON', async () => {
      const provider = makeToolCapableProvider([
        { id: 'call-bad', type: 'function', function: { name: 'tool', arguments: '{not_json' } },
      ]);
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
        },
      });
      const result = await runLlmCall(deps, {
        prompt: 'oops',
        tools: [{ name: 'tool' }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const toolBlock = result.data.content.find((b) => b.type === 'tool_use');
        expect(toolBlock).toBeDefined();
        if (toolBlock?.type === 'tool_use') {
          expect(toolBlock.input).toEqual({ _raw_arguments: '{not_json' });
        }
      }
    });

    it('fails clearly when the selected provider does not support tool calls', async () => {
      const provider: ModelProvider = {
        name: 'no-tools-provider',
        createMessage: async () => ({
          content: '', inputTokens: 0, outputTokens: 0, model: 'm', provider: 'ollama',
        }),
        // createMessageWithTools deliberately omitted
        isAvailable: async () => true,
      };
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
        },
      });
      const result = await runLlmCall(deps, {
        prompt: 'hi',
        tools: [{ name: 'tool' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('does not support tool calls');
      }
    });

    it('rejects malformed tool entries with a clear error', async () => {
      const deps = makeDeps({});
      const result = await runLlmCall(deps, {
        prompt: 'hi',
        tools: [{ description: 'missing name' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.toLowerCase()).toContain('name');
      }
    });

    it('accepts a top-level messages array as conversation history', async () => {
      const provider = makeToolCapableProvider([]);
      const deps = makeDeps({
        selection: {
          provider,
          model: undefined,
          purpose: 'reasoning',
          policy: { modelSource: 'auto', fallback: 'local' },
        },
      });
      const result = await runLlmCall(deps, {
        messages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'reply', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool', arguments: '{}' } }] },
          { role: 'tool', content: 'tool result text', tool_call_id: 'c1' },
        ],
        tools: [{ name: 'tool' }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(provider.createMessageWithTools).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [
              { role: 'user', content: 'first turn' },
              expect.objectContaining({
                role: 'assistant',
                content: 'reply',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
              }),
              expect.objectContaining({
                role: 'tool',
                content: 'tool result text',
                tool_call_id: 'c1',
              }),
            ],
          }),
        );
      }
    });
  });

  describe('constraint passthrough', () => {
    it('passes preferModel, localOnly, maxCostCents, and difficulty to the router', async () => {
      const deps = makeDeps({});
      await runLlmCall(deps, {
        prompt: 'hi',
        purpose: 'reasoning',
        prefer_model: 'claude-opus-4-6',
        local_only: true,
        max_cost_cents: 250,
        difficulty: 'complex',
      });
      const routerStub = deps.modelRouter as unknown as {
        selectForPurpose: ReturnType<typeof vi.fn>;
      };
      expect(routerStub.selectForPurpose).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: 'reasoning',
          constraints: expect.objectContaining({
            preferModel: 'claude-opus-4-6',
            localOnly: true,
            maxCostCents: 250,
            difficulty: 'complex',
          }),
        }),
      );
    });
  });
});
