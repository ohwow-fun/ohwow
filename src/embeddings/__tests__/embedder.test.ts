/**
 * Embedder smoke tests.
 *
 * Default-skipped: the model is ~400 MB on disk and cold-loads in seconds,
 * too heavy for routine CI. Run with `EMBED_TEST=1 npm test -- embedder` to
 * exercise real inference.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createEmbedder, type Embedder } from '../model.js';

const ENABLED = process.env.EMBED_TEST === '1';
const describeIf = ENABLED ? describe : describe.skip;

describeIf('embedder (local ONNX)', () => {
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = createEmbedder();
    await embedder.ready();
  }, 300_000); // first-time weight download may take a while

  it('returns one vector per input text', async () => {
    const [v] = await embedder.embed(['hello world']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(embedder.dim);
  });

  it('handles batches', async () => {
    const vs = await embedder.embed(['a', 'b', 'c']);
    expect(vs).toHaveLength(3);
    for (const v of vs) {
      expect(v.length).toBe(embedder.dim);
    }
  });

  it('L2-normalizes each vector', async () => {
    const [v] = await embedder.embed(['the quick brown fox']);
    let sumSq = 0;
    for (let i = 0; i < v.length; i += 1) sumSq += v[i] * v[i];
    expect(sumSq).toBeGreaterThan(0.99);
    expect(sumSq).toBeLessThan(1.01);
  });

  it('is deterministic for identical input', async () => {
    const [a] = await embedder.embed(['determinism check']);
    const [b] = await embedder.embed(['determinism check']);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-5);
    }
  });
});
