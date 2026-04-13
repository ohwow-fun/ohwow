import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  SynthesisAutoLearner,
  isAutoLearningEnabled,
} from '../synthesis-auto-learner.js';
import { makeCtx } from '../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { SynthesisCandidate } from '../synthesis-failure-detector.js';

// Mock the pipeline's three stages so the autolearner test doesn't
// touch real Chrome, real esbuild, or a real model. Each mock exposes
// a `__mock` helper so individual tests can control the outcome.
vi.mock('../../orchestrator/tools/synthesis-probe.js', () => {
  const probeSurface = vi.fn();
  return { probeSurface };
});
vi.mock('../../orchestrator/tools/synthesis-generator.js', () => {
  const generateCodeSkill = vi.fn();
  return { generateCodeSkill };
});
vi.mock('../../orchestrator/tools/synthesis-tester.js', () => {
  const testSynthesizedSkill = vi.fn();
  return { testSynthesizedSkill };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  resolveActiveWorkspace: () => ({
    name: 'default',
    dataDir: '/tmp/test-ws',
    dbPath: '/tmp/test-ws/runtime.db',
    skillsDir: '/tmp/test-ws/skills',
    compiledSkillsDir: '/tmp/test-ws/skills/.compiled',
  }),
}));

import { probeSurface } from '../../orchestrator/tools/synthesis-probe.js';
import { generateCodeSkill } from '../../orchestrator/tools/synthesis-generator.js';
import { testSynthesizedSkill } from '../../orchestrator/tools/synthesis-tester.js';

const probeMock = vi.mocked(probeSurface);
const generateMock = vi.mocked(generateCodeSkill);
const testMock = vi.mocked(testSynthesizedSkill);

function makeCandidate(overrides: Partial<SynthesisCandidate> = {}): SynthesisCandidate {
  return {
    taskId: 'task-auto-1',
    title: 'Auto-learned goal',
    description: null,
    input: null,
    tokensUsed: 80_000,
    agentId: null,
    targetUrlGuess: 'https://example.com/goal',
    reactTrace: [],
    createdAt: '2026-04-13T19:00:00Z',
    ...overrides,
  };
}

function makeLearner(bus: EventEmitter = new EventEmitter()): SynthesisAutoLearner {
  return new SynthesisAutoLearner({
    bus,
    db: {} as DatabaseAdapter,
    workspaceId: 'ws-1',
    modelRouter: {} as ModelRouter,
    toolCtx: makeCtx(),
  });
}

describe('isAutoLearningEnabled', () => {
  const originalSynth = process.env.OHWOW_ENABLE_SYNTHESIS;
  const originalAuto = process.env.OHWOW_ENABLE_AUTO_LEARNING;

  afterEach(() => {
    if (originalSynth === undefined) delete process.env.OHWOW_ENABLE_SYNTHESIS;
    else process.env.OHWOW_ENABLE_SYNTHESIS = originalSynth;
    if (originalAuto === undefined) delete process.env.OHWOW_ENABLE_AUTO_LEARNING;
    else process.env.OHWOW_ENABLE_AUTO_LEARNING = originalAuto;
  });

  it('requires both env vars to be "1"', () => {
    process.env.OHWOW_ENABLE_SYNTHESIS = '1';
    delete process.env.OHWOW_ENABLE_AUTO_LEARNING;
    expect(isAutoLearningEnabled()).toBe(false);

    process.env.OHWOW_ENABLE_AUTO_LEARNING = '1';
    delete process.env.OHWOW_ENABLE_SYNTHESIS;
    expect(isAutoLearningEnabled()).toBe(false);

    process.env.OHWOW_ENABLE_SYNTHESIS = '1';
    process.env.OHWOW_ENABLE_AUTO_LEARNING = '1';
    expect(isAutoLearningEnabled()).toBe(true);
  });
});

