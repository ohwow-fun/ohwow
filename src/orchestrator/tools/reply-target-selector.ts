/**
 * reply-target-selector.ts — pick a post worth replying to.
 *
 * Takes a list of scanned candidates (from x-reply or threads-reply),
 * applies deterministic filters, scores what's left, and returns the
 * top picks. Optional LLM re-ranking for a second opinion on
 * conversational fit.
 *
 * Design goals:
 *   - Deterministic floor: every invocation for the same scan produces
 *     the same score ordering. No hidden randomness, no time-sensitive
 *     hashes in scoring.
 *   - Philosophy-aligned defaults: excludes pitch/spam/promo patterns
 *     and over-saturated threads (where another reply won't land). The
 *     ohwow outreach invariant is "conversational, not sales" — this
 *     is that invariant codified.
 *   - Explainable: every candidate comes back with its score breakdown
 *     so tuning is visible, not magical.
 */

import type { ScannedTweet } from './x-reply.js';
import type { ScannedThread } from './threads-reply.js';

// ---------------------------------------------------------------------------
// Common candidate shape
// ---------------------------------------------------------------------------

export interface ReplyCandidate {
  id: string;
  url: string;
  authorHandle: string;
  text: string | null;
  replies: number | null;
  likes: number | null;
  reposts: number | null;
  postedAt: string | null;
  isReply: boolean;
  isRepost: boolean;
  /** Present on tweets, absent on threads. Pass-through. */
  views?: number | null;
  /** Present on tweets, absent on threads. Pass-through. */
  authorName?: string;
}

export function tweetToCandidate(t: ScannedTweet): ReplyCandidate {
  return {
    id: t.id, url: t.url, authorHandle: t.authorHandle, text: t.text,
    replies: t.replies, likes: t.likes, reposts: t.reposts,
    postedAt: t.postedAt, isReply: t.isReply, isRepost: t.isRepost,
    views: t.views, authorName: t.authorName,
  };
}

export function threadToCandidate(p: ScannedThread): ReplyCandidate {
  return {
    id: p.id, url: p.url, authorHandle: p.authorHandle, text: p.text,
    replies: p.replies, likes: p.likes, reposts: p.reposts,
    postedAt: p.postedAt, isReply: p.isReply, isRepost: false,
  };
}

// ---------------------------------------------------------------------------
// Filter + ranking knobs
// ---------------------------------------------------------------------------

export interface SelectorFilters {
  /** Drop posts authored by these handles (self + blocked). Case-insensitive. */
  excludeHandles?: string[];
  /** Require ≥1 of these keywords in text (case-insensitive substring). */
  requireAnyKeyword?: string[];
  /** Drop posts matching any of these keywords. */
  excludeKeywords?: string[];
  /** Drop posts with likes > this. Avoid oversaturated. Default 500. */
  maxLikes?: number;
  /** Drop posts with replies > this. Default 40. */
  maxReplies?: number;
  /** Drop posts older than this. Default 48h. */
  maxAgeHours?: number;
  /** Drop replies from the feed. Default true. */
  excludeReplies?: boolean;
  /** Drop reposts from the feed. Default true. */
  excludeReposts?: boolean;
  /** Drop posts shorter than this (usually image-only / useless). Default 15. */
  minTextLength?: number;
  /** Drop posts with caps ratio >= this. 0.4 = 40% uppercase letters. Default 0.45. */
  maxCapsRatio?: number;
  /** Drop posts that match any PITCH_REGEXES with weight>=this threshold. Default 2. */
  maxPitchWeight?: number;
  /** Drop posts that don't match any topic keyword. Useful for noisy search feeds. Default false. */
  requireTopicMatch?: boolean;
}

export interface ScoringWeights {
  /** Points for having engagement at all (non-null likes > 0). */
  hasEngagement?: number;
  /** Per-log10-likes weight — rewards good traction, capped. */
  likesLog?: number;
  /** Penalty per existing reply — thread crowding is negative signal. */
  replyPenalty?: number;
  /** Recency reward: freshest post ≈ full credit, decaying. */
  recencyWeight?: number;
  /** Points per matched topic keyword. */
  topicMatchWeight?: number;
  /** Penalty for pitch-shaped language ("DM me", "link in bio", $, 🚀 etc). */
  pitchPenalty?: number;
  /** Penalty for each "?" — questions are great but questions IN reply targets
   *  are tricky (depends); tune to taste. Default 0. */
  questionPenalty?: number;
}

