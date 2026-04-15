import { describe, it, expect, vi } from 'vitest';
import { shouldForceLocalForBurn, ModelRouter } from '../model-router.js';

describe('shouldForceLocalForBurn', () => {
  it('returns true when caller already forced local', () => {
    expect(shouldForceLocalForBurn(0, true)).toBe(true);
  });
  it('returns false when no throttle and caller did not force', () => {
    expect(shouldForceLocalForBurn(0, false)).toBe(false);
  });
  it('returns true at level 1 even without caller force', () => {
    expect(shouldForceLocalForBurn(1, false)).toBe(true);
  });
  it('returns true at level 2', () => {
    expect(shouldForceLocalForBurn(2, false)).toBe(true);
  });
});

describe('ModelRouter.setBurnThrottleProvider', () => {
  it('starts null and can be set / cleared', () => {
    const router = new ModelRouter({});
    expect(router.getBurnThrottleProvider()).toBeNull();
    const fn = () => 1 as const;
    router.setBurnThrottleProvider(fn);
    expect(router.getBurnThrottleProvider()).toBe(fn);
    router.setBurnThrottleProvider(null);
    expect(router.getBurnThrottleProvider()).toBeNull();
  });

  it('provider function is called once per selectForPurpose invocation', async () => {
    const router = new ModelRouter({ ollamaUrl: 'http://localhost:11434', ollamaModel: 'test' });
    const provider = vi.fn(() => 0 as const);
    router.setBurnThrottleProvider(provider);
    try {
      await router.selectForPurpose({ purpose: 'reasoning' });
    } catch {
      // ollama unreachable in test env — fine. We only need to verify the hook fires.
    }
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
