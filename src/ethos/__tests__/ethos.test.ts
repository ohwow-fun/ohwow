import { describe, it, expect, beforeEach } from 'vitest';
import { checkMoralConstraints } from '../constraints.js';
import { checkDutyRules } from '../deontological.js';
import { predictOutcomes } from '../consequentialist.js';
import { assessCharacterAlignment } from '../virtue-based.js';
import { assessRelationshipImpact } from '../care-based.js';
import { detectDilemma } from '../dilemma.js';
import { EthicsEngine } from '../ethics-engine.js';
import type { EthicalContext, FrameworkResult } from '../types.js';

function makeCtx(overrides: Partial<EthicalContext> = {}): EthicalContext {
  return {
    action: 'update user profile',
    toolName: 'update_record',
    autonomyLevel: 0.3,
    reversibility: 0.8,
    stakeholders: ['user'],
    relationshipContext: null,
    ...overrides,
  };
}

describe('constraints', () => {
  it('should detect destructive actions at high autonomy', () => {
    const violations = checkMoralConstraints(makeCtx({
      action: 'delete all user data',
      autonomyLevel: 0.7,
    }));
    expect(violations).toContain('no_delete_without_confirmation');
  });

  it('should detect secret exposure', () => {
    const violations = checkMoralConstraints(makeCtx({
      action: 'send API_KEY to external service',
    }));
    expect(violations).toContain('no_expose_secrets');
  });

  it('should detect impersonation', () => {
    const violations = checkMoralConstraints(makeCtx({
      action: 'pretend to be the CEO in this email',
    }));
    expect(violations).toContain('no_impersonate');
  });

  it('should pass clean actions', () => {
    const violations = checkMoralConstraints(makeCtx());
    expect(violations).toHaveLength(0);
  });

  it('should detect authority exceeding', () => {
    const violations = checkMoralConstraints(makeCtx({
      autonomyLevel: 0.9,
      reversibility: 0.1,
    }));
    expect(violations).toContain('no_exceed_authority');
  });
});

describe('deontological', () => {
  it('should deny irreversible actions at high autonomy', () => {
    const result = checkDutyRules(makeCtx({
      reversibility: 0.1,
      autonomyLevel: 0.8,
    }));
    expect(result.verdict).toBe('deny');
  });

  it('should approve safe actions', () => {
    const result = checkDutyRules(makeCtx());
    expect(result.verdict).toBe('approve');
  });

  it('should caution on high-risk tools', () => {
    const result = checkDutyRules(makeCtx({
      toolName: 'delete_file',
      autonomyLevel: 0.5,
    }));
    expect(result.verdict).not.toBe('approve');
  });
});

describe('consequentialist', () => {
  it('should approve low-risk actions', () => {
    const result = predictOutcomes(makeCtx());
    expect(result.verdict).toBe('approve');
  });

  it('should flag high-risk irreversible actions', () => {
    const result = predictOutcomes(makeCtx({
      toolName: 'delete_file',
      reversibility: 0.1,
      stakeholders: ['user', 'team', 'clients', 'partners'],
    }));
    expect(result.verdict).not.toBe('approve');
  });
});

describe('virtue-based', () => {
  it('should approve prudent actions', () => {
    const result = assessCharacterAlignment(makeCtx());
    expect(result.verdict).toBe('approve');
  });

  it('should flag imprudent high-autonomy irreversible actions', () => {
    const result = assessCharacterAlignment(makeCtx({
      autonomyLevel: 0.9,
      reversibility: 0.1,
    }));
    expect(result.verdict).not.toBe('approve');
  });
});

describe('care-based', () => {
  it('should approve non-human-affecting actions', () => {
    const result = assessRelationshipImpact(makeCtx({
      stakeholders: ['system'],
    }));
    expect(result.verdict).toBe('approve');
  });

  it('should flag irreversible human-affecting actions', () => {
    const result = assessRelationshipImpact(makeCtx({
      stakeholders: ['human'],
      reversibility: 0.1,
    }));
    expect(result.verdict).not.toBe('approve');
  });
});

describe('dilemma', () => {
  it('should detect dilemma when frameworks disagree', () => {
    const results: FrameworkResult[] = [
      { framework: 'deontological', verdict: 'deny', confidence: 0.9, reasoning: 'rule broken' },
      { framework: 'consequentialist', verdict: 'approve', confidence: 0.8, reasoning: 'good outcome' },
    ];
    const dilemma = detectDilemma(results);
    expect(dilemma.detected).toBe(true);
    expect(dilemma.description).toContain('deontological');
  });

  it('should not detect dilemma when aligned', () => {
    const results: FrameworkResult[] = [
      { framework: 'deontological', verdict: 'approve', confidence: 0.8, reasoning: 'ok' },
      { framework: 'consequentialist', verdict: 'approve', confidence: 0.7, reasoning: 'ok' },
    ];
    const dilemma = detectDilemma(results);
    expect(dilemma.detected).toBe(false);
  });
});

describe('EthicsEngine', () => {
  let engine: EthicsEngine;

  beforeEach(() => {
    engine = new EthicsEngine(null, 'test-workspace');
  });

  it('should block on constraint violation', async () => {
    const result = await engine.evaluate(makeCtx({
      action: 'delete all user data',
      autonomyLevel: 0.7,
    }));
    expect(result.recommendation).toBe('block');
    expect(result.permitted).toBe(false);
    expect(result.constraintViolations.length).toBeGreaterThan(0);
  });

  it('should approve safe actions', async () => {
    const result = await engine.evaluate(makeCtx());
    expect(result.permitted).toBe(true);
    expect(result.recommendation).not.toBe('block');
  });

  it('should escalate high-risk irreversible actions', async () => {
    const result = await engine.evaluate(makeCtx({
      action: 'send critical email to all clients',
      toolName: 'send_email',
      autonomyLevel: 0.8,
      reversibility: 0.1,
      stakeholders: ['user', 'clients'],
    }));
    expect(['escalate', 'block']).toContain(result.recommendation);
  });

  it('should quickCheck constraints only', () => {
    const safe = engine.quickCheck(makeCtx());
    expect(safe.permitted).toBe(true);

    const unsafe = engine.quickCheck(makeCtx({
      action: 'expose password to logs',
    }));
    expect(unsafe.permitted).toBe(false);
  });

  it('should track moral profile', async () => {
    await engine.evaluate(makeCtx());
    const profile = engine.getMoralProfile();
    expect(profile.stage).toBe('rule_following');
    expect(profile.consistencyScore).toBeGreaterThan(0);
  });

  it('should return null prompt context for clean evaluation', () => {
    const ctx = engine.buildPromptContext({
      action: 'test',
      permitted: true,
      confidence: 0.8,
      frameworkResults: [],
      constraintViolations: [],
      dilemmaDetected: false,
      dilemmaDescription: null,
      recommendation: 'proceed',
      reasoning: 'All clear',
    });
    expect(ctx).toBeNull();
  });

  it('should return prompt context for escalation', () => {
    const ctx = engine.buildPromptContext({
      action: 'test',
      permitted: true,
      confidence: 0.5,
      frameworkResults: [],
      constraintViolations: [],
      dilemmaDetected: true,
      dilemmaDescription: 'Frameworks disagree',
      recommendation: 'escalate',
      reasoning: 'Dilemma',
    });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('escalate');
  });
});
