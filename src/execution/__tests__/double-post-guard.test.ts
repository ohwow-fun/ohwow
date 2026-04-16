import { describe, it, expect } from 'vitest';
import { reactTraceShowsRealPost, type ReActStep } from '../task-completion.js';

function step(observations: ReActStep['observations']): ReActStep {
  return {
    iteration: 1,
    thought: '',
    actions: observations.map((o) => ({ tool: o.tool, inputSummary: '' })),
    observations,
    durationMs: 0,
    timestamp: new Date().toISOString(),
  };
}

describe('reactTraceShowsRealPost', () => {
  it('returns true when x_compose_tweet succeeded with a real publish', () => {
    const trace: ReActStep[] = [
      step([
        {
          tool: 'x_compose_tweet',
          success: true,
          resultSummary: '{"success":true,"message":"Tweet published (241 chars).","tweetsPublished":1}',
        },
      ]),
    ];
    expect(reactTraceShowsRealPost(trace)).toBe(true);
  });

  it('returns true for a thread that was published', () => {
    const trace: ReActStep[] = [
      step([
        {
          tool: 'x_compose_thread',
          success: true,
          resultSummary: 'Thread published (3 tweets).',
        },
      ]),
    ];
    expect(reactTraceShowsRealPost(trace)).toBe(true);
  });

  it('returns true for an article that was published', () => {
    const trace: ReActStep[] = [
      step([
        {
          tool: 'x_compose_article',
          success: true,
          resultSummary: 'Article published: "Launch day".',
        },
      ]),
    ];
    expect(reactTraceShowsRealPost(trace)).toBe(true);
  });

  it('returns false for a dry-run compose (success=true but no publish)', () => {
    const trace: ReActStep[] = [
      step([
        {
          tool: 'x_compose_tweet',
          success: true,
          resultSummary: 'Dry run complete. Composed 241 chars in X compose modal.',
        },
      ]),
    ];
    expect(reactTraceShowsRealPost(trace)).toBe(false);
  });

  it('returns false when the tool failed even if message contains "published"', () => {
    const trace: ReActStep[] = [
      step([
        {
          tool: 'x_compose_tweet',
          success: false,
          resultSummary: 'Tweet published — but actually error',
        },
      ]),
    ];
    expect(reactTraceShowsRealPost(trace)).toBe(false);
  });

  it('returns false for unrelated tools', () => {
    const trace: ReActStep[] = [
      step([
        { tool: 'web_search', success: true, resultSummary: 'Tweet published in some article we found' },
        { tool: 'list_knowledge', success: true, resultSummary: 'Article published last week' },
      ]),
    ];
    expect(reactTraceShowsRealPost(trace)).toBe(false);
  });

  it('returns false on an empty trace', () => {
    expect(reactTraceShowsRealPost([])).toBe(false);
  });

  it('returns true when one of multiple steps confirms a publish', () => {
    const trace: ReActStep[] = [
      step([{ tool: 'web_search', success: true, resultSummary: 'searched stuff' }]),
      step([{ tool: 'x_compose_tweet', success: true, resultSummary: 'Tweet published (180 chars).' }]),
      step([{ tool: 'list_knowledge', success: true, resultSummary: 'fetched 3 docs' }]),
    ];
    expect(reactTraceShowsRealPost(trace)).toBe(true);
  });
});