export const DEFAULT_FILTERS: Required<SelectorFilters> = {
  excludeHandles: [],
  requireAnyKeyword: [],
  excludeKeywords: [],
  maxLikes: 500,
  maxReplies: 40,
  maxAgeHours: 48,
  excludeReplies: true,
  excludeReposts: true,
  minTextLength: 15,
  maxCapsRatio: 0.45,
  maxPitchWeight: 3,
  requireTopicMatch: false,
};

export const DEFAULT_WEIGHTS: Required<ScoringWeights> = {
  hasEngagement: 5,
  likesLog: 10,
  replyPenalty: 0.5,
  recencyWeight: 15,
  topicMatchWeight: 12,
  pitchPenalty: 25,
  questionPenalty: 0,
};

/**
 * Default interest keywords for @ohwow_fun. Scope is intentionally
 * broad — topic signal is "this post is somewhere in our world",
 * not "this post is exactly about our product".
 */
export const OHWOW_TOPIC_KEYWORDS = [
  'agent', 'agents', 'agentic',
  'ai', 'llm', 'claude', 'gpt', 'anthropic', 'openai',
  'memory', 'context',
  'automation', 'workflow',
  'mcp', 'tool use', 'tool calling',
  'rag', 'retrieval',
  'orchestrat', 'pipeline',
  'copilot', 'devtool', 'developer tool',
  'local-first', 'local first', 'local ai',
  'ops', 'devops', 'sre',
  'product', 'builder', 'build in public',
];

/** Phrases/patterns that mark a post as pitch/spam/promo. Lowercased. */
export const PITCH_PATTERNS = [
  // Self-promo CTAs
  'dm me', 'dm\'d me', 'link in bio', 'link below', 'check my bio',
  'comment "', "comment '", 'follow for', 'follow me for',
  'pre-order', 'preorder', 'promo code', 'coupon code',
  'sign up at', 'sign-up',
  'limited time', 'limited spots', 'only 24 hours',
  'use code', 'affiliate',
  'free pdf', 'free ebook', 'free training',
  'giveaway', 'giving away', 'payout', 'rewards',
  // Crypto / token shilling
  'defi', 'memecoin', 'altcoin', 'presale', 'pre-sale',
  'airdrop', 'moonshot', 'zk proof',
  'ico', 'nft', 'web3', 'onchain', 'on-chain',
  'leverage', 'bullish', 'bearish', 'hodl',
  'staking', 'stake to earn', 'play to earn', 'p2e',
  'tokenomics', 'blockchain game',
  // Blockchain-project shill vocabulary
  '#narachain', 'narachain', 'nara chain',
  'basechain', 'solanachain', 'ethereum chain',
  // Gig / service seller
  'i will set up', 'i will build', 'i will create',
  'i\'ll set up', 'i\'ll build', 'i\'ll create',
  'dm to order', 'order now',
  // Emojified urgency
  '🚀🚀', '💰', '🔥🔥', '👇👇',
];

/**
 * Regex-level pitch signals that string substrings can't cleanly express.
 * Each returns a count that scoreCandidate multiplies by pitchPenalty.
 */
