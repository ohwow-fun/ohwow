/**
 * cronForIntervalMinutes unit tests. The helper converts the legacy
 * `xIntelIntervalMinutes` config into a cron expression the
 * LocalScheduler / cron-parser can evaluate.
 */
import { describe, it, expect } from 'vitest';
import { cronForIntervalMinutes } from '../scheduling.js';

describe('cronForIntervalMinutes', () => {
  it('180 min → every 3 hours on the hour', () => {
    // Expanded list so cron-parser advances cleanly across midnight.
    expect(cronForIntervalMinutes(180)).toBe('0 0,3,6,9,12,15,18,21 * * *');
  });

  it('60 min → every hour on the hour', () => {
    expect(cronForIntervalMinutes(60)).toBe('0 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 * * *');
  });

  it('360 min → every 6 hours', () => {
    expect(cronForIntervalMinutes(360)).toBe('0 0,6,12,18 * * *');
  });

  it('720 min → twice a day', () => {
    expect(cronForIntervalMinutes(720)).toBe('0 0,12 * * *');
  });

  it('5-hour cadence falls back to /N form (24 % 5 !== 0)', () => {
    expect(cronForIntervalMinutes(300)).toBe('0 */5 * * *');
  });

  it('sub-hour interval uses minute-step form', () => {
    expect(cronForIntervalMinutes(15)).toBe('*/15 * * * *');
    expect(cronForIntervalMinutes(45)).toBe('*/45 * * * *');
  });

  it('clamps zero / negative to 1 min', () => {
    expect(cronForIntervalMinutes(0)).toBe('*/1 * * * *');
    expect(cronForIntervalMinutes(-10)).toBe('*/1 * * * *');
  });
});
