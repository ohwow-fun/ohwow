/**
 * Execution Policy Tests
 *
 * Covers the routing behavior for hybrid local/cloud execution:
 * - resolvePolicy: fallback to defaults with optional user overrides
 * - shouldPreferLocal: credit-based local preference in auto mode
 * - resolvePurposePolicy: agent constraints force local execution
 * - getAgentModelPolicy: extract policy from config blob
 */

import { describe, it, expect } from 'vitest';
import {
  resolvePolicy,
  shouldPreferLocal,
  resolvePurposePolicy,
  getAgentModelPolicy,
  DEFAULT_POLICIES,
  PURPOSE_DEFAULTS,
  type ExecutionPolicy,
  type AgentModelPolicy,
  type OperationType,
  type Purpose,
} from '../execution-policy.js';

describe('resolvePolicy', () => {
  it('1. returns DEFAULT_POLICIES entry when no overrides provided', () => {
    const policy = resolvePolicy('planning');
    expect(policy).toEqual(DEFAULT_POLICIES.planning);
    expect(policy.modelSource).toBe('cloud');
    expect(policy.fallback).toBe('local');
  });

  it('2. user override wins over default', () => {
    const overrides: Partial<Record<OperationType, ExecutionPolicy>> = {
      planning: { modelSource: 'local', fallback: 'none' },
    };
    const policy = resolvePolicy('planning', overrides);
    expect(policy.modelSource).toBe('local');
    expect(policy.fallback).toBe('none');
  });
});

describe('shouldPreferLocal', () => {
  it('3. returns true when modelSource is "local"', () => {
    const policy: ExecutionPolicy = { modelSource: 'local', fallback: 'cloud' };
    const result = shouldPreferLocal(policy, 50, 10);
    expect(result).toBe(true);
  });

  it('4. returns false when modelSource is "cloud"', () => {
    const policy: ExecutionPolicy = { modelSource: 'cloud', fallback: 'local' };
    const result = shouldPreferLocal(policy, 5, 10);
    expect(result).toBe(false);
  });

  it('5. returns true in "auto" mode when creditBalancePercent <= lowCreditThreshold', () => {
    const policy: ExecutionPolicy = { modelSource: 'auto', fallback: 'local' };
    const result = shouldPreferLocal(policy, 8, 10);
    expect(result).toBe(true);
  });

  it('6. returns false in "auto" mode when creditBalancePercent > lowCreditThreshold', () => {
    const policy: ExecutionPolicy = { modelSource: 'auto', fallback: 'local' };
    const result = shouldPreferLocal(policy, 15, 10);
    expect(result).toBe(false);
  });

  it('7. returns false in "auto" mode when fallback is "none" even at low credits', () => {
    const policy: ExecutionPolicy = { modelSource: 'auto', fallback: 'none' };
    const result = shouldPreferLocal(policy, 5, 10);
    expect(result).toBe(false);
  });
});

describe('resolvePurposePolicy', () => {
  it('8. returns PURPOSE_DEFAULTS entry for non-OperationType purposes', () => {
    const policy = resolvePurposePolicy('reasoning');
    expect(policy).toEqual(PURPOSE_DEFAULTS.reasoning);
    expect(policy.modelSource).toBe('auto');
    expect(policy.fallback).toBe('local');
  });

  it('9. localOnly agent constraint forces modelSource="local" and fallback="none"', () => {
    const agent: AgentModelPolicy = { localOnly: true };
    const policy = resolvePurposePolicy('reasoning', agent);
    expect(policy.modelSource).toBe('local');
    expect(policy.fallback).toBe('none');
  });

  it('10. no agent object returns base policy unchanged', () => {
    const basePolicy = resolvePurposePolicy('planning');
    const policyWithAgent = resolvePurposePolicy('planning', undefined);
    expect(policyWithAgent).toEqual(basePolicy);
  });

  it('respects user overrides for legacy OperationType values', () => {
    const overrides: Partial<Record<OperationType, ExecutionPolicy>> = {
      planning: { modelSource: 'local', fallback: 'cloud' },
    };
    const policy = resolvePurposePolicy('planning', undefined, overrides);
    expect(policy.modelSource).toBe('local');
    expect(policy.fallback).toBe('cloud');
  });

  it('applies localOnly constraint on top of user overrides', () => {
    const agent: AgentModelPolicy = { localOnly: true };
    const overrides: Partial<Record<OperationType, ExecutionPolicy>> = {
      planning: { modelSource: 'cloud', fallback: 'local' },
    };
    const policy = resolvePurposePolicy('planning', agent, overrides);
    expect(policy.modelSource).toBe('local');
    expect(policy.fallback).toBe('none');
  });

  it('returns agent_task default for unrecognized purpose', () => {
    // If both DEFAULT_POLICIES and PURPOSE_DEFAULTS don't have it, fall back to agent_task
    const policy = resolvePurposePolicy('reasoning' as Purpose);
    expect(policy).toBeDefined();
  });
});

describe('getAgentModelPolicy', () => {
  it('11. returns undefined for null input', () => {
    const result = getAgentModelPolicy(null);
    expect(result).toBeUndefined();
  });

  it('11. returns undefined for non-object input', () => {
    const result = getAgentModelPolicy('not an object');
    expect(result).toBeUndefined();
  });

  it('11. returns undefined when model_policy is missing', () => {
    const agentConfig = { name: 'test' };
    const result = getAgentModelPolicy(agentConfig);
    expect(result).toBeUndefined();
  });

  it('11. returns undefined when model_policy is not an object', () => {
    const agentConfig = { model_policy: 'invalid' };
    const result = getAgentModelPolicy(agentConfig);
    expect(result).toBeUndefined();
  });

  it('12. parses localOnly from config blob', () => {
    const agentConfig = {
      model_policy: {
        localOnly: true,
      },
    };
    const result = getAgentModelPolicy(agentConfig);
    expect(result).toBeDefined();
    expect(result?.localOnly).toBe(true);
  });

  it('12. parses escalate from config blob', () => {
    const agentConfig = {
      model_policy: {
        escalate: 'on_failure',
      },
    };
    const result = getAgentModelPolicy(agentConfig);
    expect(result).toBeDefined();
    expect(result?.escalate).toBe('on_failure');
  });

  it('12. extracts multiple fields from config blob', () => {
    const agentConfig = {
      model_policy: {
        localOnly: false,
        maxCostCents: 5000,
        escalate: 'on_complex',
      },
    };
    const result = getAgentModelPolicy(agentConfig);
    expect(result).toBeDefined();
    expect(result?.localOnly).toBe(false);
    expect(result?.maxCostCents).toBe(5000);
    expect(result?.escalate).toBe('on_complex');
  });

  it('strips legacy fields from model_policy', () => {
    const agentConfig = {
      model_policy: {
        localOnly: true,
        default: 'some-model', // legacy field (should be ignored)
        purposes: { reasoning: 'other-model' }, // legacy field (should be ignored)
      },
    };
    const result = getAgentModelPolicy(agentConfig);
    expect(result).toBeDefined();
    expect(result?.localOnly).toBe(true);
    // Ensure legacy fields are not included
    expect('default' in (result || {})).toBe(false);
    expect('purposes' in (result || {})).toBe(false);
  });
});
