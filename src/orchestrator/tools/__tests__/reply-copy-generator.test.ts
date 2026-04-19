import { describe, it, expect, vi } from 'vitest';
import {
  voiceCheck,
  buildReplySystemPrompt,
  drafterModeForClass,
  generateReplyCopy,
  type ReplyMode,
} from '../reply-copy-generator.js';
import type { ModelRouter } from '../../../execution/model-router.js';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';
import type { RuntimeEngine } from '../../../execution/engine.js';
import type { ReplyCandidate } from '../reply-target-selector.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `runLlmCall` is the only I/O bridge `generateReplyCopy` uses. Mocking
// it lets tests either (a) assert the bridge is NEVER called (skip-mode
// short-circuit) or (b) drive deterministic model output into the
// no-question gate without a real model round-trip.
vi.mock('../../../execution/llm-organ.js', () => ({
  runLlmCall: vi.fn(),
}));
import { runLlmCall } from '../../../execution/llm-organ.js';

const runLlmCallMock = vi.mocked(runLlmCall);

describe('voiceCheck', () => {
  describe('first-person pronouns', () => {
    const firstPersonCases: Array<[string, string]> = [
      ["I've lost so many threads trying to switch models mid-convo", 'firstPerson:I-contraction'],
      ['I tried this and it worked', 'firstPerson:I'],
      ["I'm not sure that tracks", 'firstPerson:I-contraction'],
      ['that happened to me once', 'firstPerson:me'],
      ['my experience says otherwise', 'firstPerson:my'],
      ['the failure mode is mine to track', 'firstPerson:mine'],
      ['we end up with merge conflicts', 'firstPerson:we'],
      ['throws us off', 'firstPerson:us'],
      ['in our stack the bottleneck is auth', 'firstPerson:our'],
    ];
    for (const [text, expected] of firstPersonCases) {
      it(`rejects "${text.slice(0, 50)}..." for ${expected}`, () => {
        const result = voiceCheck(text, 'x');
        expect(result.ok).toBe(false);
        expect(result.reasons).toContain(expected);
      });
    }

    it('allows lowercase "i" in "interesting" (word-boundary match)', () => {
      // The I/me/my patterns use word boundaries so they don't fire
      // on legitimate words. This is the common false-positive case.
      const result = voiceCheck('that is an interesting angle on the problem', 'x');
      expect(result.reasons.filter((r) => r.startsWith('firstPerson'))).toEqual([]);
    });
  });

  describe('fake-experience phrasing', () => {
    it('rejects "you end up spending more time..."', () => {
      const result = voiceCheck('you end up spending more time reconciling agent decisions', 'x');
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('fakeExperience:you-end-up');
    });

    it('rejects "in my experience"', () => {
      // Already caught by firstPerson:my, but fakeExperience adds a
      // second explicit reason for the clearer log message.
      const result = voiceCheck('in my experience that only works at low QPS', 'x');
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('fakeExperience:my-experience');
    });

    it('rejects "when you try"', () => {
      const result = voiceCheck('when you try parallel branches the merge gets ugly', 'x');
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('fakeExperience:when-you-try');
    });
  });

  describe('structural forbidden', () => {
    it('rejects em dashes', () => {
      const result = voiceCheck('the bottleneck — not auth — is context rot', 'x');
      expect(result.reasons).toContain('emDash');
    });

    it('rejects "please"', () => {
      const result = voiceCheck('consider using a verifier please', 'x');
      expect(result.reasons).toContain('please');
    });

    it('rejects hashtags', () => {
      const result = voiceCheck('context rot is underrated #LLMs', 'x');
      expect(result.reasons).toContain('hashtag');
    });

    it('rejects trailing period', () => {
      const result = voiceCheck('confidence without a verifier is the default failure mode.', 'x');
      expect(result.reasons).toContain('trailingPeriod');
    });
  });

  describe('clean drafts pass', () => {
    const cleanDrafts = [
      'confidence without a verifier is the default failure mode of LLM agents right now',
      'compaction is the quiet one. most long-running agents die from it, not lack of checkpoints',
      'parallel execution plus shared memory is the real fork in the road',
    ];
    for (const text of cleanDrafts) {
      it(`passes observational draft "${text.slice(0, 60)}..."`, () => {
        const result = voiceCheck(text, 'x');
        expect(result.ok).toBe(true);
        expect(result.reasons).toEqual([]);
      });
    }
  });

  describe('length', () => {
    it('rejects X drafts over 240 chars', () => {
      const long = 'a'.repeat(241);
      const result = voiceCheck(long, 'x');
      expect(result.reasons.some((r) => r.startsWith('length'))).toBe(true);
    });

    it('allows Threads drafts up to 280 chars', () => {
      const threads = 'a'.repeat(280);
      const result = voiceCheck(threads, 'threads');
      expect(result.reasons.filter((r) => r.startsWith('length'))).toEqual([]);
    });
  });
});

