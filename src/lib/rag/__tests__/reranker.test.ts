import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerankWithLLM } from '../reranker.js';
import type { RerankCandidate } from '../reranker.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeCandidates(count: number): RerankCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    content: `This is passage number ${i + 1} about a specific topic.`,
    originalScore: 0.5 + i * 0.1,
  }));
}

function mockFetchResponse(content: string, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  } as Response);
}

describe('rerankWithLLM', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns normalized scores on successful reranking', async () => {
    const candidates = makeCandidates(3);
    mockFetchResponse('[8, 5, 9]');

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ index: 0, score: 0.8 });
    expect(results[1]).toEqual({ index: 1, score: 0.5 });
    expect(results[2]).toEqual({ index: 2, score: 0.9 });
  });

  it('handles markdown-fenced JSON in response', async () => {
    const candidates = makeCandidates(2);
    mockFetchResponse('```json\n[7, 3]\n```');

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 0, score: 0.7 });
    expect(results[1]).toEqual({ index: 1, score: 0.3 });
  });

  it('handles thinking tags in response', async () => {
    const candidates = makeCandidates(2);
    mockFetchResponse('<think>Let me evaluate these passages...</think>[6, 4]');

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 0, score: 0.6 });
    expect(results[1]).toEqual({ index: 1, score: 0.4 });
  });

  it('returns original scores on fetch failure', async () => {
    const candidates = makeCandidates(2);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 0, score: candidates[0].originalScore });
    expect(results[1]).toEqual({ index: 1, score: candidates[1].originalScore });
  });

  it('returns original scores on malformed JSON', async () => {
    const candidates = makeCandidates(2);
    mockFetchResponse('these are not numbers at all');

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 0, score: candidates[0].originalScore });
    expect(results[1]).toEqual({ index: 1, score: candidates[1].originalScore });
  });

  it('returns original scores on non-ok response', async () => {
    const candidates = makeCandidates(2);
    mockFetchResponse('', false, 500);

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 0, score: candidates[0].originalScore });
    expect(results[1]).toEqual({ index: 1, score: candidates[1].originalScore });
  });

  it('truncates long passages to 500 chars in prompt', async () => {
    const longContent = 'A'.repeat(1000);
    const candidates: RerankCandidate[] = [
      { index: 0, content: longContent, originalScore: 0.5 },
    ];
    const fetchSpy = mockFetchResponse('[7]');

    await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const prompt = body.messages[0].content as string;
    // The passage in the prompt should be truncated to 500 chars + "..."
    expect(prompt).toContain('A'.repeat(500) + '...');
    expect(prompt).not.toContain('A'.repeat(501));
  });

  it('handles empty candidates array', async () => {
    const results = await rerankWithLLM('test query', [], 'http://localhost:11434', 'qwen3:4b');
    expect(results).toEqual([]);
  });

  it('returns original scores when score count mismatches candidate count', async () => {
    const candidates = makeCandidates(3);
    mockFetchResponse('[8, 5]'); // Only 2 scores for 3 candidates

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results).toHaveLength(3);
    expect(results[0].score).toBe(candidates[0].originalScore);
  });

  it('clamps scores to 0-1 range', async () => {
    const candidates = makeCandidates(2);
    mockFetchResponse('[15, -3]'); // Out of range

    const results = await rerankWithLLM('test query', candidates, 'http://localhost:11434', 'qwen3:4b');

    expect(results[0].score).toBe(1); // clamped to 1
    expect(results[1].score).toBe(0); // clamped to 0
  });
});
