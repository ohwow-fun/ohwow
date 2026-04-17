/**
 * Unit tests for filterPosts in _x-harvest.mjs. Covers the engager-source
 * exemption that keeps replier rows alive through the filter chain (the
 * whole point of the engager surface is that the rows ARE replies with
 * often-zero likes).
 */
import { describe, it, expect } from 'vitest';
import { filterPosts } from '../_x-harvest.mjs';

const baseFilters = {
  drop_retweets: false,
  drop_replies_to_others: true,
  language: 'en',
  min_engagement: { likes: 5, replies: 0 },
};

describe('filterPosts', () => {
  it('drops replies from general sources when drop_replies_to_others is set', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 10, replies: 0, lang: 'en' },
      { permalink: '/b/2', replyingTo: false, likes: 10, replies: 0, lang: 'en' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/b/2']);
  });

  it('keeps engager-sourced replies even when drop_replies_to_others is set', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 10, replies: 0, lang: 'en', _engagerSource: 'engager:competitor:zapier' },
      { permalink: '/b/2', replyingTo: true, likes: 10, replies: 0, lang: 'en' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/a/1']);
  });

  it('bypasses min_engagement for engager-sourced rows so low-like repliers survive', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 0, replies: 0, lang: 'en', _engagerSource: 'engager:own-post' },
      { permalink: '/b/2', replyingTo: false, likes: 0, replies: 0, lang: 'en' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/a/1']);
  });

  it('still drops retweets even for engager-sourced rows', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, isRetweet: true, likes: 0, replies: 0, lang: 'en', _engagerSource: 'engager:own-post' },
    ];
    const filtered = filterPosts(posts, { ...baseFilters, drop_retweets: true });
    expect(filtered).toEqual([]);
  });

  it('still drops non-matching language even for engager-sourced rows', () => {
    const posts = [
      { permalink: '/a/1', replyingTo: true, likes: 0, replies: 0, lang: 'es', _engagerSource: 'engager:own-post' },
      { permalink: '/b/2', replyingTo: true, likes: 0, replies: 0, lang: 'en', _engagerSource: 'engager:own-post' },
    ];
    const filtered = filterPosts(posts, baseFilters);
    expect(filtered.map(p => p.permalink)).toEqual(['/b/2']);
  });
});
