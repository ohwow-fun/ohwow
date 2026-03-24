import { describe, it, expect } from 'vitest';
import { detectAnomaliesLocal } from '../anomaly-detector.js';
import type { AgentBehaviorProfile } from '../anomaly-detector.js';

function makeProfile(overrides: Partial<AgentBehaviorProfile['metrics']> = {}): AgentBehaviorProfile {
  return {
    agentId: 'agent-1',
    sampleSize: 50,
    metrics: {
      tokensPerTask: { mean: 1000, stddev: 200 },
      durationSeconds: { mean: 30, stddev: 5 },
      failureRate: 0.1,
      avgTruthScore: 0.9,
      toolFrequency: { list_tasks: 0.4, run_bash: 0.3, list_agents: 0.3 },
      ...overrides,
    },
  };
}

describe('detectAnomaliesLocal', () => {
  it('produces no alerts for normal-range values', () => {
    const profile = makeProfile();
    const alerts = detectAnomaliesLocal({
      taskId: 'task-1',
      tokensUsed: 1100, // within 1 stddev
      durationSeconds: 33, // within 1 stddev
      failed: false,
      truthScore: 0.88,
      toolsUsed: ['list_tasks', 'run_bash', 'list_agents'],
    }, profile);
    expect(alerts).toHaveLength(0);
  });

  it('generates token_spike alert above warning threshold', () => {
    const profile = makeProfile();
    // z-score = |1600 - 1000| / 200 = 3.0 >= 2.5 warning threshold
    const alerts = detectAnomaliesLocal({
      taskId: 'task-1',
      tokensUsed: 1600,
      durationSeconds: 30,
      failed: false,
      truthScore: null,
      toolsUsed: [],
    }, profile);
    const tokenAlert = alerts.find(a => a.type === 'token_spike');
    expect(tokenAlert).toBeDefined();
    expect(tokenAlert!.severity).toBe('warning');
    expect(tokenAlert!.zScore).toBeCloseTo(3.0);
  });

  it('generates critical severity for extreme token spikes', () => {
    const profile = makeProfile();
    // z-score = |1800 - 1000| / 200 = 4.0 >= 3.5 critical threshold
    const alerts = detectAnomaliesLocal({
      taskId: 'task-1',
      tokensUsed: 1800,
      durationSeconds: 30,
      failed: false,
      truthScore: null,
      toolsUsed: [],
    }, profile);
    const tokenAlert = alerts.find(a => a.type === 'token_spike');
    expect(tokenAlert).toBeDefined();
    expect(tokenAlert!.severity).toBe('critical');
  });

  it('generates duration_spike alert', () => {
    const profile = makeProfile();
    // z-score = |45 - 30| / 5 = 3.0 >= 2.5
    const alerts = detectAnomaliesLocal({
      taskId: 'task-1',
      tokensUsed: 1000,
      durationSeconds: 45,
      failed: false,
      truthScore: null,
      toolsUsed: [],
    }, profile);
    const durationAlert = alerts.find(a => a.type === 'duration_spike');
    expect(durationAlert).toBeDefined();
    expect(durationAlert!.severity).toBe('warning');
  });

  it('generates failure_spike alert when task fails with low baseline', () => {
    const profile = makeProfile({ failureRate: 0.05 });
    const alerts = detectAnomaliesLocal({
      taskId: 'task-1',
      tokensUsed: 1000,
      durationSeconds: 30,
      failed: true,
      truthScore: null,
      toolsUsed: [],
    }, profile);
    const failAlert = alerts.find(a => a.type === 'failure_spike');
    expect(failAlert).toBeDefined();
    expect(failAlert!.severity).toBe('warning');
  });

  it('does not generate failure_spike when baseline failure rate is high', () => {
    const profile = makeProfile({ failureRate: 0.6 });
    const alerts = detectAnomaliesLocal({
      taskId: 'task-1',
      tokensUsed: 1000,
      durationSeconds: 30,
      failed: true,
      truthScore: null,
      toolsUsed: [],
    }, profile);
    expect(alerts.find(a => a.type === 'failure_spike')).toBeUndefined();
  });

  it('detects quality_drop when truth score drops significantly', () => {
    const profile = makeProfile({ avgTruthScore: 0.9 });
    // The z-score uses avgTruthScore * 0.15 as stddev = 0.135
    // z = (0.9 - 0.5) / 0.135 = 2.96 >= 2
    const alerts = detectAnomaliesLocal({
      taskId: 'task-1',
      tokensUsed: 1000,
      durationSeconds: 30,
      failed: false,
      truthScore: 0.5,
      toolsUsed: [],
    }, profile);
    const qualityAlert = alerts.find(a => a.type === 'quality_drop');
    expect(qualityAlert).toBeDefined();
  });
});