// -----------------------------------------------------------------------
// Prompt builder — first-principles prose. The April-18 rewrite removed
// every literal BEFORE/AFTER, arrow template, and bracketed shape menu
// because the model was copying those wholesale. These tests assert on
// semantic content the prompts MUST carry under the new spec, not on
// specific phrasings that will drift as the prose is tuned.
// -----------------------------------------------------------------------

describe('buildReplySystemPrompt — first-principles semantics', () => {
  // Every reply-drafting mode that actually builds a prompt. 'skip' is
  // excluded because it short-circuits in generateReplyCopy before any
  // prompt is built (and the builder throws for that mode on purpose).
  const promptModes: readonly Exclude<ReplyMode, 'skip'>[] = [
    'direct',
    'viral',
    'buyer_intent',
    'praise',
  ] as const;

  describe('no question-mark contamination in any prompt', () => {
    // The no-question rule is a first-principles rule, not mode-specific.
    // If a prompt body contains '?' the model will echo it. The ONLY
    // question marks allowed in the prompt text are those introducing
    // the rule itself ("must not contain the character \"?\" anywhere")
    // — this test excludes the explicit quoted mention from the check.
    for (const mode of promptModes) {
      it(`${mode} prompt contains no rogue '?' examples`, () => {
        const p = buildReplySystemPrompt('x', mode);
        // Strip the two intentional literal-char references to the
        // banned character: `"?"` (quoted) and the parenthetical
        // banned-char clause. Anything else is a leak.
        const stripped = p
          .replace(/"\?"/g, '')
          .replace(/character\s+"\?"/g, '');
        expect(stripped.includes('?'), `leak in ${mode}:\n${p}`).toBe(false);
      });
    }
  });

  describe('no example arrow notation (BEFORE/AFTER/=>)', () => {
    // The old prompts taught the model by showing AFTER: -> phrasing.
    // The model ablated the examples into its own drafts. First-
    // principles rewrite dropped all of them; this test freezes that.
    for (const mode of promptModes) {
      it(`${mode} prompt carries no arrow templates`, () => {
        const p = buildReplySystemPrompt('x', mode);
        expect(p).not.toMatch(/BEFORE:/);
        expect(p).not.toMatch(/AFTER:/);
        expect(p).not.toMatch(/=>/);
        // ASCII arrow '->' is also a giveaway of BEFORE/AFTER style.
        expect(p).not.toMatch(/\s->\s/);
      });
    }
  });

  describe('direct mode — observational scroller, no product', () => {
    it('names the anonymous-scroller speaker model', () => {
      const p = buildReplySystemPrompt('x', 'direct');
      expect(p).toContain('SPEAKER MODEL');
      expect(p).toContain('anonymous scroller');
    });

    it('bans product mention for the non-buyer branch', () => {
      const p = buildReplySystemPrompt('x', 'direct');
      expect(p).toContain('NO PRODUCT MENTION');
      expect(p).toContain('ohwow');
    });

    it('states the no-question rule explicitly', () => {
      const p = buildReplySystemPrompt('x', 'direct');
      expect(p).toMatch(/Not a question/);
    });

    it('default mode is direct', () => {
      const withoutMode = buildReplySystemPrompt('x');
      const direct = buildReplySystemPrompt('x', 'direct');
      expect(withoutMode).toBe(direct);
    });
  });

  describe('viral mode — crowd-targeting, with hiring collapse', () => {
    it('addresses the scrolling crowd, not the poster', () => {
      const p = buildReplySystemPrompt('x', 'viral');
      expect(p).toMatch(/crowd/i);
      expect(p).toMatch(/POSTER is not/i);
    });

    it('collapses to the buyer-intent shape when the viral post scopes hiring', () => {
      const p = buildReplySystemPrompt('x', 'viral');
      expect(p).toContain('CONDITIONAL COLLAPSE');
      expect(p).toContain('buyer-intent shape');
      expect(p).toContain('ohwow.fun');
    });

    it('uses the right platform length cap', () => {
      const xp = buildReplySystemPrompt('x', 'viral');
      const tp = buildReplySystemPrompt('threads', 'viral');
      expect(xp).toContain('240');
      expect(tp).toContain('280');
    });
  });

  describe('buyer_intent mode — names ohwow.fun exactly, forbids probes', () => {
    it('requires the literal string "ohwow.fun" in the prompt body', () => {
      const p = buildReplySystemPrompt('x', 'buyer_intent');
      // The prompt itself must instruct the model to emit "ohwow.fun"
      // — not just "ohwow". This is the primary buyer-intent rule.
      expect(p).toContain('ohwow.fun');
    });

    it('frames money flowing FROM the poster outward', () => {
      const p = buildReplySystemPrompt('x', 'buyer_intent');
      // Money-direction is the first-principles reason this class
      // exists at all. Freeze it in the prompt. `[\s\S]` allows
      // the phrase to wrap across the prompt's hard line breaks
      // ("Money is\nflowing FROM the poster outward").
      expect(p).toMatch(/money\s+is\s+flowing/i);
      expect(p).toMatch(/budget/i);
    });

    it('bans qualification probes', () => {
      const p = buildReplySystemPrompt('x', 'buyer_intent');
      // The model used to respond with "what's your budget" style
      // sales-qualification questions; the prompt must forbid that
      // shape in addition to the '?' gate.
      expect(p).toMatch(/probe/i);
    });
  });

  describe('praise mode — ICP-peer affirmation, no pitch', () => {
    it('bans product mention', () => {
      const p = buildReplySystemPrompt('x', 'praise');
      expect(p).toContain('NO PRODUCT MENTION');
      expect(p).toContain('ohwow');
    });

    it('bans advice and "have you tried" probes', () => {
      const p = buildReplySystemPrompt('x', 'praise');
      expect(p).toMatch(/No advice/i);
      expect(p).toMatch(/have you tried/i);
    });

    it('anchors on the anonymous-scroller speaker model', () => {
      const p = buildReplySystemPrompt('x', 'praise');
      expect(p).toContain('SPEAKER MODEL');
      expect(p).toContain('anonymous scroller');
    });
  });

  it('throws when called with mode=skip (scheduler must short-circuit)', () => {
    // The skip class is a routing decision, not a prompt. Reaching
    // the builder with it indicates a wiring bug and should fail loud.
    expect(() => buildReplySystemPrompt('x', 'skip')).toThrow(/skip/);
  });
});

