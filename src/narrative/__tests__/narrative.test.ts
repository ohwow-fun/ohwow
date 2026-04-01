import { describe, it, expect, beforeEach } from 'vitest';
import { classifyEpisode, detectArcPattern, shouldCloseEpisode } from '../emplotment.js';
import { computeCharacterDevelopment, deriveTraits } from '../character.js';
import { assessNarrativeCoherence } from '../coherence.js';
import { NarrativeEngine } from '../narrative-engine.js';
import type { NarrativeEvent, NarrativeEpisode, StoryType } from '../types.js';

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    timestamp: new Date().toISOString(),
    description: 'completed a task',
    significance: 0.5,
    affect: null,
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<NarrativeEpisode> = {}): NarrativeEpisode {
  return {
    id: 'ep-1',
    storyType: 'breakthrough',
    title: 'Test Episode',
    phase: 'middle',
    events: [makeEvent()],
    moral: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    emotionalArc: [0.5],
    ...overrides,
  };
}

describe('classifyEpisode', () => {
  it('should classify first episode as origin', () => {
    const events = [makeEvent()];
    expect(classifyEpisode(events, [0.5], true)).toBe('origin');
  });

  it('should classify negative-to-positive arc as failure_and_recovery', () => {
    const events = [makeEvent(), makeEvent()];
    expect(classifyEpisode(events, [0.2, 0.8], false)).toBe('failure_and_recovery');
  });

  it('should classify sustained positive as mastery', () => {
    const events = [makeEvent(), makeEvent()];
    expect(classifyEpisode(events, [0.8, 0.9], false)).toBe('mastery');
  });

  it('should classify high significance mixed arc as struggle', () => {
    const events = [makeEvent({ significance: 0.8 }), makeEvent({ significance: 0.9 })];
    expect(classifyEpisode(events, [0.5, 0.4], false)).toBe('struggle');
  });

  it('should classify collaboration keywords as collaboration', () => {
    const events = [makeEvent({ description: 'worked together with the team' })];
    expect(classifyEpisode(events, [0.5, 0.6], false)).toBe('collaboration');
  });

  it('should default to breakthrough', () => {
    const events = [makeEvent({ significance: 0.3 })];
    expect(classifyEpisode(events, [0.5, 0.5], false)).toBe('breakthrough');
  });
});

describe('detectArcPattern', () => {
  it('should detect ascending arc', () => {
    expect(detectArcPattern([0.3, 0.5, 0.7])).toBe('ascending');
  });

  it('should detect descending arc', () => {
    expect(detectArcPattern([0.8, 0.6, 0.4])).toBe('descending');
  });

  it('should detect valley arc', () => {
    expect(detectArcPattern([0.7, 0.2, 0.6])).toBe('valley');
  });

  it('should detect peak arc', () => {
    expect(detectArcPattern([0.3, 0.8, 0.4])).toBe('peak');
  });

  it('should detect flat arc', () => {
    expect(detectArcPattern([0.5, 0.5, 0.5])).toBe('flat');
  });

  it('should return flat for single value', () => {
    expect(detectArcPattern([0.5])).toBe('flat');
  });
});

describe('shouldCloseEpisode', () => {
  it('should close after max events', () => {
    const events = Array.from({ length: 20 }, () => makeEvent());
    expect(shouldCloseEpisode(makeEpisode({ events }))).toBe(true);
  });

  it('should close stale episodes', () => {
    const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const events = [makeEvent({ timestamp: staleTimestamp })];
    expect(shouldCloseEpisode(makeEpisode({ events }))).toBe(true);
  });

  it('should close episodes with moral set', () => {
    expect(shouldCloseEpisode(makeEpisode({ moral: 'Patience pays off' }))).toBe(true);
  });

  it('should keep fresh active episodes open', () => {
    expect(shouldCloseEpisode(makeEpisode())).toBe(false);
  });
});

describe('deriveTraits', () => {
  it('should map story counts to traits', () => {
    const counts: Record<StoryType, number> = {
      origin: 0, struggle: 5, breakthrough: 2, mastery: 0,
      collaboration: 3, failure_and_recovery: 1,
    };
    const traits = deriveTraits(counts);
    expect(traits[0]).toBe('resilient');  // struggle is highest
    expect(traits).toContain('collaborative');
    expect(traits).toContain('innovative');
  });

  it('should return empty for zero counts', () => {
    const counts: Record<StoryType, number> = {
      origin: 0, struggle: 0, breakthrough: 0, mastery: 0,
      collaboration: 0, failure_and_recovery: 0,
    };
    expect(deriveTraits(counts)).toHaveLength(0);
  });
});

