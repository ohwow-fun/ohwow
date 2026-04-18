import { describe, it, expect } from 'vitest';
import {
  pickReplyTargets,
  type ReplyCandidate,
  type SelectorFilters,
} from '../reply-target-selector.js';

function cand(partial: Partial<ReplyCandidate>): ReplyCandidate {
  return {
    id: partial.id ?? '1',
    url: partial.url ?? 'https://x.com/foo/status/1',
    authorHandle: partial.authorHandle ?? 'foo',
    text: partial.text ?? 'a reasonably specific post about the bottleneck in my workflow',
    replies: partial.replies ?? 2,
    likes: partial.likes ?? 5,
    reposts: partial.reposts ?? 0,
    postedAt: partial.postedAt ?? new Date().toISOString(),
    isReply: partial.isReply ?? false,
    isRepost: partial.isRepost ?? false,
  };
}

describe('pickReplyTargets — engagement floors (viral mode)', () => {
  it('drops posts below minLikes floor', () => {
    const input = {
      candidates: [
        cand({ id: 'a', likes: 5 }),     // below floor
        cand({ id: 'b', likes: 100 }),   // passes
      ],
      filters: {
        minLikes: 50,
        minReplies: 0,
        maxLikes: Number.POSITIVE_INFINITY,
        maxReplies: Number.POSITIVE_INFINITY,
      } as SelectorFilters,
      topicKeywords: [],
    };
    const out = pickReplyTargets(input);
    expect(out.accepted.map((s) => s.candidate.id)).toEqual(['b']);
    expect(out.rejected.map((r) => r.reason)).toContain('likesTooLow(5)');
  });

  it('drops posts below minReplies floor', () => {
    const input = {
      candidates: [
        cand({ id: 'a', replies: 2, likes: 100 }),   // below reply floor
        cand({ id: 'b', replies: 50, likes: 100 }),  // passes both
      ],
      filters: {
        minReplies: 10,
        maxLikes: Number.POSITIVE_INFINITY,
        maxReplies: Number.POSITIVE_INFINITY,
      } as SelectorFilters,
      topicKeywords: [],
    };
    const out = pickReplyTargets(input);
    expect(out.accepted.map((s) => s.candidate.id)).toEqual(['b']);
  });

  it('allows posts that would fail direct-mode maxLikes when viral caps are ∞', () => {
    const input = {
      candidates: [cand({ id: 'a', likes: 1000, replies: 50 })],
      filters: {
        minLikes: 50,
        minReplies: 10,
        maxLikes: Number.POSITIVE_INFINITY,
        maxReplies: Number.POSITIVE_INFINITY,
      } as SelectorFilters,
      topicKeywords: [],
    };
    const out = pickReplyTargets(input);
    expect(out.accepted.length).toBe(1);
  });
});

describe('pickReplyTargets — author dedup', () => {
  it('keeps only 1 post per author by default (maxPerAuthor=1)', () => {
    const input = {
      candidates: [
        cand({ id: '1', authorHandle: 'siddharthwv', likes: 200, postedAt: '2026-04-17T12:00Z' }),
        cand({ id: '2', authorHandle: 'siddharthwv', likes: 100, postedAt: '2026-04-17T11:00Z' }),
        cand({ id: '3', authorHandle: 'siddharthwv', likes: 50,  postedAt: '2026-04-17T10:00Z' }),
        cand({ id: '4', authorHandle: 'other',       likes: 30,  postedAt: '2026-04-17T09:00Z' }),
      ],
      filters: {} as SelectorFilters,
      topicKeywords: [],
      topN: 10,
    };
    const out = pickReplyTargets(input);
    const authors = out.accepted.map((s) => s.candidate.authorHandle);
    expect(authors).toEqual(['siddharthwv', 'other']);
    // First per-author is the highest-scored (likes=200 wins).
    expect(out.accepted[0].candidate.id).toBe('1');
  });

  it('respects maxPerAuthor=3 when explicitly set', () => {
    const input = {
      candidates: [
        cand({ id: '1', authorHandle: 'a', likes: 300 }),
        cand({ id: '2', authorHandle: 'a', likes: 200 }),
        cand({ id: '3', authorHandle: 'a', likes: 100 }),
        cand({ id: '4', authorHandle: 'a', likes: 50 }),
      ],
      filters: { maxPerAuthor: 3 } as SelectorFilters,
      topicKeywords: [],
      topN: 10,
    };
    const out = pickReplyTargets(input);
    expect(out.accepted.length).toBe(3);
  });
});

describe('pickReplyTargets — topicKeywords optional', () => {
  it('skips topic-match scoring when topicKeywords=[]', () => {
    const input = {
      candidates: [
        cand({ id: 'a', text: 'a totally unrelated post about baking sourdough' }),
      ],
      filters: {} as SelectorFilters,
      topicKeywords: [],
    };
    const out = pickReplyTargets(input);
    expect(out.accepted.length).toBe(1);
    expect(out.accepted[0].breakdown.topicMatch).toBeUndefined();
  });

  it('applies legacy OHWOW_TOPIC_KEYWORDS when topicKeywords is omitted (back-compat)', () => {
    const input = {
      candidates: [
        cand({ id: 'a', text: 'an interesting agent with memory and mcp' }),
      ],
      filters: {} as SelectorFilters,
      // topicKeywords omitted on purpose
    };
    const out = pickReplyTargets(input);
    expect(out.accepted.length).toBe(1);
    expect(out.accepted[0].breakdown.topicMatch).toBeGreaterThan(0);
  });
});
