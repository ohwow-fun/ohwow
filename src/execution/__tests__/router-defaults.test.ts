import { describe, it, expect } from 'vitest';
import {
  ROUTER_DEFAULTS,
  SELECTABLE_MODELS,
  resolveRouterDefault,
  isSelectableModel,
  selectableModelsFor,
  type EffortLevel,
  type TaskClass,
} from '../router-defaults.js';

/**
 * Regression guard for the 2026-04-17 founder decision: Opus 4.7 is
 * opt-in only. No TaskClass default may point at `claude-opus-4-7`.
 * If a future edit flips a default, this test fails loudly. The test
 * IS the policy — the assertion captures the cost-gate contract.
 */
describe('router-defaults', () => {
  const expectedTaskClasses: readonly TaskClass[] = [
    'agentic_coding',
    'computer_use',
    'hardest_reasoning',
    'agentic_search',
    'bulk_cost_sensitive',
    'private_offline',
  ];

  it('registers a default for every known TaskClass', () => {
    for (const cls of expectedTaskClasses) {
      expect(ROUTER_DEFAULTS[cls], `missing default for ${cls}`).toBeDefined();
      expect(ROUTER_DEFAULTS[cls].model.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ROUTER_DEFAULTS).sort()).toEqual([...expectedTaskClasses].sort());
  });

  it('never defaults to claude-opus-4-7 (founder cost decision 2026-04-17)', () => {
    for (const cls of expectedTaskClasses) {
      expect(
        ROUTER_DEFAULTS[cls].model,
        `${cls} default must not be claude-opus-4-7 (opt-in only)`,
      ).not.toBe('claude-opus-4-7');
    }
  });

  it('matches the agreed default mapping', () => {
    expect(ROUTER_DEFAULTS.agentic_coding).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });
    expect(ROUTER_DEFAULTS.computer_use).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });
    expect(ROUTER_DEFAULTS.hardest_reasoning).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      effort: 'xhigh',
    });
    expect(ROUTER_DEFAULTS.agentic_search).toEqual({
      provider: 'openai',
      model: 'gpt-5.4-pro',
      effort: 'high',
    });
    expect(ROUTER_DEFAULTS.bulk_cost_sensitive).toEqual({
      provider: 'google',
      model: 'gemini-3.1-pro',
      effort: 'medium',
    });
    expect(ROUTER_DEFAULTS.private_offline).toEqual({
      provider: 'ollama',
      model: 'llama3.1',
      effort: 'medium',
    });
  });

  it('registers claude-opus-4-7 as a selectable opt-in so callers can pick it', () => {
    const classesWithOpus = (Object.keys(SELECTABLE_MODELS) as TaskClass[]).filter((cls) =>
      SELECTABLE_MODELS[cls].some((m) => m.model === 'claude-opus-4-7'),
    );
    expect(classesWithOpus.length).toBeGreaterThan(0);
    expect(classesWithOpus).toEqual(
      expect.arrayContaining(['agentic_coding', 'computer_use', 'hardest_reasoning']),
    );
  });

  it('accepts "xhigh" as a valid EffortLevel end-to-end', () => {
    const xhigh: EffortLevel = 'xhigh';
    expect(xhigh).toBe('xhigh');
    // Hardest reasoning default exercises xhigh; opt-in Opus 4.7 does too.
    expect(ROUTER_DEFAULTS.hardest_reasoning.effort).toBe('xhigh');
    const opusHardest = SELECTABLE_MODELS.hardest_reasoning.find(
      (m) => m.model === 'claude-opus-4-7',
    );
    expect(opusHardest?.effort).toBe('xhigh');
  });

  it('resolveRouterDefault returns the table entry', () => {
    expect(resolveRouterDefault('agentic_coding')).toBe(ROUTER_DEFAULTS.agentic_coding);
  });

  it('isSelectableModel validates against the allow-list per task class', () => {
    expect(isSelectableModel('agentic_coding', 'claude-opus-4-7')).toBe(true);
    expect(isSelectableModel('agentic_coding', 'claude-sonnet-4-6')).toBe(false);
    expect(isSelectableModel('bulk_cost_sensitive', 'claude-opus-4-7')).toBe(false);
  });

  it('selectableModelsFor returns only entries for the given task class', () => {
    const coding = selectableModelsFor('agentic_coding');
    expect(coding.length).toBeGreaterThan(0);
    expect(coding.every((m) => typeof m.model === 'string' && m.model.length > 0)).toBe(true);
  });
});
