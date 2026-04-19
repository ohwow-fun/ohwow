/**
 * Freeze tests for the humanization expansion (QA round 3).
 *
 * Criteria under test (plan 2026-04-19 trio):
 *  1. Each of the 12 newly added AI cliché phrases triggers voiceCheck
 *     rejection with the expected `aiCliche:<phrase>` reason.
 *  2. buildVoicePrinciples() output contains the OUTREACH DM RULES header.
 *  3. buildVoicePrinciples() FORBIDDEN block mentions a representative
 *     sample of the 12 new phrases.
 *  4. ThreadsReplyScheduler.tick() with a draft containing a cliché phrase
 *     does NOT call insertReplyDraft (belt-and-suspenders gate is wired).
 *
 * Implementation SHA: 8a653a8
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  voiceCheck,
  AI_CLICHE_PHRASES,
  buildVoicePrinciples,
} from '../voice-core.js';

// ---------------------------------------------------------------------------
// Shared context — use threads/reply so length cap never interferes with
// the short synthetic drafts used in cliché checks.
// ---------------------------------------------------------------------------
const CTX = { platform: 'threads', useCase: 'reply' } as const;

// ---------------------------------------------------------------------------
// 1. New cliché phrases — each triggers voiceCheck rejection
// ---------------------------------------------------------------------------

describe('voiceCheck — 12 newly added AI cliché phrases', () => {
  /**
   * The 12 phrases added in the humanization expansion commit (8a653a8).
   * The trailing-space variants ('empower ', 'unlock ') are stored with
   * the trailing space in AI_CLICHE_PHRASES so substring match avoids
   * false-positives on compound words; the test must reproduce that space.
   */
  const NEW_PHRASES: Array<[string, string]> = [
    ['empower ', 'empower '],
    ['dive into', 'dive into'],
    ['unlock ', 'unlock '],
    ['revolutionize', 'revolutionize'],
    ['thought leader', 'thought leader'],
    ["in today's world", "in today's world"],
    ["it's important to note", "it's important to note"],
    ['it is important to note', 'it is important to note'],
    ['i wanted to reach out', 'i wanted to reach out'],
    ['i hope this', 'i hope this'],
    ['touch base', 'touch base'],
    ['circle back', 'circle back'],
  ];

  for (const [phrase, expectedKey] of NEW_PHRASES) {
    it(`rejects a draft containing "${phrase.trim()}"`, () => {
      // Embed the phrase in a neutral sentence to avoid triggering other gates.
      const draft = `Worth considering: ${phrase}context here`;

      const result = voiceCheck(draft, CTX);

      expect(result.ok).toBe(false);
      expect(result.reasons).toContain(`aiCliche:${expectedKey}`);
    });
  }

  it('each of the 12 new phrases exists in the AI_CLICHE_PHRASES export', () => {
    const phrasesToCheck = [
      'empower ',
      'dive into',
      'unlock ',
      'revolutionize',
      'thought leader',
      "in today's world",
      "it's important to note",
      'it is important to note',
      'i wanted to reach out',
      'i hope this',
      'touch base',
      'circle back',
    ];
    for (const phrase of phrasesToCheck) {
      expect(AI_CLICHE_PHRASES, `AI_CLICHE_PHRASES should contain "${phrase}"`).toContain(phrase);
    }
  });

  it('new cliché checks are case-insensitive', () => {
    expect(voiceCheck('DIVE INTO the details', CTX).reasons).toContain('aiCliche:dive into');
    expect(voiceCheck('CIRCLE BACK tomorrow', CTX).reasons).toContain('aiCliche:circle back');
    expect(voiceCheck('TOUCH BASE next week', CTX).reasons).toContain('aiCliche:touch base');
    expect(voiceCheck('REVOLUTIONIZE the space', CTX).reasons).toContain('aiCliche:revolutionize');
  });
});

// ---------------------------------------------------------------------------
// 2. buildVoicePrinciples — OUTREACH DM RULES section present
// ---------------------------------------------------------------------------

describe('buildVoicePrinciples — OUTREACH DM RULES section', () => {
  it('contains the OUTREACH DM RULES header', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('OUTREACH DM RULES');
  });

  it('OUTREACH DM RULES section bans "Hey [Name]" opener', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('Hey [Name]');
  });

  it('OUTREACH DM RULES section bans "I wanted to reach out" as a filler bridge', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('I wanted to reach out');
  });

  it('OUTREACH DM RULES section mentions subject-line length constraint', () => {
    const principles = buildVoicePrinciples();
    // The section specifies subject lines must be under 50 chars.
    expect(principles).toContain('50 chars');
  });

  it('OUTREACH DM RULES section bans trailing period in short messages', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('trailing period');
  });
});

// ---------------------------------------------------------------------------
// 3. buildVoicePrinciples — new phrases appear in the FORBIDDEN block
// ---------------------------------------------------------------------------

describe('buildVoicePrinciples — FORBIDDEN block covers new phrases', () => {
  // Spot-check 6 of the 12 new phrases — enough to catch any editorial drop
  // without duplicating the exhaustive machine-check in criterion 1.
  const SPOT_CHECK = [
    'empower',
    'dive into',
    'thought leader',
    "in today's world",
    'touch base',
    'circle back',
  ];

  for (const phrase of SPOT_CHECK) {
    it(`FORBIDDEN block mentions "${phrase}"`, () => {
      const principles = buildVoicePrinciples();
      expect(principles).toContain(phrase);
    });
  }

  it('AI CLICHÉ WORDS label is present in FORBIDDEN block', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('AI CLICHÉ WORDS');
  });
});

// ---------------------------------------------------------------------------
// 4. ThreadsReplyScheduler — belt-and-suspenders voice gate blocks insert
// ---------------------------------------------------------------------------

