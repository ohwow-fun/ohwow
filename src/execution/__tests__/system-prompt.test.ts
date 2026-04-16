import { describe, it, expect } from 'vitest';
import {
  buildAgentSystemPrompt,
  renderTaskIntentSection,
} from '../system-prompt.js';
import type { BusinessContext } from '../types.js';

const BIZ: BusinessContext = {
  businessName: 'OHWOW',
  businessType: 'ai_runtime',
  businessDescription: 'A local-first AI runtime.',
} as unknown as BusinessContext;

const BASE_OPTS = {
  agentName: 'The Voice',
  agentRole: 'Public Communications',
  agentPrompt: 'You own X/Twitter presence.',
  taskTitle: 'Post one tweet today',
};

describe('renderTaskIntentSection', () => {
  it('returns an empty string when no deferredAction is set', () => {
    expect(renderTaskIntentSection(undefined)).toBe('');
    expect(renderTaskIntentSection({ type: '' })).toBe('');
  });

  it('surfaces the exact x_compose_tweet pairing for post_tweet intents', () => {
    const section = renderTaskIntentSection({ type: 'post_tweet', provider: 'x' });
    expect(section).toContain('## Task Intent');
    expect(section).toContain('post_tweet');
    expect(section).toContain('via **x**');
    expect(section).toContain('`x_compose_tweet`');
    expect(section).toContain('Do NOT produce a markdown draft');
  });

  it('falls back to generic wording for types with no preferred tool', () => {
    const section = renderTaskIntentSection({ type: 'send_email', provider: 'gmail' });
    expect(section).toContain('send_email');
    expect(section).toContain('via **gmail**');
    // No explicit tool pair registered yet → generic wording.
    expect(section).toContain('matching tool in your tool list');
  });

  it('omits the provider clause when provider is null or absent', () => {
    const a = renderTaskIntentSection({ type: 'post_tweet', provider: null });
    const b = renderTaskIntentSection({ type: 'post_tweet' });
    expect(a).not.toContain('via **');
    expect(b).not.toContain('via **');
  });
});

describe('buildAgentSystemPrompt task-intent integration', () => {
  it('injects the Task Intent section ABOVE the Current Task block when deferredAction is set', () => {
    const prompt = buildAgentSystemPrompt(BIZ, {
      ...BASE_OPTS,
      deferredAction: { type: 'post_tweet', provider: 'x' },
    });
    const intentIdx = prompt.indexOf('## Task Intent');
    const currentIdx = prompt.indexOf('## Current Task');
    expect(intentIdx).toBeGreaterThan(-1);
    expect(currentIdx).toBeGreaterThan(-1);
    expect(intentIdx).toBeLessThan(currentIdx);
    expect(prompt).toContain('`x_compose_tweet`');
  });

  it('omits the Task Intent section when no deferredAction is set', () => {
    const prompt = buildAgentSystemPrompt(BIZ, { ...BASE_OPTS });
    expect(prompt).not.toContain('## Task Intent');
    // Current Task block still renders on its own.
    expect(prompt).toContain('## Current Task');
    expect(prompt).toContain('Post one tweet today');
  });
});
