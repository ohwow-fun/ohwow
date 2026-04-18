/**
 * Benchmark the in-daemon embedder.
 *
 * Measures cold-load time, batch=1 warm latency, batch=32 sustained throughput,
 * and peak RSS. Prints a JSON summary on stdout.
 *
 * Usage:
 *   npx tsx scripts/bench-embedder.ts
 *
 * Not registered in package.json — invoke directly.
 */

import { createEmbedder } from '../src/embeddings/index.js';

const BATCH1_RUNS = 10;
const BATCH32_RUNS = 3;
const BATCH32_TEXTS = Array.from({ length: 32 }, (_, i) => `benchmark text ${i}`);

function median(ns: number[]): number {
  const sorted = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main(): Promise<void> {
  const started = Date.now();
  const embedder = createEmbedder();
  await embedder.ready();
  const coldLoadMs = Date.now() - started;

  // Batch=1 warm latency.
  const batch1Ms: number[] = [];
  for (let i = 0; i < BATCH1_RUNS; i += 1) {
    const t0 = Date.now();
    await embedder.embed([`warm query ${i}`]);
    batch1Ms.push(Date.now() - t0);
  }

  // Batch=32 sustained throughput.
  const batch32Wall: number[] = [];
  for (let i = 0; i < BATCH32_RUNS; i += 1) {
    const t0 = Date.now();
    await embedder.embed(BATCH32_TEXTS);
    batch32Wall.push(Date.now() - t0);
  }
  const totalTexts = BATCH32_RUNS * BATCH32_TEXTS.length;
  const totalMs = batch32Wall.reduce((a, b) => a + b, 0);
  const throughput = totalTexts / (totalMs / 1000);

  const rssMB = process.memoryUsage().rss / 1024 / 1024;

  const summary = {
    modelId: embedder.modelId,
    dim: embedder.dim,
    coldLoadSeconds: Number((coldLoadMs / 1000).toFixed(2)),
    batch1MedianMs: Number(median(batch1Ms).toFixed(0)),
    batch1AllMs: batch1Ms,
    batch32Runs: BATCH32_RUNS,
    batch32TotalTexts: totalTexts,
    batch32TotalSeconds: Number((totalMs / 1000).toFixed(2)),
    batch32ThroughputPerSec: Number(throughput.toFixed(2)),
    peakRssMB: Number(rssMB.toFixed(0)),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`bench-embedder failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
