/**
 * TEST C — executeTask browserEnabled wrap
 *
 * Verifies that executeTask wraps execModelLoop with withBrowserJob when:
 *   - browserEnabled=true AND config.workspaceName is set
 * And does NOT wrap when:
 *   - browserEnabled=false
 *   - config.workspaceName is undefined
 * Also verifies that the return value from executeTask is unchanged
 * regardless of which queue path is taken.
 *
 * Strategy: mock the entire execution pipeline so we can control
 * browserEnabled and reach the queue-decision line without hitting
 * real DB or AI calls. We spy on withBrowserJob from the module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all heavy imports that RuntimeEngine pulls in ─────────────────────

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      messages: {
        create: vi.fn().mockResolvedValue({
          usage: { input_tokens: 50, output_tokens: 50 },
          content: [{ type: 'text', text: 'test response' }],
        }),
      },
    };
  }),
}));

vi.mock('../browser/browser-job-queue.js', () => ({
  withBrowserJob: vi.fn((_ws, fn) => fn()),
}));

vi.mock('../task-capabilities.js', () => ({
  resolveTaskCapabilities: vi.fn(),
}));

vi.mock('../system-prompt.js', () => ({
  assembleSystemPrompt: vi.fn(),
}));

vi.mock('../tool-list.js', () => ({
  buildTaskToolList: vi.fn(),
}));

vi.mock('../task-completion.js', () => ({
  finalizeTaskSuccess: vi.fn(),
}));

vi.mock('../task-failure.js', () => ({
  handleTaskFailure: vi.fn(),
}));

vi.mock('../hallucination-gate.js', () => ({
  assertTaskWasGrounded: vi.fn(),
}));

vi.mock('../react-loop.js', () => ({
  runAnthropicReActLoop: vi.fn(),
}));

vi.mock('../model-router-loop.js', () => ({
  runModelRouterLoop: vi.fn(),
}));

vi.mock('../budget-guard.js', () => ({
  parseBudget: vi.fn().mockReturnValue(null),
  checkPreFlight: vi.fn(),
  isExternalProvider: vi.fn().mockReturnValue(false),
  upsertDailyResourceUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../difficulty-scorer.js', () => ({
  scoreDifficulty: vi.fn().mockReturnValue('simple'),
}));

vi.mock('../response-classifier.js', () => ({
  parseResponseMeta: vi.fn().mockReturnValue({ type: 'informational', cleanContent: 'done' }),
}));

vi.mock('../memory-sync.js', () => ({
  extractMemories: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/telemetry.js', () => ({
  withSpan: vi.fn((_name, _attrs, fn) => fn()),
}));

vi.mock('../../lib/rag/retrieval.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveKnowledgeChunks: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../lib/prompt-injection.js', () => ({
  wrapUserData: vi.fn((s: string) => s),
}));

vi.mock('../../symbiosis/synapse-dynamics.js', () => ({
  strengthenSynapse: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../llm-cache.js', () => ({
  LocalLLMCache: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('../adapters/index.js', () => ({
  executeWithClaudeCodeCli: vi.fn(),
  isClaudeCodeCliAvailable: vi.fn().mockReturnValue(false),
  buildSkillsDir: vi.fn(),
  createSessionStore: vi.fn().mockReturnValue(null),
}));

vi.mock('../browser/index.js', () => ({
  LocalBrowserService: vi.fn(),
}));

vi.mock('../desktop/index.js', () => ({
  LocalDesktopService: vi.fn(),
}));

vi.mock('../scrapling/index.js', () => ({
  ScraplingService: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('../semaphore.js', () => ({
  Semaphore: vi.fn().mockImplementation(function () {
    return {
      active: 0,
      waiting: 0,
      concurrency: 3,
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      rejectAll: vi.fn().mockReturnValue(0),
    };
  }),
}));

vi.mock('../filesystem/index.js', () => ({
  FileAccessGuard: vi.fn(),
}));

vi.mock('../doc-mounts/index.js', () => ({
  DocMountManager: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('../../mcp/index.js', () => ({
  McpClientManager: vi.fn(),
}));

vi.mock('../../orchestrator/error-recovery.js', () => ({
  CircuitBreaker: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('../../brain/brain.js', () => ({
  Brain: vi.fn().mockImplementation(function () { return { modelRouter: null }; }),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../tool-dispatch/index.js', () => ({
  createDefaultToolRegistry: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
    getToolDefinitions: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../message-summarization.js', () => ({
  getContextLimit: vi.fn().mockReturnValue(100000),
}));

// ── Now import what we actually test ───────────────────────────────────────

import { withBrowserJob } from '../browser/browser-job-queue.js';
import { resolveTaskCapabilities } from '../task-capabilities.js';
import { assembleSystemPrompt } from '../system-prompt.js';
import { buildTaskToolList } from '../tool-list.js';
import { finalizeTaskSuccess } from '../task-completion.js';
import { handleTaskFailure } from '../task-failure.js';
import { RuntimeEngine } from '../engine.js';
import type { EngineConfig, RuntimeEffects, BusinessContext } from '../types.js';

const mockWithBrowserJob = vi.mocked(withBrowserJob);
const mockResolveTaskCapabilities = vi.mocked(resolveTaskCapabilities);
const mockAssembleSystemPrompt = vi.mocked(assembleSystemPrompt);
const mockBuildTaskToolList = vi.mocked(buildTaskToolList);
const mockFinalizeTaskSuccess = vi.mocked(finalizeTaskSuccess);
const mockHandleTaskFailure = vi.mocked(handleTaskFailure);

// ── DB mock factory ────────────────────────────────────────────────────────

function makeDb(agentOverrides = {}, taskOverrides = {}) {
  const agentRow = {
    id: 'agent-1',
    workspace_id: 'ws-local',
    name: 'Test Agent',
    role: 'assistant',
    system_prompt: 'You are helpful.',
    config: JSON.stringify({ autonomy_level: 2 }),
    status: 'idle',
    stats: '{}',
    autonomy_budget: null,
    ...agentOverrides,
  };

  const taskRow = {
    id: 'task-1',
    agent_id: 'agent-1',
    title: 'Test Task',
    description: 'Do something',
    input: 'test input',
    output: null,
    status: 'pending',
    contact_ids: '[]',
    goal_id: null,
    parent_task_id: null,
    metadata: null,
    deferred_action: null,
    ...taskOverrides,
  };

  const makeQuery = (row: Record<string, unknown> | null) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    single: vi.fn().mockResolvedValue({ data: row, error: null }),
  });

  return {
    from: vi.fn((table: string) => {
      if (table === 'agent_workforce_agents') {
        return {
          ...makeQuery(agentRow),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        };
      }
      if (table === 'agent_workforce_tasks') {
        return {
          ...makeQuery(taskRow),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        };
      }
      if (table === 'agent_workforce_task_messages') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      };
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

function makeEngineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    anthropicApiKey: 'sk-test-key',
    defaultModel: 'claude-sonnet-4-5',
    maxToolLoopIterations: 10,
    browserHeadless: true,
    ...overrides,
  };
}

const mockEffects: RuntimeEffects = {
  reportToCloud: vi.fn().mockResolvedValue(undefined),
};

const mockBusinessCtx: BusinessContext = {
  businessName: 'Test Biz',
  businessType: 'saas_startup',
};

const FINAL_RESULT = {
  success: true,
  taskId: 'task-1',
  status: 'completed' as const,
  output: 'done',
  tokensUsed: 100,
  costCents: 1,
};

beforeEach(() => {
  vi.clearAllMocks();

  // Set up default mocks for the happy path
  mockResolveTaskCapabilities.mockResolvedValue({
    browserEnabled: false,
    bashEnabled: false,
    approvalRequired: false,
    autonomyLevel: 2,
    fileAccessGuard: null,
    desktopOptions: undefined,
  } as unknown as Awaited<ReturnType<typeof resolveTaskCapabilities>>);

  mockAssembleSystemPrompt.mockResolvedValue({
    systemPrompt: 'You are helpful.',
    activeSessionId: undefined,
  } as unknown as Awaited<ReturnType<typeof assembleSystemPrompt>>);

  mockBuildTaskToolList.mockResolvedValue({
    tools: [],
    mcpClients: null,
  } as unknown as Awaited<ReturnType<typeof buildTaskToolList>>);

  mockFinalizeTaskSuccess.mockResolvedValue(FINAL_RESULT);
  mockHandleTaskFailure.mockResolvedValue({
    success: false,
    taskId: 'task-1',
    status: 'failed' as const,
    tokensUsed: 0,
    costCents: 0,
  });

  // Default withBrowserJob: just call fn()
  mockWithBrowserJob.mockImplementation((_ws, fn) => fn());
});

// ── TEST C-1: browserEnabled=true + workspaceName set → withBrowserJob called
describe('C-1: executeTask wraps with withBrowserJob when browserEnabled + workspaceName', () => {
  it('calls withBrowserJob when browserEnabled=true and config.workspaceName is set', async () => {
    mockResolveTaskCapabilities.mockResolvedValue({
      browserEnabled: true,
      bashEnabled: false,
      approvalRequired: false,
      autonomyLevel: 2,
      fileAccessGuard: null,
      desktopOptions: undefined,
    } as unknown as Awaited<ReturnType<typeof resolveTaskCapabilities>>);

    const db = makeDb();
    const engine = new RuntimeEngine(
      db as unknown as ConstructorParameters<typeof RuntimeEngine>[0],
      makeEngineConfig({ workspaceName: 'default' }),
      mockEffects,
      mockBusinessCtx,
    );

    await engine.executeTask('agent-1', 'task-1');

    expect(mockWithBrowserJob).toHaveBeenCalledTimes(1);
    expect(mockWithBrowserJob).toHaveBeenCalledWith('default', expect.any(Function));
  });
});

// ── TEST C-2: browserEnabled=false → withBrowserJob NOT called
describe('C-2: executeTask does NOT wrap when browserEnabled=false', () => {
  it('does not call withBrowserJob when browserEnabled=false', async () => {
    mockResolveTaskCapabilities.mockResolvedValue({
      browserEnabled: false,
      bashEnabled: false,
      approvalRequired: false,
      autonomyLevel: 2,
      fileAccessGuard: null,
      desktopOptions: undefined,
    } as unknown as Awaited<ReturnType<typeof resolveTaskCapabilities>>);

    const db = makeDb();
    const engine = new RuntimeEngine(
      db as unknown as ConstructorParameters<typeof RuntimeEngine>[0],
      makeEngineConfig({ workspaceName: 'default' }),
      mockEffects,
      mockBusinessCtx,
    );

    await engine.executeTask('agent-1', 'task-1');

    expect(mockWithBrowserJob).not.toHaveBeenCalled();
  });
});

// ── TEST C-3: workspaceName=undefined → withBrowserJob NOT called
describe('C-3: executeTask does NOT wrap when config.workspaceName is undefined', () => {
  it('does not call withBrowserJob when workspaceName is undefined', async () => {
    mockResolveTaskCapabilities.mockResolvedValue({
      browserEnabled: true,
      bashEnabled: false,
      approvalRequired: false,
      autonomyLevel: 2,
      fileAccessGuard: null,
      desktopOptions: undefined,
    } as unknown as Awaited<ReturnType<typeof resolveTaskCapabilities>>);

    const db = makeDb();
    const engine = new RuntimeEngine(
      db as unknown as ConstructorParameters<typeof RuntimeEngine>[0],
      makeEngineConfig({ workspaceName: undefined }),
      mockEffects,
      mockBusinessCtx,
    );

    await engine.executeTask('agent-1', 'task-1');

    expect(mockWithBrowserJob).not.toHaveBeenCalled();
  });
});

// ── TEST C-4: return value is unchanged regardless of queue path
describe('C-4: return value unchanged regardless of queue path', () => {
  it('returns FINAL_RESULT via the withBrowserJob path (browserEnabled=true + workspaceName)', async () => {
    // This test verifies the return value is not mutated by the queue wrapper.
    // The three cases in C-1/C-2/C-3 cover the conditional logic; here we
    // assert the actual value flows through correctly on the browser path.
    mockResolveTaskCapabilities.mockResolvedValue({
      browserEnabled: true,
      bashEnabled: false,
      approvalRequired: false,
      autonomyLevel: 2,
      fileAccessGuard: null,
      desktopOptions: undefined,
    } as unknown as Awaited<ReturnType<typeof resolveTaskCapabilities>>);
    mockFinalizeTaskSuccess.mockResolvedValue(FINAL_RESULT);

    const db = makeDb();
    const engine = new RuntimeEngine(
      db as unknown as ConstructorParameters<typeof RuntimeEngine>[0],
      makeEngineConfig({ workspaceName: 'default' }),
      mockEffects,
      mockBusinessCtx,
    );

    const result = await engine.executeTask('agent-1', 'task-1');
    // withBrowserJob should transparently pass the inner result through
    expect(result).toEqual(FINAL_RESULT);
    expect(mockWithBrowserJob).toHaveBeenCalledTimes(1);
  });

  it('returns FINAL_RESULT via the direct path (browserEnabled=false)', async () => {
    // browserEnabled=false → no withBrowserJob, result still comes from finalizeTaskSuccess
    mockResolveTaskCapabilities.mockResolvedValue({
      browserEnabled: false,
      bashEnabled: false,
      approvalRequired: false,
      autonomyLevel: 2,
      fileAccessGuard: null,
      desktopOptions: undefined,
    } as unknown as Awaited<ReturnType<typeof resolveTaskCapabilities>>);
    mockFinalizeTaskSuccess.mockResolvedValue(FINAL_RESULT);

    const db = makeDb();
    const engine = new RuntimeEngine(
      db as unknown as ConstructorParameters<typeof RuntimeEngine>[0],
      makeEngineConfig({ workspaceName: 'default' }),
      mockEffects,
      mockBusinessCtx,
    );

    const result = await engine.executeTask('agent-1', 'task-1');
    expect(result).toEqual(FINAL_RESULT);
    expect(mockWithBrowserJob).not.toHaveBeenCalled();
  });
});
