import { describe, expect, it } from 'vitest';

import { YTSelectorMissingError, YTTimeoutError } from '../errors.js';
import {
  waitForNoSelector,
  waitForPredicate,
  waitForSelector,
  waitForSelectorStable,
  waitForText,
} from '../wait.js';

/**
 * The wait helpers only call page.evaluate(expr). We mock just that —
 * no real CDP, no browser. The mock decides what each expression
 * returns by inspecting the expression string.
 */

type MockEvaluator = (expr: string) => Promise<unknown>;

function mockPage(evaluator: MockEvaluator): any {
  return { evaluate: evaluator };
}

describe('waitForSelector', () => {
  it('resolves once the selector appears in the DOM', async () => {
    let calls = 0;
    const page = mockPage(async () => {
      calls += 1;
      return calls >= 3;
    });
    await expect(waitForSelector(page, '#foo', { timeoutMs: 5_000 })).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('throws YTSelectorMissingError on timeout', async () => {
    const page = mockPage(async () => false);
    await expect(
      waitForSelector(page, '#never', { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(YTSelectorMissingError);
  });

  it('error names the selector and visibility mode', async () => {
    const page = mockPage(async () => false);
    try {
      await waitForSelector(page, '#stuck', { timeoutMs: 200, visible: true, label: 'stuck elem' });
      throw new Error('expected throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(YTSelectorMissingError);
      expect(err.selector).toBe('#stuck');
      expect(err.message).toContain('stuck elem');
      expect(err.message).toContain('visible');
    }
  });
});

describe('waitForNoSelector', () => {
  it('resolves when the selector disappears', async () => {
    let present = true;
    setTimeout(() => { present = false; }, 100);
    const page = mockPage(async () => present);
    await expect(waitForNoSelector(page, '#dialog', { timeoutMs: 5_000 })).resolves.toBeUndefined();
  });

  it('throws YTTimeoutError when the selector stays present', async () => {
    const page = mockPage(async () => true);
    await expect(
      waitForNoSelector(page, '#stays', { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(YTTimeoutError);
  });
});

describe('waitForPredicate', () => {
  it('resolves when the predicate expression holds', async () => {
    let hit = 0;
    const page = mockPage(async () => ++hit >= 2);
    await expect(waitForPredicate(page, 'true', { timeoutMs: 5_000 })).resolves.toBeUndefined();
  });

  it('throws YTTimeoutError on never-true predicate', async () => {
    const page = mockPage(async () => false);
    await expect(
      waitForPredicate(page, 'false', { timeoutMs: 200, label: 'stuck-pred' }),
    ).rejects.toBeInstanceOf(YTTimeoutError);
  });
});

describe('waitForText', () => {
  it('resolves when selector text matches the regex', async () => {
    let state = 'loading';
    setTimeout(() => { state = 'Done'; }, 50);
    const page = mockPage(async (expr) => {
      return /Done/.test(state) && /Done/.test(expr);
    });
    await expect(waitForText(page, '#btn', /Done/, { timeoutMs: 2_000 })).resolves.toBeUndefined();
  });

  it('throws YTTimeoutError when the regex never matches', async () => {
    const page = mockPage(async () => false);
    await expect(waitForText(page, '#btn', /Ready/, { timeoutMs: 200 })).rejects.toBeInstanceOf(YTTimeoutError);
  });
});

describe('waitForSelectorStable', () => {
  it('resolves after the selector has been present for stableMs', async () => {
    let presentSince: number | null = null;
    const page = mockPage(async () => {
      if (presentSince == null) presentSince = Date.now();
      return true;
    });
    await expect(
      waitForSelectorStable(page, '#x', 200, { timeoutMs: 2_000 }),
    ).resolves.toBeUndefined();
  });

  it('restarts the stable timer on disappearance', async () => {
    const start = Date.now();
    let flips = 0;
    const page = mockPage(async () => {
      flips += 1;
      // Present→absent→present pattern for first ~400ms, then stable.
      if (flips < 4) return flips % 2 === 1;
      return true;
    });
    await waitForSelectorStable(page, '#flappy', 200, { timeoutMs: 5_000 });
    // No explicit timing assertion — only that it resolves despite flapping.
    expect(Date.now() - start).toBeGreaterThan(200);
  });

  it('throws YTTimeoutError when never stable long enough', async () => {
    const page = mockPage(async () => false);
    await expect(
      waitForSelectorStable(page, '#ghost', 500, { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(YTTimeoutError);
  });
});
