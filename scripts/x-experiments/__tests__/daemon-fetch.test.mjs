/**
 * daemonFetch retry helper — unit tests.
 *
 * Closes the 18th-pass cross-cutting bug class "Daemon bounces kill
 * in-flight x-intel runs": a mid-run `ohwow restart` drops sockets with
 * ECONNREFUSED / ECONNRESET, and every script in this family needs to
 * survive that instead of exiting.
 *
 * We don't exercise a real bounce here (that's a manual repro per the
 * ledger's optional lightweight validation). These tests pin the
 * classifier + backoff semantics so the wrapper can't silently drift.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { daemonFetch } from '../_ohwow.mjs';

function connRefusedError() {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7700'), { code: 'ECONNREFUSED' });
  return e;
}

describe('daemonFetch', () => {
  let prevFetch;
  let prevStderr;
  let stderr;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
    prevStderr = process.stderr.write.bind(process.stderr);
    stderr = [];
    process.stderr.write = (msg) => { stderr.push(String(msg)); return true; };
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    process.stderr.write = prevStderr;
  });

  it('returns the first successful response without retrying', async () => {
    const fake = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fake;
    const res = await daemonFetch('http://localhost:7700/api/llm', { method: 'POST' });
    expect(res.ok).toBe(true);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(stderr.join('')).toBe('');
  });

  it('does NOT retry HTTP 5xx responses (semantic failure, not plumbing)', async () => {
    const fake = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    globalThis.fetch = fake;
    const res = await daemonFetch('http://localhost:7700/api/llm', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('retries on ECONNREFUSED and eventually returns the recovered response', async () => {
    const fake = vi.fn()
      .mockRejectedValueOnce(connRefusedError())
      .mockRejectedValueOnce(connRefusedError())
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = fake;
    // Compress the schedule so the test runs in ms, not seconds.
    const res = await daemonFetch('http://localhost:7700/api/llm', {}, {
      maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4, multiplier: 2, totalBudgetMs: 1000,
    });
    expect(res.ok).toBe(true);
    expect(fake).toHaveBeenCalledTimes(3);
    const out = stderr.join('');
    expect(out).toMatch(/retry 1\/5.*ECONNREFUSED/);
    expect(out).toMatch(/retry 2\/5.*ECONNREFUSED/);
  });

  it('surfaces the final error once maxAttempts is exhausted', async () => {
    const fake = vi.fn().mockRejectedValue(connRefusedError());
    globalThis.fetch = fake;
    await expect(daemonFetch('http://localhost:7700/api/llm', {}, {
      maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4, multiplier: 2, totalBudgetMs: 1000,
    })).rejects.toThrow(/fetch failed/);
    expect(fake).toHaveBeenCalledTimes(3);
    expect(stderr.join('')).toMatch(/giving up after attempt 3/);
  });

  it('does NOT retry a non-connection error (TypeError from bad body)', async () => {
    const fake = vi.fn().mockRejectedValue(new TypeError('Invalid URL'));
    globalThis.fetch = fake;
    await expect(daemonFetch('http://localhost:7700/api/llm', {})).rejects.toThrow(/Invalid URL/);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an AbortError from caller-driven timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fake = vi.fn().mockRejectedValue(abort);
    globalThis.fetch = fake;
    await expect(daemonFetch('http://localhost:7700/api/llm', {})).rejects.toThrow(/aborted/);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('recognizes ECONNRESET on the cause chain', async () => {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const fake = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = fake;
    const res = await daemonFetch('http://localhost:7700/api/llm', {}, {
      maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4, multiplier: 2, totalBudgetMs: 1000,
    });
    expect(res.ok).toBe(true);
    expect(fake).toHaveBeenCalledTimes(2);
  });
});
