import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveCapCents } from '../experiments/burn-guard.js';
import { _resetRuntimeConfigCacheForTests, _seedRuntimeConfigCacheForTests } from '../runtime-config.js';

describe('resolveCapCents', () => {
  beforeEach(() => {
    _resetRuntimeConfigCacheForTests();
    delete process.env.OHWOW_BURN_DAILY_CAP_CENTS;
  });
  afterEach(() => {
    _resetRuntimeConfigCacheForTests();
    delete process.env.OHWOW_BURN_DAILY_CAP_CENTS;
  });

  it('returns null when neither env nor config is set', () => {
    const r = resolveCapCents();
    expect(r.cap).toBeNull();
    expect(r.source).toBe('none');
  });

  it('reads env var when set', () => {
    process.env.OHWOW_BURN_DAILY_CAP_CENTS = '5000';
    const r = resolveCapCents();
    expect(r.cap).toBe(5000);
    expect(r.source).toBe('env');
  });

  it('falls back to runtime config when env is not set', () => {
    _seedRuntimeConfigCacheForTests('burn.daily_cap_cents', 7500);
    const r = resolveCapCents();
    expect(r.cap).toBe(7500);
    expect(r.source).toBe('runtime_config');
  });

  it('env wins over runtime config', () => {
    process.env.OHWOW_BURN_DAILY_CAP_CENTS = '5000';
    _seedRuntimeConfigCacheForTests('burn.daily_cap_cents', 7500);
    const r = resolveCapCents();
    expect(r.cap).toBe(5000);
    expect(r.source).toBe('env');
  });

  it('ignores zero/negative/non-finite values', () => {
    process.env.OHWOW_BURN_DAILY_CAP_CENTS = '-100';
    expect(resolveCapCents().cap).toBeNull();
    process.env.OHWOW_BURN_DAILY_CAP_CENTS = 'abc';
    expect(resolveCapCents().cap).toBeNull();
    process.env.OHWOW_BURN_DAILY_CAP_CENTS = '0';
    expect(resolveCapCents().cap).toBeNull();
  });

  it('floors fractional env values', () => {
    process.env.OHWOW_BURN_DAILY_CAP_CENTS = '3499.9';
    expect(resolveCapCents().cap).toBe(3499);
  });
});
