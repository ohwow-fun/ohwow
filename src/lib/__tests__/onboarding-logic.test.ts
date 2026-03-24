import { describe, it, expect } from 'vitest';
import {
  parseAgentRecommendations,
  getStaticRecommendations,
  getPresetsForBusinessType,
  getBusinessTypes,
  presetToAgent,
  buildAgentDiscoveryPrompt,
} from '../onboarding-logic.js';

describe('parseAgentRecommendations', () => {
  it('parses agents from ```agents block', () => {
    const response = 'Here are my recommendations:\n```agents\n["scout", "writer"]\n```';
    expect(parseAgentRecommendations(response)).toEqual(['scout', 'writer']);
  });

  it('falls back to JSON array in text', () => {
    const response = 'I recommend ["scout", "analyst"] for your business.';
    expect(parseAgentRecommendations(response)).toEqual(['scout', 'analyst']);
  });

  it('returns empty array for no valid JSON', () => {
    expect(parseAgentRecommendations('No agents here.')).toEqual([]);
  });

  it('filters out non-string values', () => {
    const response = '```agents\n["valid", 123, null]\n```';
    expect(parseAgentRecommendations(response)).toEqual(['valid']);
  });

  it('handles invalid JSON in agents block gracefully', () => {
    const response = '```agents\nnot json\n```\n["fallback"]';
    expect(parseAgentRecommendations(response)).toEqual(['fallback']);
  });
});

describe('getStaticRecommendations', () => {
  it('returns recommended presets for a known business type', () => {
    const types = getBusinessTypes();
    if (types.length === 0) return;
    const firstType = types[0];
    const recommendations = getStaticRecommendations(firstType.id);
    // Should return only recommended agents
    for (const r of recommendations) {
      expect(r.recommended).toBe(true);
    }
  });

  it('returns empty array for unknown business type', () => {
    expect(getStaticRecommendations('nonexistent_type_xyz')).toEqual([]);
  });
});

describe('getPresetsForBusinessType', () => {
  it('returns presets for a known business type', () => {
    const types = getBusinessTypes();
    if (types.length === 0) return;
    const presets = getPresetsForBusinessType(types[0].id);
    expect(presets.length).toBeGreaterThan(0);
  });

  it('returns empty array for unknown business type', () => {
    expect(getPresetsForBusinessType('unknown_xyz')).toEqual([]);
  });
});

describe('getBusinessTypes', () => {
  it('returns a non-empty array of business types', () => {
    const types = getBusinessTypes();
    expect(types.length).toBeGreaterThan(0);
  });

  it('each type has id, label, and agents', () => {
    const types = getBusinessTypes();
    for (const t of types) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('label');
      expect(t).toHaveProperty('agents');
    }
  });
});

describe('presetToAgent', () => {
  it('converts a preset to an AgentToCreate', () => {
    const preset = {
      id: 'test-agent',
      name: 'Test Agent',
      role: 'Tester',
      description: 'Runs tests',
      systemPrompt: 'You are a test agent.',
      tools: ['run_tests'],
      recommended: false,
    };
    const agent = presetToAgent(preset);
    expect(agent.id).toBe('test-agent');
    expect(agent.name).toBe('Test Agent');
    expect(agent.role).toBe('Tester');
    expect(agent.systemPrompt).toBe('You are a test agent.');
    expect(agent.tools).toEqual(['run_tests']);
    expect(agent.department).toBeUndefined();
  });

  it('includes department when provided', () => {
    const preset = {
      id: 'x',
      name: 'X',
      role: 'Y',
      description: '',
      systemPrompt: '',
      tools: [],
      recommended: false,
    };
    const agent = presetToAgent(preset, 'Engineering');
    expect(agent.department).toBe('Engineering');
  });
});

describe('buildAgentDiscoveryPrompt', () => {
  it('includes business type and founder path in prompt', () => {
    const types = getBusinessTypes();
    if (types.length === 0) return;
    const presets = getPresetsForBusinessType(types[0].id);
    const prompt = buildAgentDiscoveryPrompt(types[0].id, 'just_starting', 'growth', presets);
    expect(prompt).toContain(types[0].label);
    expect(prompt).toContain('Just starting');
    expect(prompt).toContain('growth');
  });

  it('lists available agents', () => {
    const types = getBusinessTypes();
    if (types.length === 0) return;
    const presets = getPresetsForBusinessType(types[0].id);
    const prompt = buildAgentDiscoveryPrompt(types[0].id, 'exploring', '', presets);
    for (const p of presets) {
      expect(prompt).toContain(p.id);
    }
  });
});
