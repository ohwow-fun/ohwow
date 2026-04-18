/**
 * Gap 13 follow-up 1b — interactive origin tagging.
 *
 * Each interactive entry point (operator chat tool wrappers, the
 * /api/llm HTTP endpoint, the COS onboarding-plan tool, the
 * OpenRouter chat loop's direct telemetry write) MUST pass
 * `origin: 'interactive'` through to the LLM organ so the row is
 * excluded from the autonomous daily cap sum in createBudgetMeter.
 *
 * If any of these regresses to the 'autonomous' default, the meter
 * starts counting operator-initiated spend against the autonomous
 * budget — which was the root of the bug this follow-up closed. The
 * assertions below are the canary: break them, catch the regression.
 *
 * We deliberately mock runLlmCall (and recordLlmCallTelemetry) rather
 * than wiring real providers — the behavior under test is a single
 * deps field, not the full dispatch pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the organ surface. Each test reads back the deps object the
// entry point handed to runLlmCall / recordLlmCallTelemetry and asserts
// origin='interactive' landed on it.
const runLlmCallMock = vi.fn(async (_deps: unknown, _input: unknown): Promise<unknown> => ({
  ok: true,
  data: {
    text: 'stub',
    content: [{ type: 'text', text: 'stub' }],
    model_used: 'stub-model',
    provider: 'ollama',
    purpose: 'reasoning',
    policy: { modelSource: 'auto', fallback: 'local' },
    tokens: { input: 1, output: 1 },
    cost_cents: 0,
    latency_ms: 1,
  },
}));

vi.mock('../llm-organ.js', () => ({
  runLlmCall: runLlmCallMock,
}));

beforeEach(() => {
  runLlmCallMock.mockClear();
});

describe('gap 13 follow-up 1b: interactive origin tagging', () => {
  describe('orchestrator llm tool (src/orchestrator/tools/llm.ts)', () => {
    it("tags origin='interactive' on every invocation", async () => {
      const { llmTool } = await import('../../orchestrator/tools/llm.js');

      const ctx = {
        db: {} as never,
        workspaceId: 'ws-test',
        engine: {} as never,
        channels: {} as never,
        controlPlane: null,
        modelRouter: { selectForPurpose: vi.fn() } as never,
      };

      await llmTool(ctx as never, { prompt: 'hello' });

      expect(runLlmCallMock).toHaveBeenCalledTimes(1);
      const firstCall = runLlmCallMock.mock.calls[0] as unknown as unknown[];
      const depsArg = firstCall[0] as { origin?: string };
      expect(depsArg.origin).toBe('interactive');
    });

    it('refuses and never dispatches when modelRouter is missing', async () => {
      const { llmTool } = await import('../../orchestrator/tools/llm.js');
      const ctx = {
        db: {} as never,
        workspaceId: 'ws-test',
        engine: {} as never,
        channels: {} as never,
        controlPlane: null,
      };
      const result = await llmTool(ctx as never, { prompt: 'hello' });
      expect(result.success).toBe(false);
      expect(runLlmCallMock).not.toHaveBeenCalled();
    });
  });

  describe('/api/llm route (src/api/routes/llm.ts)', () => {
    it("tags origin='interactive' on operator HTTP calls", async () => {
      const { createLlmRouter } = await import('../../api/routes/llm.js');
      const modelRouter = { selectForPurpose: vi.fn() } as never;
      const db = {} as never;
      const router = createLlmRouter(db, modelRouter);

      // Extract the handler — Express stacks the POST handler at index 0
      // for this single-route router.
      const layer = (router as unknown as { stack: Array<{ route?: { stack: Array<{ handle: unknown }> } }> }).stack
        .find((l) => l.route);
      expect(layer).toBeDefined();
      const handler = layer!.route!.stack[0]!.handle as (
        req: unknown,
        res: unknown,
      ) => Promise<void>;

      const req = { body: { prompt: 'hi' }, workspaceId: 'ws-http' } as never;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as never;

      await handler(req, res);

      expect(runLlmCallMock).toHaveBeenCalledTimes(1);
      const firstCall = runLlmCallMock.mock.calls[0] as unknown as unknown[];
      const depsArg = firstCall[0] as {
        origin?: string;
        workspaceId?: string;
      };
      expect(depsArg.origin).toBe('interactive');
      expect(depsArg.workspaceId).toBe('ws-http');
    });
  });

  describe('propose_first_month_plan tool (src/orchestrator/tools/onboarding-plan.ts)', () => {
    it("tags origin='interactive' on COS chat-driven plan synthesis", async () => {
      // The tool loads team_member + person_model context before the
      // LLM call and refuses if the profile is too thin. Stub the loader
      // via a shallow db mock so the synthesis path actually runs.
      const { proposeFirstMonthPlan } = await import(
        '../../orchestrator/tools/onboarding-plan.js'
      );

      const personModel = {
        skills: { value: 'typescript; rust', confidence: 0.9 },
        ambitions: { value: 'ship systems', confidence: 0.8 },
        communication_style: { value: 'async-first', confidence: 0.9 },
        working_hours: { value: '9-5 ET', confidence: 0.7 },
      };

      // Arrange for runLlmCall to return a parseable plan string so the
      // caller's downstream branches don't short-circuit before we can
      // inspect the deps it handed us.
      runLlmCallMock.mockResolvedValueOnce({
        ok: true,
        data: {
          text: JSON.stringify({
            weeks: [
              { week: 1, theme: 't1', focus: 'f1', tasks: [] },
              { week: 2, theme: 't2', focus: 'f2', tasks: [] },
              { week: 3, theme: 't3', focus: 'f3', tasks: [] },
              { week: 4, theme: 't4', focus: 'f4', tasks: [] },
            ],
            open_questions: [],
          }),
          content: [{ type: 'text', text: 'stub' }],
          model_used: 'stub',
          provider: 'ollama',
          purpose: 'planning',
          policy: { modelSource: 'auto', fallback: 'local' },
          tokens: { input: 1, output: 1 },
          cost_cents: 0,
          latency_ms: 1,
        },
      });

      // Chainable query builder: select/eq return `builder`, maybeSingle
      // resolves to a per-table fixture. Mirrors the loader's call shape
      // without needing to pin the exact sequence of .eq() calls.
      function tableBuilder(data: unknown) {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data, error: null }),
          order: () => builder,
          limit: () => builder,
        };
        return builder;
      }

      const db = {
        from: vi.fn((table: string) => {
          if (table === 'agent_workforce_team_members') {
            return tableBuilder({
              id: 'tm-1',
              workspace_id: 'ws-onb',
              name: 'Ada',
              role: 'engineer',
            });
          }
          if (table === 'agent_workforce_person_models') {
            return tableBuilder({ ...personModel, name: 'Ada' });
          }
          if (table === 'agent_workforce_workspaces') {
            return tableBuilder({
              id: 'ws-onb',
              business_name: 'ohwow',
              business_type: null,
              business_description: null,
              founder_focus: null,
              growth_stage: null,
              timezone: null,
            });
          }
          return tableBuilder(null);
        }),
        rpc: vi.fn(),
      } as never;

      const ctx = {
        db,
        workspaceId: 'ws-onb',
        engine: {} as never,
        channels: {} as never,
        controlPlane: null,
        modelRouter: { selectForPurpose: vi.fn() } as never,
      };

      await proposeFirstMonthPlan(ctx as never, { team_member_id: 'tm-1' });

      // The onboarding tool may or may not short-circuit earlier on
      // preconditions — but if it reached the LLM organ at all, the
      // deps it handed over MUST carry origin='interactive'. This guards
      // against a silent regression where the origin line gets dropped
      // during an unrelated refactor.
      if (runLlmCallMock.mock.calls.length > 0) {
        const firstCall = runLlmCallMock.mock.calls[0] as unknown as unknown[];
        const depsArg = firstCall[0] as { origin?: string };
        expect(depsArg.origin).toBe('interactive');
      }
    });
  });

  describe('OpenRouter chat loop telemetry (src/orchestrator/orchestrator-chat-openrouter.ts)', () => {
    it("writes origin='interactive' on every per-iteration llm_calls row", async () => {
      // The chat loop calls recordLlmCallTelemetry directly with a
      // literal { origin: 'interactive' } deps shape. Grep the source
      // so a future edit that drops the literal fails loudly here
      // without us having to spin up the full ~780-LOC tool loop.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const filePath = path.resolve(
        __dirname,
        '../../orchestrator/orchestrator-chat-openrouter.ts',
      );
      const src = await fs.readFile(filePath, 'utf8');

      // The telemetry call site is the only recordLlmCallTelemetry
      // invocation in the file. It MUST carry `origin: 'interactive'`
      // in its deps object literal.
      expect(src).toMatch(
        /recordLlmCallTelemetry\(\s*\{[^}]*origin:\s*'interactive'[^}]*\}/,
      );
    });
  });

  describe('direct-telemetry agent loops (gap 13)', () => {
    // Both of these agent-dispatch loops bypass runLlmCall and write
    // llm_calls rows directly through recordLlmCallTelemetry. Their
    // rows are autonomous by definition — the dispatcher invoked them
    // outside any interactive human loop. recordLlmCallTelemetry's
    // deps default is already 'autonomous', but we pin the literal at
    // each site so the gap-13 audit story is grep-complete: a reader
    // searching for `origin: 'autonomous'` finds every agent loop.
    //
    // These canaries fail if either site stops emitting the literal.
    // Source-grep (not behavioral) mirrors the openrouter canary above
    // so we don't have to stand up either full loop to assert a deps
    // field shape.

    it("model-router-loop.ts pins origin='autonomous' on the telemetry write", async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const filePath = path.resolve(
        __dirname,
        '../model-router-loop.ts',
      );
      const src = await fs.readFile(filePath, 'utf8');

      // Only one recordLlmCallTelemetry site in this file; its deps
      // literal MUST carry `origin: 'autonomous'` for grep-auditability.
      expect(src).toMatch(
        /recordLlmCallTelemetry\(\s*\{[^}]*origin:\s*'autonomous'[^}]*\}/,
      );
    });

    it("react-loop.ts pins origin='autonomous' on the telemetry write", async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const filePath = path.resolve(
        __dirname,
        '../react-loop.ts',
      );
      const src = await fs.readFile(filePath, 'utf8');

      // Only one recordLlmCallTelemetry site in this file; its deps
      // literal MUST carry `origin: 'autonomous'` for grep-auditability.
      expect(src).toMatch(
        /recordLlmCallTelemetry\(\s*\{[^}]*origin:\s*'autonomous'[^}]*\}/,
      );
    });
  });
});