describe('computeCharacterDevelopment', () => {
  it('should return default profile for no episodes', () => {
    const profile = computeCharacterDevelopment([], 'TestBot');
    expect(profile.identity).toContain('TestBot');
    expect(profile.coreTraits).toHaveLength(0);
  });

  it('should derive traits from story type frequency', () => {
    const episodes = [
      makeEpisode({ storyType: 'struggle' }),
      makeEpisode({ storyType: 'struggle', id: 'ep-2' }),
      makeEpisode({ storyType: 'breakthrough', id: 'ep-3' }),
    ];
    const profile = computeCharacterDevelopment(episodes, 'AgentX');
    expect(profile.coreTraits).toContain('resilient');
    expect(profile.identity).toContain('AgentX');
  });

  it('should identify defining moments by significance', () => {
    const episodes = [
      makeEpisode({
        id: 'ep-1',
        title: 'Big moment',
        events: [makeEvent({ significance: 0.9 })],
      }),
      makeEpisode({
        id: 'ep-2',
        title: 'Small moment',
        events: [makeEvent({ significance: 0.2 })],
      }),
    ];
    const profile = computeCharacterDevelopment(episodes, 'AgentX');
    expect(profile.definingMoments[0]).toBe('Big moment');
  });
});

describe('assessNarrativeCoherence', () => {
  it('should give high score for consistent actions', () => {
    const character = {
      identity: 'I am an agent that perseveres.',
      coreTraits: ['resilient', 'perseverant'],
      definingMoments: [],
      currentArc: 'struggle' as StoryType,
      narrativeCoherence: 0.8,
    };
    const episodes = [makeEpisode({ storyType: 'struggle' })];
    const result = assessNarrativeCoherence('try again and persist', character, episodes);
    expect(result.coherenceScore).toBeGreaterThan(0.5);
  });

  it('should give low score for contradictory actions', () => {
    const character = {
      identity: 'I am an agent that perseveres.',
      coreTraits: ['resilient'],
      definingMoments: [],
      currentArc: 'struggle' as StoryType,
      narrativeCoherence: 0.8,
    };
    const episodes = [makeEpisode({ storyType: 'struggle' })];
    const result = assessNarrativeCoherence('give up on everything', character, episodes);
    expect(result.coherenceScore).toBeLessThan(0.5);
    expect(result.suggestion).not.toBeNull();
  });
});

describe('NarrativeEngine', () => {
  let engine: NarrativeEngine;

  beforeEach(() => {
    engine = new NarrativeEngine(null, 'ws-test', 'TestBot');
  });

  it('should start episode, record events, and close with moral', async () => {
    const episode = await engine.startEpisode('Learning to test', 'struggle');
    expect(episode.phase).toBe('beginning');

    await engine.recordEvent(makeEvent({ description: 'first attempt' }), 'struggle');
    await engine.recordEvent(makeEvent({ description: 'second attempt' }), 'struggle');

    await engine.closeEpisode(episode.id, 'Testing requires patience');

    const state = engine.getState();
    expect(state.activeEpisodes).toHaveLength(0);
    expect(state.completedEpisodeCount).toBe(1);
  });

  it('should generate story of self', async () => {
    await engine.startEpisode('First steps', 'origin');
    await engine.recordEvent(makeEvent({ description: 'came online' }), 'origin');

    const story = engine.getStoryOfSelf();
    expect(story).toContain('TestBot');
    expect(story).toContain('First steps');
  });

  it('should return null buildPromptContext when no episodes', () => {
    expect(engine.buildPromptContext()).toBeNull();
  });

  it('should return text buildPromptContext when active episodes exist', async () => {
    await engine.startEpisode('Active arc', 'mastery');

    const ctx = engine.buildPromptContext();
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('Narrative Identity');
    expect(ctx).toContain('Active arc');
  });

  it('should auto-start new episode for events without active episodes', async () => {
    const episode = await engine.recordEvent(
      makeEvent({ description: 'spontaneous event', significance: 0.7 }),
    );
    expect(episode).toBeDefined();
    expect(episode.events).toHaveLength(1);

    const state = engine.getState();
    expect(state.activeEpisodes.length + state.completedEpisodeCount).toBeGreaterThan(0);
  });

  it('should respect MAX_ACTIVE_EPISODES limit', async () => {
    await engine.startEpisode('Episode 1', 'struggle');
    await engine.startEpisode('Episode 2', 'mastery');
    await engine.startEpisode('Episode 3', 'breakthrough');
    // This 4th should close the oldest
    await engine.startEpisode('Episode 4', 'collaboration');

    const state = engine.getState();
    expect(state.activeEpisodes).toHaveLength(3);
    expect(state.completedEpisodeCount).toBe(1);
  });
});