describe('SynthesisAutoLearner.processCandidate', () => {
  beforeEach(() => {
    probeMock.mockReset();
    generateMock.mockReset();
    testMock.mockReset();
  });

  it('skips candidates with no targetUrlGuess', async () => {
    const learner = makeLearner();
    const result = await learner.processCandidate(makeCandidate({ targetUrlGuess: null }));
    expect(result.outcome).toBe('skipped_no_url');
    expect(probeMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('bails out when the probe fails', async () => {
    probeMock.mockResolvedValue({ success: false, message: 'CDP dead' });
    const learner = makeLearner();
    const result = await learner.processCandidate(makeCandidate());
    expect(result.outcome).toBe('probe_failed');
    expect(result.reason).toBe('CDP dead');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('bails out when the generator fails', async () => {
    probeMock.mockResolvedValue({
      success: true,
      message: 'ok',
      manifest: {
        url: 'https://example.com/goal',
        pageTitle: 'example',
        testidElements: [],
        formElements: [],
        contentEditables: [],
        observations: [],
        probedAt: '2026-04-13T19:00:00Z',
      },
    });
    generateMock.mockResolvedValue({
      ok: false,
      stage: 'lint',
      error: 'forbidden import',
    });
    const learner = makeLearner();
    const result = await learner.processCandidate(makeCandidate());
    expect(result.outcome).toBe('generate_failed');
    expect(result.reason).toMatch(/lint/);
    expect(testMock).not.toHaveBeenCalled();
  });

  it('skips the tester when the generator reused an existing promoted skill', async () => {
    probeMock.mockResolvedValue({
      success: true,
      message: 'ok',
      manifest: {
        url: 'https://example.com/goal',
        pageTitle: 'example',
        testidElements: [],
        formElements: [],
        contentEditables: [],
        observations: [],
        probedAt: '2026-04-13T19:00:00Z',
      },
    });
    generateMock.mockResolvedValue({
      ok: true,
      reused: true,
      skillId: 'existing-sk',
      name: 'existing_goal',
      scriptPath: '/path/existing_goal_abc.ts',
      source: '// existing',
    });
    const learner = makeLearner();
    const result = await learner.processCandidate(makeCandidate());
    expect(result.outcome).toBe('registered');
    expect(result.skillName).toBe('existing_goal');
    expect(testMock).not.toHaveBeenCalled();
  });

  it('runs the full pipeline when generation is fresh', async () => {
    probeMock.mockResolvedValue({
      success: true,
      message: 'ok',
      manifest: {
        url: 'https://example.com/goal',
        pageTitle: 'example',
        testidElements: [],
        formElements: [],
        contentEditables: [],
        observations: [],
        probedAt: '2026-04-13T19:00:00Z',
      },
    });
    generateMock.mockResolvedValue({
      ok: true,
      skillId: 'fresh-sk',
      name: 'fresh_goal',
      scriptPath: '/path/fresh_goal_def.ts',
      source: '// fresh',
    });
    testMock.mockResolvedValue({
      ok: true,
      stage: 'promoted',
      message: 'ok',
    });
    const learner = makeLearner();
    const result = await learner.processCandidate(makeCandidate());
    expect(result.outcome).toBe('registered');
    expect(result.skillName).toBe('fresh_goal');
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(testMock).toHaveBeenCalledTimes(1);
  });

  it('records test failure but does not throw', async () => {
    probeMock.mockResolvedValue({
      success: true,
      message: 'ok',
      manifest: {
        url: 'https://example.com/goal',
        pageTitle: 'example',
        testidElements: [],
        formElements: [],
        contentEditables: [],
        observations: [],
        probedAt: '2026-04-13T19:00:00Z',
      },
    });
    generateMock.mockResolvedValue({
      ok: true,
      skillId: 'ghosted-sk',
      name: 'ghosted_goal',
      scriptPath: '/path/ghosted_goal_xyz.ts',
      source: '// ghosted',
    });
    testMock.mockResolvedValue({
      ok: false,
      stage: 'vision_reject',
      message: 'saw login wall',
    });
    const learner = makeLearner();
    const result = await learner.processCandidate(makeCandidate());
    expect(result.outcome).toBe('test_failed');
    expect(result.reason).toMatch(/vision_reject/);
  });
});

describe('SynthesisAutoLearner.start (env gating)', () => {
  const originalSynth = process.env.OHWOW_ENABLE_SYNTHESIS;
  const originalAuto = process.env.OHWOW_ENABLE_AUTO_LEARNING;

  afterEach(() => {
    if (originalSynth === undefined) delete process.env.OHWOW_ENABLE_SYNTHESIS;
    else process.env.OHWOW_ENABLE_SYNTHESIS = originalSynth;
    if (originalAuto === undefined) delete process.env.OHWOW_ENABLE_AUTO_LEARNING;
    else process.env.OHWOW_ENABLE_AUTO_LEARNING = originalAuto;
  });

  it('does NOT subscribe when env vars are not set', () => {
    delete process.env.OHWOW_ENABLE_SYNTHESIS;
    delete process.env.OHWOW_ENABLE_AUTO_LEARNING;
    const bus = new EventEmitter();
    const learner = makeLearner(bus);
    learner.start();
    expect(bus.listenerCount('synthesis:candidate')).toBe(0);
  });

  it('subscribes when both env vars are set', () => {
    process.env.OHWOW_ENABLE_SYNTHESIS = '1';
    process.env.OHWOW_ENABLE_AUTO_LEARNING = '1';
    const bus = new EventEmitter();
    const learner = makeLearner(bus);
    learner.start();
    expect(bus.listenerCount('synthesis:candidate')).toBe(1);
    learner.stop();
    expect(bus.listenerCount('synthesis:candidate')).toBe(0);
  });
});