// -----------------------------------------------------------------------
// Class routing — the spine of skip-class enforcement. solo_service_
// provider and genuine_pain MUST route to 'skip' so no draft is
// generated. Everything else stays on the observational direct drafter.
// -----------------------------------------------------------------------

describe('drafterModeForClass', () => {
  it('viral-mode query always stays viral', () => {
    expect(drafterModeForClass('viral', 'genuine_pain')).toBe('viral');
    expect(drafterModeForClass('viral', 'buyer_intent')).toBe('viral');
    expect(drafterModeForClass('viral', 'adjacent_prospect')).toBe('viral');
    expect(drafterModeForClass('viral', 'solo_service_provider')).toBe('viral');
  });

  it('direct-mode query routes buyer_intent → buyer_intent drafter', () => {
    expect(drafterModeForClass('direct', 'buyer_intent')).toBe('buyer_intent');
  });

  it('direct-mode query routes adjacent_prospect → praise drafter', () => {
    expect(drafterModeForClass('direct', 'adjacent_prospect')).toBe('praise');
  });

  // First-principles: both classes represent posts where no draft should
  // ever be generated. solo_service_provider pits ohwow against the
  // exact person it would otherwise serve; genuine_pain has no scoped
  // work to engage. The scheduler short-circuits on mode='skip'.
  it('direct-mode query routes solo_service_provider → skip', () => {
    expect(drafterModeForClass('direct', 'solo_service_provider')).toBe('skip');
  });

  it('direct-mode query routes genuine_pain → skip', () => {
    expect(drafterModeForClass('direct', 'genuine_pain')).toBe('skip');
  });

  it('direct-mode query on other classes stays on default direct drafter', () => {
    expect(drafterModeForClass('direct', 'ai_seller')).toBe('direct');
    expect(drafterModeForClass('direct', 'ai_enthusiast')).toBe('direct');
    expect(drafterModeForClass('direct', 'consultant_pitch')).toBe('direct');
    expect(drafterModeForClass('direct', 'generic_noise')).toBe('direct');
    expect(drafterModeForClass('direct', 'unknown_class_string')).toBe('direct');
  });
});

// -----------------------------------------------------------------------
// generateReplyCopy — the behavior sits in three branches:
//   1. mode='skip' short-circuits with {draft:'SKIP'} BEFORE any LLM
//      call (freeze this — it's the whole point of skip-class routing).
//   2. A parsed LLM response containing '?' fails the no-question
//      gate; alternates are scanned; if none clean, the candidate
//      downgrades to SKIP.
//   3. A clean response passes through unchanged.
// -----------------------------------------------------------------------

