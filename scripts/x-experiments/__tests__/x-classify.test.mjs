/**
 * Unit tests for the classify prompt helpers. Covers the engager-source
 * threading that lets the LLM distinguish a replier to an in-market pain
 * thread from a generic low-engagement reply.
 */
import { describe, it, expect } from 'vitest';
import { formatClassifyLine, ENGAGER_CLASSIFIER_GUIDANCE } from '../_x-classify.mjs';

describe('formatClassifyLine', () => {
  it('omits engager tag for non-engager posts', () => {
    const line = formatClassifyLine({
      author: 'someone',
      likes: 42,
      replies: 3,
      text: 'just shipped a thing',
    }, 0);
    expect(line).toBe('#0 @someone 42♥ 3💬: just shipped a thing');
    expect(line).not.toContain('engager:');
  });

  it('includes the bucket hint when present', () => {
    const line = formatClassifyLine({
      author: 'someone',
      likes: 1, replies: 0, text: 'x',
      _bucketHint: 'market_signal',
    }, 2);
    expect(line).toContain('[hint:market_signal]');
  });

  it('includes engager source + parent author when present', () => {
    const line = formatClassifyLine({
      author: 'shannholmberg',
      likes: 0, replies: 0,
      text: 'same pain here',
      _bucketHint: 'market_signal',
      _engagerSource: 'engager:competitor:zapier',
      _parentAuthor: 'zapier',
    }, 5);
    expect(line).toBe('#5 @shannholmberg [hint:market_signal] [engager:engager:competitor:zapier→@zapier] 0♥ 0💬: same pain here');
  });

  it('handles own-post engagers too', () => {
    const line = formatClassifyLine({
      author: 'builder123',
      likes: 0, replies: 0, text: 'how do you handle retries?',
      _engagerSource: 'engager:own-post',
      _parentAuthor: 'ohwow_fun',
    }, 0);
    expect(line).toContain('[engager:engager:own-post→@ohwow_fun]');
  });

  it('truncates text beyond 220 chars and strips newlines', () => {
    const long = 'a'.repeat(500);
    const line = formatClassifyLine({
      author: 'x', likes: 0, replies: 0,
      text: `line1\nline2 ${long}`,
    }, 0);
    const textPart = line.split(': ')[1];
    expect(textPart.length).toBe(220);
    expect(line).not.toContain('\n');
  });

  it('defaults missing likes/replies to 0', () => {
    const line = formatClassifyLine({ author: 'x', text: 't' }, 0);
    expect(line).toContain('0♥ 0💬');
  });
});

describe('ENGAGER_CLASSIFIER_GUIDANCE', () => {
  it('tells the LLM that engager rows are in-market by behavior', () => {
    expect(ENGAGER_CLASSIFIER_GUIDANCE).toContain('in-market by BEHAVIOR');
    expect(ENGAGER_CLASSIFIER_GUIDANCE).toContain('market_signal');
  });

  it('explicitly overrides the low-engagement skip bias for engagers', () => {
    expect(ENGAGER_CLASSIFIER_GUIDANCE).toMatch(/[Ll]ow likes/);
    expect(ENGAGER_CLASSIFIER_GUIDANCE).toContain('NOT a reason to skip');
  });

  it('still leaves `skip` available for genuinely off-topic engager replies', () => {
    expect(ENGAGER_CLASSIFIER_GUIDANCE).toContain('skip` is still correct');
  });
});
