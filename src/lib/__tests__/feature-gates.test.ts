import { describe, it, expect } from 'vitest';
import { isCloudConnected, getLockedCloudFeatures, getNavVisibility, CLOUD_FEATURES } from '../feature-gates.js';

describe('isCloudConnected', () => {
  it('returns true for connected tier', () => {
    expect(isCloudConnected('connected')).toBe(true);
  });

  it('returns false for free tier', () => {
    expect(isCloudConnected('free')).toBe(false);
  });
});

describe('getLockedCloudFeatures', () => {
  it('returns all cloud features for free tier', () => {
    const features = getLockedCloudFeatures('free');
    expect(features.length).toBe(CLOUD_FEATURES.length);
    expect(features.some((f) => f.feature === 'cloud_sync')).toBe(true);
    expect(features.some((f) => f.feature === 'cloud_dashboard')).toBe(true);
    for (const f of features) {
      expect(f).toHaveProperty('feature');
      expect(f).toHaveProperty('label');
      expect(f).toHaveProperty('description');
    }
  });

  it('returns empty for connected tier', () => {
    const features = getLockedCloudFeatures('connected');
    expect(features.length).toBe(0);
  });
});

describe('getNavVisibility', () => {
  it('returns all nav items as visible for free tier', () => {
    const nav = getNavVisibility('free');
    expect(nav.dashboard).toBe(true);
    expect(nav.agents).toBe(true);
    expect(nav.tasks).toBe(true);
    expect(nav.settings).toBe(true);
  });

  it('returns all nav items as visible for connected tier', () => {
    const nav = getNavVisibility('connected');
    expect(nav.dashboard).toBe(true);
    expect(nav.agents).toBe(true);
    expect(nav.chat).toBe(true);
  });
});