function makeCandidate(text: string): ReplyCandidate {
  return {
    url: 'https://x.com/example/status/1',
    authorHandle: 'example',
    text,
    likes: 0,
    replies: 0,
    // The ReplyCandidate interface carries more optional fields for
    // sorting; `as` lets this test stub stay narrow.
  } as ReplyCandidate;
}

function makeDeps(modelRouter: unknown): {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
} {
  return {
    db: {} as DatabaseAdapter,
    engine: { modelRouter } as unknown as RuntimeEngine,
    workspaceId: 'ws-test',
  };
}

describe('generateReplyCopy', () => {
  describe('mode=skip short-circuit', () => {
    it('returns {ok:true, draft:"SKIP"} without invoking the LLM', async () => {
      // The whole point of skip-class routing: no LLM tokens spent on
      // solo_service_provider or genuine_pain posts. If runLlmCall runs
      // even once in this path, skip-class routing is broken.
      runLlmCallMock.mockReset();
      runLlmCallMock.mockImplementation(() => {
        throw new Error('runLlmCall MUST NOT be invoked in mode=skip');
      });

      const result = await generateReplyCopy(
        makeDeps({} as ModelRouter),
        {
          target: makeCandidate('anyone hiring a copywriter right now'),
          platform: 'x',
          mode: 'skip',
        },
      );

      expect(result.ok).toBe(true);
      expect(result.draft).toBe('SKIP');
      expect(runLlmCallMock).not.toHaveBeenCalled();
    });
  });

  describe('no-question gate', () => {
    it('promotes the first clean alternate when the primary contains "?"', async () => {
      // Primary has a question mark, first alternate is clean. Gate
      // should swap in the alternate as the new primary.
      runLlmCallMock.mockReset();
      runLlmCallMock.mockResolvedValue({
        ok: true,
        data: {
          text: JSON.stringify({
            draft: 'what is the actual constraint here?',
            alternates: [
              'compaction is the quiet one that eats long-running agents',
              'another comment also ending in a question?',
            ],
            rationale: 'test',
          }),
          model_used: 'test-model',
        },
      } as Awaited<ReturnType<typeof runLlmCall>>);

      const result = await generateReplyCopy(
        makeDeps({} as ModelRouter),
        {
          target: makeCandidate('thinking out loud about agent context windows today'),
          platform: 'x',
          mode: 'direct',
        },
      );

      expect(result.ok).toBe(true);
      expect(result.draft).toBe('compaction is the quiet one that eats long-running agents');
      expect(result.draft).not.toContain('?');
    });

    it('downgrades to SKIP when every draft contains "?"', async () => {
      // Primary + all alternates contain '?'. The gate cannot find a
      // clean draft, so the candidate SKIPs. Freezes the fallback rule.
      runLlmCallMock.mockReset();
      runLlmCallMock.mockResolvedValue({
        ok: true,
        data: {
          text: JSON.stringify({
            draft: 'what is the actual bottleneck?',
            alternates: [
              'is this really the issue?',
              'what happens when you push on it?',
            ],
            rationale: 'test',
          }),
          model_used: 'test-model',
        },
      } as Awaited<ReturnType<typeof runLlmCall>>);

      const result = await generateReplyCopy(
        makeDeps({} as ModelRouter),
        {
          target: makeCandidate('thinking out loud about agent context windows today'),
          platform: 'x',
          mode: 'direct',
        },
      );

      expect(result.ok).toBe(true);
      expect(result.draft).toBe('SKIP');
      expect(result.rationale).toMatch(/gate failed/);
      expect(result.rationale).toMatch(/question mark/);
    });

    it('lets a clean primary through unchanged', async () => {
      runLlmCallMock.mockReset();
      runLlmCallMock.mockResolvedValue({
        ok: true,
        data: {
          text: JSON.stringify({
            draft: 'context rot is the quiet killer of long-running agents',
            alternates: [],
            rationale: 'test',
          }),
          model_used: 'test-model',
        },
      } as Awaited<ReturnType<typeof runLlmCall>>);

      const result = await generateReplyCopy(
        makeDeps({} as ModelRouter),
        {
          target: makeCandidate('thinking out loud about agent context windows today'),
          platform: 'x',
          mode: 'direct',
        },
      );

      expect(result.ok).toBe(true);
      expect(result.draft).toBe('context rot is the quiet killer of long-running agents');
      expect(result.draft).not.toContain('?');
    });
  });
});
