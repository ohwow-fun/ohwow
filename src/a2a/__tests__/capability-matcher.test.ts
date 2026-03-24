import { describe, it, expect } from 'vitest';
import { matchCapabilities } from '../capability-matcher.js';
import type { CapabilityRequest } from '../capability-matcher.js';

describe('matchCapabilities', () => {
  const connections = [
    {
      id: 'conn-1',
      skills: [
        {
          id: 'skill-1',
          name: 'Content Writing',
          description: 'Write blog posts, articles, and marketing content',
          tags: ['writing', 'marketing', 'content'],
          examples: ['Write a blog post about AI trends', 'Create marketing copy for a product launch'],
        },
        {
          id: 'skill-2',
          name: 'Data Analysis',
          description: 'Analyze datasets and generate statistical reports',
          tags: ['data', 'analytics', 'statistics'],
          examples: ['Analyze quarterly sales data', 'Generate a statistical report'],
        },
      ],
    },
    {
      id: 'conn-2',
      skills: [
        {
          id: 'skill-3',
          name: 'Code Review',
          description: 'Review code for bugs, security issues, and best practices',
          tags: ['code', 'review', 'security'],
        },
      ],
    },
  ];

  it('returns empty array for empty connections', () => {
    const request: CapabilityRequest = { description: 'write a blog post' };
    expect(matchCapabilities(request, [])).toEqual([]);
  });

  it('matches by description keyword overlap', () => {
    const request: CapabilityRequest = { description: 'write blog posts about marketing' };
    const matches = matchCapabilities(request, connections);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].skillName).toBe('Content Writing');
  });

  it('matches by required tags', () => {
    const request: CapabilityRequest = {
      description: 'help with some task',
      requiredTags: ['data', 'analytics'],
    };
    const matches = matchCapabilities(request, connections);
    const dataMatch = matches.find(m => m.skillId === 'skill-2');
    expect(dataMatch).toBeDefined();
    expect(dataMatch!.matchReasons).toContain('2 tag matches');
  });

  it('matches by example similarity', () => {
    const request: CapabilityRequest = { description: 'analyze quarterly sales performance' };
    const matches = matchCapabilities(request, connections);
    const dataMatch = matches.find(m => m.skillName === 'Data Analysis');
    expect(dataMatch).toBeDefined();
    expect(dataMatch!.matchReasons.some(r => r.includes('example'))).toBe(true);
  });

  it('filters matches below threshold', () => {
    const request: CapabilityRequest = { description: 'completely unrelated quantum physics experiment' };
    const matches = matchCapabilities(request, connections);
    // All matches should have score > 0.05 (the threshold)
    for (const match of matches) {
      expect(match.score).toBeGreaterThan(0.05);
    }
  });

  it('sorts matches by score descending', () => {
    const request: CapabilityRequest = {
      description: 'write marketing content and blog posts',
      requiredTags: ['writing', 'content'],
    };
    const matches = matchCapabilities(request, connections);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
    }
  });

  it('caps scores at 1.0', () => {
    const request: CapabilityRequest = {
      description: 'write blog posts articles marketing content',
      requiredTags: ['writing', 'marketing', 'content'],
    };
    const matches = matchCapabilities(request, connections);
    for (const match of matches) {
      expect(match.score).toBeLessThanOrEqual(1.0);
    }
  });

  it('includes connection and skill IDs in results', () => {
    const request: CapabilityRequest = { description: 'review code for security issues' };
    const matches = matchCapabilities(request, connections);
    const codeMatch = matches.find(m => m.skillName === 'Code Review');
    expect(codeMatch).toBeDefined();
    expect(codeMatch!.connectionId).toBe('conn-2');
    expect(codeMatch!.skillId).toBe('skill-3');
  });
});