// Mock every module that touches I/O so tick() runs in-process with no
// network, DB, or browser footprint.
vi.mock('../../../scheduling/threads-reply.js', () => ({
  // Re-export path: the scheduler imports from
  // '../orchestrator/tools/threads-reply.js' relative to src/scheduling/.
}));

// The scheduler lives in src/scheduling/; its imports use relative paths
// from there. We mock the exact specifiers it resolves at runtime.
vi.mock('../../../orchestrator/tools/threads-reply.js', () => ({
  scanThreadsPostsViaBrowser: vi.fn(),
  fetchThreadsPostFullText: vi.fn(),
}));

vi.mock('../../../orchestrator/tools/reply-target-selector.js', () => ({
  pickReplyTargets: vi.fn(),
  threadToCandidate: vi.fn(),
}));

vi.mock('../../../orchestrator/tools/reply-copy-generator.js', () => ({
  generateReplyCopy: vi.fn(),
  drafterModeForClass: vi.fn().mockReturnValue('direct'),
}));

vi.mock('../../../orchestrator/tools/reply-target-classifier.js', () => ({
  classifyReplyTargetsBatch: vi.fn(),
  isKeeper: vi.fn(),
}));

vi.mock('../../../scheduling/x-reply-store.js', () => ({
  insertReplyDraft: vi.fn(),
  findReplyDraftByUrl: vi.fn(),
}));

vi.mock('../../../self-bench/runtime-config.js', () => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock('../../../lib/x-search-throttle.js', () => ({
  threadsThrottleTracker: {
    isThrottled: vi.fn().mockReturnValue({ throttled: false }),
  },
}));

describe('ThreadsReplyScheduler — voice gate blocks insert for cliché draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call insertReplyDraft when draft contains "empower "', async () => {
    // Pull mocked modules after vi.mock declarations have taken effect.
    const { scanThreadsPostsViaBrowser } = await import('../../../orchestrator/tools/threads-reply.js');
    const { threadToCandidate, pickReplyTargets } = await import('../../../orchestrator/tools/reply-target-selector.js');
    const { generateReplyCopy } = await import('../../../orchestrator/tools/reply-copy-generator.js');
    const { classifyReplyTargetsBatch, isKeeper } = await import('../../../orchestrator/tools/reply-target-classifier.js');
    const { insertReplyDraft, findReplyDraftByUrl } = await import('../../../scheduling/x-reply-store.js');
    const { getRuntimeConfig } = await import('../../../self-bench/runtime-config.js');

    // Config: enabled, no approval gate, topN=1.
    vi.mocked(getRuntimeConfig).mockImplementation((key: string, def: unknown) => {
      if (key === 'threads_reply.enabled') return true;
      if (key === 'threads_reply.topn') return 1;
      if (key === 'threads_reply.approval_required') return true;
      return def;
    });

    // One candidate from the scan.
    const fakeCandidate = {
      id: 'post-1',
      url: 'https://threads.net/@user/post-1',
      text: 'Hiring a virtual assistant, need help',
      authorHandle: 'testuser',
      likes: 10,
      replies: 2,
      platform: 'threads' as const,
    };
    const { fetchThreadsPostFullText } = await import('../../../orchestrator/tools/threads-reply.js');
    vi.mocked(fetchThreadsPostFullText).mockResolvedValue('Hiring a virtual assistant, need help');

    vi.mocked(scanThreadsPostsViaBrowser).mockResolvedValue({
      success: true,
      message: 'ok',
      source: 'search:test',
      resolvedUrl: 'https://threads.net/search?q=test',
      posts: [fakeCandidate as never],
    });
    vi.mocked(threadToCandidate).mockReturnValue(fakeCandidate as never);
    vi.mocked(findReplyDraftByUrl).mockResolvedValue(null); // no existing draft
    vi.mocked(pickReplyTargets).mockReturnValue({
      accepted: [{ candidate: fakeCandidate as never, score: 80, breakdown: {}, kept: true }],
      rejected: [],
      topN: [],
      chosen: null,
    });
    vi.mocked(classifyReplyTargetsBatch).mockResolvedValue([
      { class: 'buyer_intent', confidence: 0.9, rationale: '' } as never,
    ]);
    vi.mocked(isKeeper).mockReturnValue(true);

    // The generator returns a draft that contains an AI cliché.
    vi.mocked(generateReplyCopy).mockResolvedValue({
      ok: true,
      draft: 'ohwow can empower your team to handle these tasks automatically',
      alternates: [],
    } as never);

    // Import the scheduler after mocks are in place.
    const { ThreadsReplyScheduler } = await import('../../../scheduling/threads-reply-scheduler.js');

    const mockDb = {} as never;
    const mockEngine = {} as never;

    const scheduler = new ThreadsReplyScheduler({
      db: mockDb,
      engine: mockEngine,
      workspaceId: 'ws-test',
      workspaceSlug: 'test',
      tickIntervalMs: 999_999,  // never fires automatically
      warmupMs: 999_999,
    });

    // Trigger a tick directly via the public start/stop boundary.
    // We expose tick by starting the scheduler but with a very long interval,
    // then manually exercising the internal attempt by calling tick via
    // the start path. Instead, we access the private method through type cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (scheduler as any).attempt('interval');

    // The voice gate must have blocked the insert.
    expect(vi.mocked(insertReplyDraft)).not.toHaveBeenCalled();
  });

  it('voiceCheck returns ok:false for the cliché draft that the gate would receive', () => {
    // Verify the gate decision in isolation — this is the unit-level proof
    // that the gate logic itself is correct for the empower case.
    const draft = 'ohwow can empower your team to handle these tasks automatically';
    const result = voiceCheck(draft, { platform: 'threads', useCase: 'reply' });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('aiCliche:empower ');
  });
});
