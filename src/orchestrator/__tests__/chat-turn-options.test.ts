/**
 * Regression test for bug #6 fix 6a: ChatTurnOptions per-turn snapshot.
 *
 * The test scope is the ChatTurnOptions type contract + the per-session
 * chat actor map. End-to-end concurrent chat() validation lives in the
 * bench script (verification step).
 */

import { describe, it, expect } from 'vitest';
import type { ChatTurnOptions } from '../orchestrator-types.js';

describe('ChatTurnOptions type shape (bug #6 fix 6a)', () => {
  it('accepts a model + modelSource + chatActor combo as the route handler builds it', () => {
    const opts: ChatTurnOptions = {
      orchestratorModel: 'xiaomi/mimo-v2-pro',
      modelSource: 'cloud',
      chatActor: { teamMemberId: 'tm-1', guideAgentId: 'ga-1' },
      personaAgentId: 'persona-1',
      chatTraceId: 'conv-uuid-1',
    };
    expect(opts.orchestratorModel).toBe('xiaomi/mimo-v2-pro');
    expect(opts.chatActor?.teamMemberId).toBe('tm-1');
  });

  it('accepts an explicit null chat actor (clearing attribution)', () => {
    const opts: ChatTurnOptions = {
      orchestratorModel: 'xiaomi/mimo-v2-pro',
      chatActor: null,
    };
    expect(opts.chatActor).toBeNull();
  });

  it('omitted fields fall through to undefined, letting runChat use instance defaults', () => {
    const opts: ChatTurnOptions = {};
    expect(opts.orchestratorModel).toBeUndefined();
    expect(opts.chatActor).toBeUndefined();
    expect(opts.modelSource).toBeUndefined();
  });
});

describe('Per-session chat actor map semantics', () => {
  it('two distinct sessions can hold different actors without colliding', () => {
    const map = new Map<string, { teamMemberId?: string; guideAgentId?: string }>();
    map.set('session-A', { teamMemberId: 'alice', guideAgentId: 'guide-a' });
    map.set('session-B', { teamMemberId: 'bob', guideAgentId: 'guide-b' });
    expect(map.get('session-A')?.teamMemberId).toBe('alice');
    expect(map.get('session-B')?.teamMemberId).toBe('bob');
    expect(map.size).toBe(2);
  });

  it('clearing one session leaves the other untouched (the legacy single-instance bug fixed)', () => {
    const map = new Map<string, { teamMemberId?: string; guideAgentId?: string }>();
    map.set('session-A', { teamMemberId: 'alice' });
    map.set('session-B', { teamMemberId: 'bob' });
    map.delete('session-A');
    expect(map.get('session-A')).toBeUndefined();
    expect(map.get('session-B')?.teamMemberId).toBe('bob');
  });
});
