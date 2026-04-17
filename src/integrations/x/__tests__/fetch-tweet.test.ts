import { describe, it, expect } from 'vitest';
import { extractTweetId, fetchXPost } from '../fetch-tweet.js';

describe('extractTweetId', () => {
  it('accepts a bare numeric id', () => {
    expect(extractTweetId('2044523795206029525')).toBe('2044523795206029525');
  });
  it('extracts from a path permalink', () => {
    expect(extractTweetId('/shannholmberg/status/2044523795206029525')).toBe('2044523795206029525');
  });
  it('extracts from an https x.com url', () => {
    expect(extractTweetId('https://x.com/shannholmberg/status/2044523795206029525')).toBe('2044523795206029525');
  });
  it('extracts from a twitter.com url with query', () => {
    expect(extractTweetId('https://twitter.com/handle/status/12345678901?ref=1')).toBe('12345678901');
  });
  it('handles /statuses/ legacy path', () => {
    expect(extractTweetId('https://twitter.com/handle/statuses/999')).toBe(null); // 3-digit below min
    expect(extractTweetId('https://twitter.com/handle/statuses/99999')).toBe('99999');
  });
  it('returns null on garbage', () => {
    expect(extractTweetId('not a tweet')).toBe(null);
    expect(extractTweetId('')).toBe(null);
  });
});

describe('fetchXPost', () => {
  it('returns null when id is unparseable', async () => {
    const noopFetch = (async () => ({}) as Response) as typeof fetch;
    const result = await fetchXPost('not a tweet', { fetchImpl: noopFetch });
    expect(result).toBeNull();
  });

  it('returns null on 404', async () => {
    const fakeFetch = (async () =>
      ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    const result = await fetchXPost('https://x.com/h/status/12345678901', { fetchImpl: fakeFetch });
    expect(result).toBeNull();
  });

  it('throws on non-404 HTTP errors', async () => {
    const fakeFetch = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    await expect(fetchXPost('https://x.com/h/status/12345678901', { fetchImpl: fakeFetch })).rejects.toThrow(/HTTP 500/);
  });

  it('returns null when response is not a Tweet', async () => {
    const fakeFetch = (async () => ({ ok: true, status: 200, json: async () => ({ __typename: 'TweetTombstone' }) }) as unknown as Response) as typeof fetch;
    const result = await fetchXPost('12345678901', { fetchImpl: fakeFetch });
    expect(result).toBeNull();
  });

  it('maps a real syndication payload', async () => {
    const payload = {
      __typename: 'Tweet',
      id_str: '2044523795206029525',
      lang: 'en',
      created_at: '2026-04-15T21:10:32.000Z',
      favorite_count: 186,
      conversation_count: 16,
      retweet_count: 19,
      bookmark_count: 259,
      display_text_range: [0, 53],
      text: 'what is the AI knowledge layer and how does it work\n\nmore text here https://t.co/trailing',
      user: {
        screen_name: 'shannholmberg',
        name: 'Shann3',
        is_blue_verified: true,
        profile_image_url_https: 'https://example.com/pic.png',
        highlighted_label: { description: 'Lunar Strategy' },
      },
      mediaDetails: [
        { type: 'photo', media_url_https: 'https://example.com/img.png', display_url: 'pic.x.com/x', expanded_url: 'https://x.com/1' },
      ],
    };
    const fakeFetch = (async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response) as typeof fetch;
    const result = await fetchXPost('2044523795206029525', { fetchImpl: fakeFetch });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('2044523795206029525');
    expect(result!.permalink).toBe('https://x.com/shannholmberg/status/2044523795206029525');
    expect(result!.author.handle).toBe('shannholmberg');
    expect(result!.author.is_blue_verified).toBe(true);
    expect(result!.author.business_label).toBe('Lunar Strategy');
    expect(result!.metrics.likes).toBe(186);
    expect(result!.metrics.replies).toBe(16);
    expect(result!.text).toBe('what is the AI knowledge layer and how does it work\n\n');
    expect(result!.truncated).toBe(true);
    expect(result!.media).toHaveLength(1);
    expect(result!.media[0].type).toBe('photo');
  });
});