export const PITCH_REGEXES: Array<{ re: RegExp; weight: number; label: string }> = [
  // $TICKER tokens — e.g. $VIRTUAL, $BTC, $HERMESCLAW. Require uppercase 2-12
  // chars, word boundary before, and the following char must NOT be a digit
  // or K/M/B (to exclude dollar amounts like $15M, $1B, $500K).
  { re: /(?:^|\s)\$[A-Z]{2,12}(?![A-Za-z0-9])/g, weight: 2, label: 'cryptoTicker' },
  // Multi-hashtag spam (3+ hashtags)
  { re: /#\w+[\s\S]*?#\w+[\s\S]*?#\w+/, weight: 1, label: 'hashtagSpam' },
  // Fake urgency: "X HOURS LEFT", "Y MIN LEFT", capitalized
  { re: /\d+\s+(?:hours?|mins?|minutes?|days?)\s+left\b/i, weight: 1, label: 'fakeUrgency' },
  // Many consecutive uppercase words ("YOU WILL WIN BIG NOW") — 4+ uppercase
  // tokens in a row signal promo shouting.
  { re: /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){3,}/, weight: 1, label: 'yelling' },
  // Fiverr/gig opener
  { re: /^i (?:will|can|'ll)\s+(?:set up|build|create|deliver|design|configure)/i, weight: 2, label: 'gigPitch' },
];

/** Ratio of uppercase letters vs total letters. 0.3+ is shouty. */
export function capsRatio(text: string): number {
  const letters = text.match(/[A-Za-z]/g);
  if (!letters || letters.length < 10) return 0;
  const caps = text.match(/[A-Z]/g);
  return (caps?.length || 0) / letters.length;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  candidate: ReplyCandidate;
  score: number;
  breakdown: Record<string, number>;
  kept: true;
}

export interface RejectedCandidate {
  candidate: ReplyCandidate;
  reason: string;
  kept: false;
}

export function scoreCandidate(
  c: ReplyCandidate,
  opts: {
    topicKeywords: string[];
    weights: Required<ScoringWeights>;
    now?: number;
  },
): { score: number; breakdown: Record<string, number> } {
  const bd: Record<string, number> = {};
  const w = opts.weights;
  const text = (c.text || '').toLowerCase();

  // Engagement floor — non-null positive likes = real post, not ghost.
  const likes = c.likes ?? 0;
  const replies = c.replies ?? 0;
  if (likes > 0 || (c.views ?? 0) > 0) bd.hasEngagement = w.hasEngagement;

  // Log-scale likes (rewards 10x likes with 1x more points, capped 3).
  if (likes > 0) {
    const cap = Math.min(3, Math.log10(likes));
    bd.likesLog = Math.round(cap * w.likesLog * 10) / 10;
  }

  // Thread crowding penalty — linear per existing reply, capped so a
  // post with 100 replies is not scored into oblivion.
  if (replies > 0) bd.replyPenalty = -Math.min(20, replies * w.replyPenalty);

  // Recency — if we have a postedAt, score by hours-since.
  if (c.postedAt) {
    const now = opts.now ?? Date.now();
    const posted = Date.parse(c.postedAt);
    if (!isNaN(posted)) {
      const hours = (now - posted) / 3_600_000;
      // Decay: full weight at <2h, half at 12h, zero at 48h.
      const decay = Math.max(0, 1 - hours / 48);
      bd.recency = Math.round(decay * w.recencyWeight * 10) / 10;
    }
  }

  // Topic match — each matched keyword is +weight, capped at 2× weight.
  let topicHits = 0;
  for (const kw of opts.topicKeywords) {
    if (text.includes(kw.toLowerCase())) topicHits++;
  }
  if (topicHits > 0) {
    bd.topicMatch = Math.min(topicHits, 2) * w.topicMatchWeight;
  }

  // Pitch / spam patterns — substring matches.
  let pitchHits = 0;
  for (const p of PITCH_PATTERNS) {
    if (text.includes(p)) pitchHits++;
  }
  // Regex-level patterns — tickers, fake urgency, gig language, shouting.
  for (const { re, weight } of PITCH_REGEXES) {
    const matches = text.match(re);
    if (matches) pitchHits += matches.length * weight;
  }
  // ALL-CAPS shouting penalty. 30%+ caps ratio adds 1 hit per 10%.
  const caps = capsRatio(c.text || '');
  if (caps >= 0.3) pitchHits += Math.ceil((caps - 0.2) * 10);
  if (pitchHits > 0) bd.pitchPenalty = -pitchHits * w.pitchPenalty;

  // Question penalty (off by default).
  if (w.questionPenalty > 0) {
    const qCount = (text.match(/\?/g) || []).length;
    if (qCount > 0) bd.questionPenalty = -qCount * w.questionPenalty;
  }

  const score = Object.values(bd).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 10) / 10, breakdown: bd };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function filterCandidate(
  c: ReplyCandidate,
  filters: Required<SelectorFilters>,
  now = Date.now(),
  topicKeywords: string[] = OHWOW_TOPIC_KEYWORDS,
): { keep: true } | { keep: false; reason: string } {
  const text = (c.text || '').toLowerCase();

  if (filters.excludeReplies && c.isReply) return { keep: false, reason: 'isReply' };
  if (filters.excludeReposts && c.isRepost) return { keep: false, reason: 'isRepost' };

  const authorLower = c.authorHandle.toLowerCase();
  for (const h of filters.excludeHandles) {
    if (authorLower === h.toLowerCase().replace(/^@/, '')) {
      return { keep: false, reason: `excludeHandle:${h}` };
    }
  }

  if (!c.text || c.text.length < filters.minTextLength) {
    return { keep: false, reason: `textTooShort(${c.text?.length ?? 0})` };
  }

  for (const kw of filters.excludeKeywords) {
    if (text.includes(kw.toLowerCase())) {
      return { keep: false, reason: `excludeKeyword:${kw}` };
    }
  }

  if (filters.requireAnyKeyword.length > 0) {
    const hit = filters.requireAnyKeyword.some((kw) => text.includes(kw.toLowerCase()));
    if (!hit) return { keep: false, reason: 'noTopicMatch' };
  }

  if (filters.requireTopicMatch) {
    const hit = topicKeywords.some((kw) => text.includes(kw.toLowerCase()));
    if (!hit) return { keep: false, reason: 'noTopicMatch(global)' };
  }

  // Caps-ratio gate — shouty posts are almost always promo.
  const caps = capsRatio(c.text || '');
  if (caps >= filters.maxCapsRatio) {
    return { keep: false, reason: `tooShouty(caps=${(caps * 100).toFixed(0)}%)` };
  }

  // Regex pitch gate — sum weights, drop if over threshold.
  let pitchWeight = 0;
  for (const { re, weight, label } of PITCH_REGEXES) {
    const matches = (c.text || '').match(re);
    if (matches) pitchWeight += matches.length * weight;
    if (pitchWeight >= filters.maxPitchWeight) {
      return { keep: false, reason: `pitchy(${label})` };
    }
  }

  if (c.likes != null && c.likes > filters.maxLikes) {
    return { keep: false, reason: `likesTooHigh(${c.likes})` };
  }
  if (c.replies != null && c.replies > filters.maxReplies) {
    return { keep: false, reason: `repliesTooHigh(${c.replies})` };
  }

  if (c.postedAt) {
    const posted = Date.parse(c.postedAt);
    if (!isNaN(posted)) {
      const hours = (now - posted) / 3_600_000;
      if (hours > filters.maxAgeHours) {
        return { keep: false, reason: `tooOld(${hours.toFixed(1)}h)` };
      }
    }
  }

  return { keep: true };
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

export interface SelectorInput {
  candidates: ReplyCandidate[];
  filters?: SelectorFilters;
  weights?: ScoringWeights;
  topicKeywords?: string[];
  topN?: number;
  now?: number;
}

export interface SelectorOutput {
  accepted: ScoredCandidate[];
  rejected: RejectedCandidate[];
  topN: ScoredCandidate[];
  chosen: ScoredCandidate | null;
}

export function pickReplyTargets(input: SelectorInput): SelectorOutput {
  const filters: Required<SelectorFilters> = { ...DEFAULT_FILTERS, ...(input.filters ?? {}) };
  const weights: Required<ScoringWeights> = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const topicKeywords = input.topicKeywords ?? OHWOW_TOPIC_KEYWORDS;
  const topN = Math.max(1, Math.min(input.topN ?? 3, 20));
  const now = input.now ?? Date.now();

  const accepted: ScoredCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const c of input.candidates) {
    const res = filterCandidate(c, filters, now, topicKeywords);
    if (!res.keep) {
      rejected.push({ candidate: c, reason: res.reason, kept: false });
      continue;
    }
    const { score, breakdown } = scoreCandidate(c, { topicKeywords, weights, now });
    accepted.push({ candidate: c, score, breakdown, kept: true });
  }

  // Stable sort: primary by score desc, tiebreaker by id asc so repeat
  // runs on identical scans pick the same winner.
  accepted.sort((a, b) => (b.score - a.score) || a.candidate.id.localeCompare(b.candidate.id));
  const topSlice = accepted.slice(0, topN);
  const chosen = topSlice.length > 0 && topSlice[0].score > 0 ? topSlice[0] : null;

  return { accepted, rejected, topN: topSlice, chosen };
}
