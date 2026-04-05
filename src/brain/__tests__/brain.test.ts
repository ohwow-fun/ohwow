/**
 * Brain Module Unit Tests
 *
 * Tests the core cognitive modules: ExperienceStream, PredictiveEngine,
 * enrichIntent, SelfModelBuilder, and GlobalWorkspace.
 *
 * All modules are pure logic — no mocks needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ExperienceStream } from '../experience-stream.js';
import { PredictiveEngine } from '../predictive-engine.js';
import { enrichIntent } from '../intentionality.js';
import { SelfModelBuilder } from '../self-model.js';
import { GlobalWorkspace } from '../global-workspace.js';
import type { ClassifiedIntent } from '../../orchestrator/orchestrator-types.js';
import type { Experience } from '../types.js';

// ============================================================================
// ExperienceStream
// ============================================================================

describe('ExperienceStream', () => {
  let stream: ExperienceStream;

  beforeEach(() => {
    stream = new ExperienceStream({ capacity: 10 });
  });

  it('append() adds experiences to the ring buffer', () => {
    stream.append('tool_executed', { toolName: 'scrape_url', success: true }, 'orchestrator');
    expect(stream.size()).toBe(1);
    expect(stream.totalExperiences()).toBe(1);
  });

  it('getRecent() returns experiences in chronological order', () => {
    stream.append('tool_executed', { toolName: 'a' }, 'orchestrator');
    stream.append('tool_executed', { toolName: 'b' }, 'orchestrator');
    stream.append('tool_executed', { toolName: 'c' }, 'orchestrator');

    const recent = stream.getRecent(3);
    expect(recent).toHaveLength(3);
    expect((recent[0].data as { toolName: string }).toolName).toBe('a');
    expect((recent[1].data as { toolName: string }).toolName).toBe('b');
    expect((recent[2].data as { toolName: string }).toolName).toBe('c');
  });

  it('query() filters by type', () => {
    stream.append('tool_executed', { toolName: 'a' }, 'orchestrator');
    stream.append('prediction_error', { delta: 0.5 }, 'orchestrator');
    stream.append('tool_executed', { toolName: 'b' }, 'orchestrator');

    const toolExecs = stream.query({ types: ['tool_executed'] });
    expect(toolExecs).toHaveLength(2);
    for (const exp of toolExecs) {
      expect(exp.type).toBe('tool_executed');
    }
  });

  it('query() filters by source', () => {
    stream.append('tool_executed', { toolName: 'a' }, 'orchestrator');
    stream.append('tool_executed', { toolName: 'b' }, 'engine');
    stream.append('tool_executed', { toolName: 'c' }, 'orchestrator');

    const engineOnly = stream.query({ sources: ['engine'] });
    expect(engineOnly).toHaveLength(1);
    expect(engineOnly[0].source).toBe('engine');
  });

  it('query() filters by time range', () => {
    const now = Date.now();
    stream.append('tool_executed', { toolName: 'old' }, 'orchestrator');

    // Manually manipulate to simulate time passage
    const _recent = stream.getRecent(1);
    // The experience was just created, so query with after = now - 1 should find it
    const results = stream.query({ after: now - 1000 });
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Query with after = future should find nothing
    const futureResults = stream.query({ after: now + 10000 });
    expect(futureResults).toHaveLength(0);
  });

  it('getToolSuccessRate() computes correctly', () => {
    stream.append('tool_executed', { toolName: 'scrape_url', success: true }, 'orchestrator');
    stream.append('tool_executed', { toolName: 'scrape_url', success: true }, 'orchestrator');
    stream.append('tool_executed', { toolName: 'scrape_url', success: false }, 'orchestrator');

    const { rate, total } = stream.getToolSuccessRate('scrape_url');
    expect(total).toBe(3);
    expect(rate).toBeCloseTo(2 / 3, 5);
  });

  it('getToolSuccessRate() returns 0.5 with no data', () => {
    const { rate, total } = stream.getToolSuccessRate('nonexistent_tool');
    expect(total).toBe(0);
    expect(rate).toBe(0.5);
  });

  it('getPredictionAccuracy() returns 0.5 with no data', () => {
    expect(stream.getPredictionAccuracy()).toBe(0.5);
  });

  it('getPredictionAccuracy() computes from prediction errors', () => {
    // delta=0 means prediction was correct, accuracy should be high
    stream.append('prediction_error', { delta: 0 }, 'orchestrator');
    stream.append('prediction_error', { delta: 0 }, 'orchestrator');
    // accuracy = 1 - avg(0, 0) = 1.0
    expect(stream.getPredictionAccuracy()).toBe(1.0);

    // Add a fully wrong prediction
    stream.append('prediction_error', { delta: 1 }, 'orchestrator');
    // accuracy = 1 - avg(0, 0, 1) = 1 - 1/3 ≈ 0.667
    expect(stream.getPredictionAccuracy()).toBeCloseTo(2 / 3, 5);
  });

  it('ring buffer wraps correctly when full (capacity overflow)', () => {
    const smallStream = new ExperienceStream({ capacity: 3 });

    smallStream.append('tool_executed', { toolName: 'first' }, 'orchestrator');
    smallStream.append('tool_executed', { toolName: 'second' }, 'orchestrator');
    smallStream.append('tool_executed', { toolName: 'third' }, 'orchestrator');
    // This should overwrite 'first'
    smallStream.append('tool_executed', { toolName: 'fourth' }, 'orchestrator');

    expect(smallStream.size()).toBe(3);
    expect(smallStream.totalExperiences()).toBe(4);

    const recent = smallStream.getRecent(3);
    expect(recent).toHaveLength(3);
    const names = recent.map(e => (e.data as { toolName: string }).toolName);
    expect(names).toEqual(['second', 'third', 'fourth']);
  });

  it('listeners fire on append', () => {
    const received: Experience[] = [];
    stream.on('tool_executed', (exp) => {
      received.push(exp);
    });

    stream.append('tool_executed', { toolName: 'a' }, 'orchestrator');
    stream.append('prediction_error', { delta: 0.5 }, 'orchestrator'); // should not fire
    stream.append('tool_executed', { toolName: 'b' }, 'orchestrator');

    expect(received).toHaveLength(2);
    expect((received[0].data as { toolName: string }).toolName).toBe('a');
    expect((received[1].data as { toolName: string }).toolName).toBe('b');
  });

  it('wildcard listener fires on all appends', () => {
    const received: Experience[] = [];
    stream.on('*', (exp) => {
      received.push(exp);
    });

    stream.append('tool_executed', { toolName: 'a' }, 'orchestrator');
    stream.append('prediction_error', { delta: 0.5 }, 'engine');

    expect(received).toHaveLength(2);
  });

  it('unsubscribe stops listener from firing', () => {
    const received: Experience[] = [];
    const unsub = stream.on('tool_executed', (exp) => {
      received.push(exp);
    });

    stream.append('tool_executed', { toolName: 'a' }, 'orchestrator');
    expect(received).toHaveLength(1);

    unsub();
    stream.append('tool_executed', { toolName: 'b' }, 'orchestrator');
    expect(received).toHaveLength(1); // still 1, listener removed
  });
});

// ============================================================================
// PredictiveEngine
// ============================================================================

describe('PredictiveEngine', () => {
  let stream: ExperienceStream;
  let engine: PredictiveEngine;

  beforeEach(() => {
    stream = new ExperienceStream({ capacity: 100 });
    engine = new PredictiveEngine(stream);
  });

  it('predict() returns low confidence with no data', () => {
    const prediction = engine.predict('scrape_url', { url: 'https://example.com' });
    expect(prediction.confidence).toBeLessThanOrEqual(0.2);
    expect(prediction.expectedResult).toBe('success'); // optimistic default
    expect(prediction.basis).toBe('insufficient data');
  });

  it('after update() with failures, predict() returns failure', () => {
    const toolName = 'scrape_url';
    const input = { url: 'https://broken.com' };

    // Feed 4 failures to exceed MIN_DATA_POINTS (3)
    for (let i = 0; i < 4; i++) {
      const pred = engine.predict(toolName, input);
      engine.update(pred, toolName, input, { success: false, data: 'error' } as never);
    }

    const finalPrediction = engine.predict(toolName, input);
    expect(finalPrediction.expectedResult).toBe('failure');
    expect(finalPrediction.confidence).toBeGreaterThan(0.5);
  });

  it('isStagnating() detects 3 identical tool calls', () => {
    const toolName = 'scrape_url';
    const input = { url: 'https://example.com' };

    // Not stagnating initially
    expect(engine.isStagnating()).toBe(false);

    // Feed 3 identical tool calls (same name + input = same hash)
    for (let i = 0; i < 3; i++) {
      const pred = engine.predict(toolName, input);
      engine.update(pred, toolName, input, { success: false, data: 'error' } as never);
    }

    expect(engine.isStagnating()).toBe(true);
  });

  it('buildStagnationWarning() includes tool name and suggestion', () => {
    const toolName = 'scrape_url';
    const input = { url: 'https://failing.com' };

    // Generate some failures to populate experience stream
    for (let i = 0; i < 4; i++) {
      const pred = engine.predict(toolName, input);
      engine.update(pred, toolName, input, { success: false, data: 'error' } as never);
    }

    const warning = engine.buildStagnationWarning();
    expect(warning).toContain('scrape_url');
    expect(warning).toContain('failed');
    // scrape_url has alternatives defined (deep_research, scrape_search)
    expect(warning).toMatch(/Try using|Try a completely different/);
  });

  it('buildStagnationWarning() returns generic message with no failures', () => {
    const warning = engine.buildStagnationWarning();
    expect(warning).toContain('repeating the same actions');
  });

  it('suggestAlternative() returns best-success-rate alternative', () => {
    // Record some successes for deep_research so it becomes the preferred alternative
    for (let i = 0; i < 4; i++) {
      const pred = engine.predict('deep_research', { query: 'test' });
      engine.update(pred, 'deep_research', { query: 'test' }, { success: true, data: 'ok' } as never);
    }

    const alt = engine.suggestAlternative('scrape_url');
    // scrape_url alternatives are: deep_research, scrape_search
    // deep_research has 100% success rate, scrape_search has 0.5 (no data)
    expect(alt).toBe('deep_research');
  });

  it('suggestAlternative() returns null for unknown tool', () => {
    const alt = engine.suggestAlternative('unknown_tool');
    expect(alt).toBeNull();
  });

  it('contextual success rate tracks per-domain failures', () => {
    const toolName = 'scrape_url';

    // Feed enough data points for contextual tracking
    for (let i = 0; i < 4; i++) {
      const pred = engine.predict(toolName, { url: 'https://broken.com/page' + i });
      engine.update(pred, toolName, { url: 'https://broken.com/page' + i }, { success: false, data: 'err' } as never);
    }

    // The context key for scrape_url is the hostname
    const rate = engine.getContextualSuccessRate(toolName, 'broken.com');
    expect(rate).not.toBeNull();
    expect(rate!).toBe(0); // 0 successes out of 4 attempts
  });

  it('getToolSuccessRate() returns 0.5 for unknown tool', () => {
    expect(engine.getToolSuccessRate('never_used')).toBe(0.5);
  });
});

// ============================================================================
// enrichIntent
// ============================================================================

describe('enrichIntent', () => {
  function makeClassified(intent: string, sections: string[] = []): ClassifiedIntent {
    return {
      intent,
      sections: new Set(sections) as Set<import('../../orchestrator/tool-definitions.js').IntentSection>,
      statusLabel: 'test',
      planFirst: false,
      mode: 'orchestrator' as never,
    };
  }

  it('enriches classified intent with horizon', () => {
    const classified = makeClassified('task', ['agents']);
    const enriched = enrichIntent(classified, 'create a new agent task');

    expect(enriched.horizon).toBeDefined();
    expect(enriched.horizon.expectedNextAction).toBeTruthy();
    expect(enriched.confidence).toBeGreaterThan(0);
  });

  it('detects implied context from keywords (automation -> agents sections)', () => {
    const classified = makeClassified('general', []);
    const enriched = enrichIntent(classified, 'set up an automation workflow for email');

    expect(enriched.horizon.impliedContext.length).toBeGreaterThan(0);
    expect(enriched.horizon.impliedContext.some(c => c.includes('automation'))).toBe(true);
    // Pre-warm sections should include agents (from automation keyword)
    expect(enriched.horizon.preWarmSections).toContain('agents');
  });

  it('detects uncertainties from hedging words', () => {
    const classified = makeClassified('task', ['agents']);
    const enriched = enrichIntent(classified, 'maybe I should create an agent, not sure');

    expect(enriched.horizon.uncertainties.length).toBeGreaterThan(0);
    expect(enriched.horizon.uncertainties.some(u => u.includes('uncertainty'))).toBe(true);
  });

  it('confidence is 0.5 for general intent', () => {
    const classified = makeClassified('general', []);
    const enriched = enrichIntent(classified, 'hello');

    expect(enriched.confidence).toBe(0.5);
  });

  it('confidence is 0.75+ for specific intents', () => {
    const classified = makeClassified('task', ['agents']);
    const enriched = enrichIntent(classified, 'create a new task for the sales agent');

    expect(enriched.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('pre-warms sections from horizon', () => {
    // 'research' intent should pre-warm 'rag' and 'browser' sections
    const classified = makeClassified('research', ['rag']);
    const enriched = enrichIntent(classified, 'research the latest AI trends');

    // 'browser' should be pre-warmed (from NEXT_TURN_PREDICTIONS for research)
    expect(enriched.horizon.preWarmSections).toContain('browser');
    // The merged sections should include both original and pre-warmed
    expect(enriched.sections.has('rag')).toBe(true);
    expect(enriched.sections.has('browser')).toBe(true);
  });

  it('boosts confidence with supporting conversation history', () => {
    const classified = makeClassified('file', ['filesystem']);
    const withoutHistory = enrichIntent(classified, 'edit the config file');
    const withHistory = enrichIntent(classified, 'edit the config file', [
      { role: 'user', content: 'show me the file list' },
      { role: 'assistant', content: 'Here are the files in the code directory...' },
    ]);

    expect(withHistory.confidence).toBeGreaterThan(withoutHistory.confidence);
  });
});

// ============================================================================
// SelfModelBuilder
// ============================================================================

describe('SelfModelBuilder', () => {
  let stream: ExperienceStream;
  let builder: SelfModelBuilder;

  const defaultDeps = {
    activeModel: 'qwen3:4b',
    modelCapabilities: ['tool_calling'],
    tokenBudgetRemaining: 4096,
    limitations: [],
    currentLoad: 0,
  };

  beforeEach(() => {
    stream = new ExperienceStream({ capacity: 100 });
    builder = new SelfModelBuilder(stream);
  });

  it('build() returns valid SelfModel', () => {
    const model = builder.build(defaultDeps);

    expect(model.activeModel).toBe('qwen3:4b');
    expect(model.modelCapabilities).toEqual(['tool_calling']);
    expect(model.tokenBudgetRemaining).toBe(4096);
    expect(model.confidence).toBeGreaterThan(0);
    expect(model.confidence).toBeLessThanOrEqual(1);
    expect(model.toolProficiency).toBeInstanceOf(Map);
    expect(model.recentPerformance).toBeDefined();
    expect(model.recentPerformance.completionRate).toBeGreaterThanOrEqual(0);
  });

  it('recordToolUse() updates proficiency', () => {
    builder.recordToolUse('scrape_url', true, 500);
    builder.recordToolUse('scrape_url', true, 300);
    builder.recordToolUse('scrape_url', false, 1000);

    const model = builder.build(defaultDeps);
    const profile = model.toolProficiency.get('scrape_url');

    expect(profile).toBeDefined();
    expect(profile!.totalUses).toBe(3);
    expect(profile!.successRate).toBeGreaterThan(0);
    expect(profile!.avgLatencyMs).toBeGreaterThan(0);
  });

  it('getToolMastery() returns novice then familiar then mastered based on use count', () => {
    // Initially novice
    expect(builder.getToolMastery('test_tool')).toBe('novice');

    // Record 20 uses to reach 'familiar' threshold
    for (let i = 0; i < 20; i++) {
      builder.recordToolUse('test_tool', true, 100);
    }
    expect(builder.getToolMastery('test_tool')).toBe('familiar');

    // Record 30 more to reach 'mastered' threshold (total 50)
    for (let i = 0; i < 30; i++) {
      builder.recordToolUse('test_tool', true, 100);
    }
    expect(builder.getToolMastery('test_tool')).toBe('mastered');
  });

  it('suggestNextTool() returns most common follow-up', () => {
    // No data yet
    expect(builder.suggestNextTool('scrape_url')).toBeNull();

    // Record scrape_url followed by deep_research 5 times (> 30% of uses)
    for (let i = 0; i < 5; i++) {
      builder.recordToolUse('scrape_url', true, 200, 'deep_research');
    }

    expect(builder.suggestNextTool('scrape_url')).toBe('deep_research');
  });

  it('suggestNextTool() returns null when pattern is not strong enough', () => {
    // Record many uses with various follow-ups (none dominant)
    for (let i = 0; i < 10; i++) {
      builder.recordToolUse('scrape_url', true, 200, `tool_${i}`);
    }

    // Each follow-up is 1/10 = 10%, below the 30% threshold
    expect(builder.suggestNextTool('scrape_url')).toBeNull();
  });
});

// ============================================================================
// GlobalWorkspace
// ============================================================================

describe('GlobalWorkspace', () => {
  let workspace: GlobalWorkspace;

  beforeEach(() => {
    workspace = new GlobalWorkspace();
  });

  it('broadcast() adds items', () => {
    workspace.broadcast({
      source: 'agent-1',
      type: 'discovery',
      content: 'Found a new pattern',
      salience: 0.8,
      timestamp: Date.now(),
    });

    expect(workspace.size()).toBe(1);
  });

  it('getConscious() returns highest-salience items', () => {
    workspace.broadcast({
      source: 'agent-1',
      type: 'discovery',
      content: 'Low salience item',
      salience: 0.2,
      timestamp: Date.now(),
    });
    workspace.broadcast({
      source: 'agent-2',
      type: 'failure',
      content: 'High salience item',
      salience: 0.9,
      timestamp: Date.now(),
    });
    workspace.broadcast({
      source: 'agent-3',
      type: 'pattern',
      content: 'Medium salience item',
      salience: 0.5,
      timestamp: Date.now(),
    });

    // Ask for top 2
    const conscious = workspace.getConscious(2);
    expect(conscious).toHaveLength(2);
    // Highest salience first
    expect(conscious[0].content).toBe('High salience item');
    expect(conscious[1].content).toBe('Medium salience item');
  });

  it('getConscious() respects filter', () => {
    workspace.broadcast({
      source: 'agent-1',
      type: 'discovery',
      content: 'A discovery',
      salience: 0.9,
      timestamp: Date.now(),
    });
    workspace.broadcast({
      source: 'agent-2',
      type: 'failure',
      content: 'A failure',
      salience: 0.8,
      timestamp: Date.now(),
    });

    const failures = workspace.getConscious(10, { types: ['failure'] });
    expect(failures).toHaveLength(1);
    expect(failures[0].type).toBe('failure');
  });

  it('subscribe() fires callback on matching broadcasts', () => {
    const received: string[] = [];

    workspace.subscribe(
      { types: ['failure'] },
      (item) => { received.push(item.content); },
    );

    workspace.broadcast({
      source: 'agent-1',
      type: 'discovery',
      content: 'Not a failure',
      salience: 0.5,
      timestamp: Date.now(),
    });

    workspace.broadcast({
      source: 'agent-2',
      type: 'failure',
      content: 'Tool crashed',
      salience: 0.8,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('Tool crashed');
  });

  it('subscribe() respects source filter', () => {
    const received: string[] = [];

    workspace.subscribe(
      { sources: ['self-improvement'] },
      (item) => { received.push(item.content); },
    );

    workspace.broadcast({
      source: 'agent-1',
      type: 'pattern',
      content: 'From agent',
      salience: 0.5,
      timestamp: Date.now(),
    });

    workspace.broadcast({
      source: 'self-improvement',
      type: 'pattern',
      content: 'From self-improvement',
      salience: 0.5,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('From self-improvement');
  });

  it('unsubscribe stops callback from firing', () => {
    const received: string[] = [];

    const unsub = workspace.subscribe(
      {},
      (item) => { received.push(item.content); },
    );

    workspace.broadcast({
      source: 'a',
      type: 'signal',
      content: 'first',
      salience: 0.5,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);

    unsub();

    workspace.broadcast({
      source: 'a',
      type: 'signal',
      content: 'second',
      salience: 0.5,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1); // still 1
  });

  it('convenience methods create properly typed items', () => {
    workspace.broadcastFailure('engine', 'scrape_url', 'timeout', 0.9);
    workspace.broadcastPattern('self-improvement', 'users ask about CRM on Mondays', 0.6);
    workspace.broadcastSignal('cron', 'daily digest ready', 0.7);

    expect(workspace.size()).toBe(3);

    const items = workspace.getConscious(10);
    const types = items.map(i => i.type);
    expect(types).toContain('failure');
    expect(types).toContain('pattern');
    expect(types).toContain('signal');
  });
});
