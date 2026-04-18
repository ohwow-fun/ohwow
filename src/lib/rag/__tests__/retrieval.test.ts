import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bm25Score, tokenize, expandQuery } from '../retrieval.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock embeddings helpers so the retrieval module imports cleanly in
// these unit tests (which only exercise bm25 + expandQuery, never the
// hybrid scoring path).
vi.mock('../embeddings.js', () => ({
  cosineSimilarity: vi.fn().mockReturnValue(0),
  deserializeEmbedding: vi.fn().mockReturnValue(new Float32Array([])),
  serializeEmbedding: vi.fn().mockReturnValue(Buffer.alloc(0)),
}));

// The retrieval module pulls in the embedder singleton at module load
// for its hybrid-scoring path. None of the tests below hit that path,
// so replace it with a no-op embedder that never loads ONNX weights.
vi.mock('../../../embeddings/singleton.js', () => ({
  getSharedEmbedder: vi.fn(() => ({
    modelId: 'mock',
    dim: 0,
    ready: vi.fn().mockResolvedValue(undefined),
    embed: vi.fn().mockResolvedValue([]),
  })),
}));

describe('tokenize', () => {
  it('lowercases and splits text', () => {
    const tokens = tokenize('Hello World Test');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('test');
  });

  it('removes stop words', () => {
    const tokens = tokenize('the quick brown fox and the lazy dog');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('and');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
  });

  it('filters short words', () => {
    const tokens = tokenize('a I x on do test');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('x');
    expect(tokens).toContain('test');
  });
});

describe('bm25Score', () => {
  it('returns 0 for empty query', () => {
    expect(bm25Score([], 'some document text')).toBe(0);
  });

  it('returns 0 when no query terms match', () => {
    const score = bm25Score(['xyz', 'abc'], 'the quick brown fox');
    expect(score).toBe(0);
  });

  it('returns positive score for matching terms', () => {
    const score = bm25Score(['kubernetes', 'deployment'], 'kubernetes deployment guide for production');
    expect(score).toBeGreaterThan(0);
  });

  it('backward compat: works without idfMap (idf=1)', () => {
    const scoreNoIdf = bm25Score(['test', 'data'], 'test data sample');
    const scoreWithIdf = bm25Score(['test', 'data'], 'test data sample', undefined, undefined);
    expect(scoreNoIdf).toBe(scoreWithIdf);
  });

  it('IDF boosts rare terms over common terms', () => {
    // "kubernetes" appears in 1 out of 100 docs (rare)
    // "data" appears in 90 out of 100 docs (common)
    const idfMap = new Map<string, number>([
      ['kubernetes', 1],
      ['data', 90],
    ]);
    const corpusSize = 100;

    const docText = 'kubernetes data processing pipeline';

    // Score with only "kubernetes"
    const scoreRare = bm25Score(['kubernetes'], docText, idfMap, corpusSize);
    // Score with only "data"
    const scoreCommon = bm25Score(['data'], docText, idfMap, corpusSize);

    // Rare term should score higher than common term
    expect(scoreRare).toBeGreaterThan(scoreCommon);
  });

  it('IDF with zero corpus size falls back to idf=1', () => {
    const idfMap = new Map([['test', 5]]);
    const scoreNoCorpus = bm25Score(['test'], 'test document', idfMap, 0);
    const scoreNoIdf = bm25Score(['test'], 'test document');
    expect(scoreNoCorpus).toBe(scoreNoIdf);
  });
});

describe('expandQuery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns expanded tokens on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '["container orchestration","pod management","cluster deployment"]' } }],
      }),
    } as Response);

    const original = tokenize('deploy containers');
    const expanded = await expandQuery('deploy containers', original, 'http://localhost:11434', 'qwen3:4b');

    // Should include original tokens
    expect(expanded).toContain('deploy');
    expect(expanded).toContain('containers');
    // Should include tokens from alternatives
    expect(expanded).toContain('container');
    expect(expanded).toContain('orchestration');
    expect(expanded).toContain('cluster');
  });

  it('returns original tokens on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('fail'));

    const original = ['deploy', 'containers'];
    const result = await expandQuery('deploy containers', original, 'http://localhost:11434', 'qwen3:4b');

    expect(result).toEqual(original);
  });

  it('returns original tokens on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const original = ['deploy', 'containers'];
    const result = await expandQuery('deploy containers', original, 'http://localhost:11434', 'qwen3:4b');

    expect(result).toEqual(original);
  });

  it('returns original tokens on malformed JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'this is not json' } }],
      }),
    } as Response);

    const original = ['deploy'];
    const result = await expandQuery('deploy', original, 'http://localhost:11434', 'qwen3:4b');

    expect(result).toEqual(original);
  });

  it('handles markdown-fenced JSON in response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n["alternative query"]\n```' } }],
      }),
    } as Response);

    const original = ['test'];
    const result = await expandQuery('test', original, 'http://localhost:11434', 'qwen3:4b');

    expect(result).toContain('test');
    expect(result).toContain('alternative');
    expect(result).toContain('query');
  });

  it('handles thinking tags in response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '<think>some thoughts</think>["expanded query"]' } }],
      }),
    } as Response);

    const original = ['test'];
    const result = await expandQuery('test', original, 'http://localhost:11434', 'qwen3:4b');

    expect(result).toContain('expanded');
    expect(result).toContain('query');
  });
});
