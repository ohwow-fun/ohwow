import { describe, it, expect } from 'vitest';
import { inferParameterTier, getParameterTier, computeDynamicNumCtx, getWorkingNumCtx } from '../ollama-models.js';
import type { DeviceInfo } from '../device-info.js';

function makeDevice(totalMemoryGB: number): DeviceInfo {
  return {
    arch: 'arm64',
    platform: 'darwin',
    totalMemoryGB,
    cpuModel: 'Apple M1',
    cpuCores: 8,
    isAppleSilicon: true,
    hasNvidiaGpu: false,
  };
}

describe('inferParameterTier', () => {
  it('returns micro for sub-1GB models', () => {
    expect(inferParameterTier(0.5)).toBe('micro');
    expect(inferParameterTier(0.8)).toBe('micro');
  });

  it('returns small for 1-3GB models', () => {
    expect(inferParameterTier(1.0)).toBe('small');
    expect(inferParameterTier(2.5)).toBe('small');
  });

  it('returns medium for 3-7GB models', () => {
    expect(inferParameterTier(3.0)).toBe('medium');
    expect(inferParameterTier(5.0)).toBe('medium');
  });

  it('returns large for 7GB+ models', () => {
    expect(inferParameterTier(7.0)).toBe('large');
    expect(inferParameterTier(20)).toBe('large');
  });
});

describe('getParameterTier', () => {
  it('returns correct tier for known models', () => {
    expect(getParameterTier('qwen3:0.6b')).toBe('micro');
    expect(getParameterTier('qwen3:4b')).toBe('small'); // 2.5GB file size
    expect(getParameterTier('qwen3:8b')).toBe('medium'); // 5.2GB file size
    expect(getParameterTier('qwen2.5:14b')).toBe('large'); // 9.0GB file size
  });

  it('returns medium for unknown models', () => {
    expect(getParameterTier('unknown-model')).toBe('medium');
  });
});

describe('computeDynamicNumCtx', () => {
  it('returns model native context for high-RAM devices', () => {
    // qwen3:4b has 256K context, 2.5GB size
    // On 64GB Mac: availableRAM = 64*0.75 - 2.5 = 45.5GB, tokens = ~23M
    // Capped by native context (262144) and ramSafetyCap (131072)
    const result = computeDynamicNumCtx('qwen3:4b', makeDevice(64));
    expect(result).toBe(131_072); // ramSafetyCap for >= 16GB
  });

  it('applies lower safety cap for low-RAM devices', () => {
    const result = computeDynamicNumCtx('qwen3:4b', makeDevice(8));
    // 8GB * 0.75 - 2.5 = 3.5GB → tokens = ~1.8M, capped by 65536 (< 16GB safety)
    expect(result).toBe(65_536);
  });

  it('returns minimum 4096 when RAM is barely sufficient', () => {
    const result = computeDynamicNumCtx('qwen3:4b', makeDevice(3));
    // 3*0.75 - 2.5 = -0.25GB → negative available RAM
    expect(result).toBe(4096);
  });

  it('respects model native context when smaller than RAM-based limit', () => {
    // phi4-mini has 16K context, 2.5GB size
    const result = computeDynamicNumCtx('phi4-mini', makeDevice(32));
    expect(result).toBe(16_384); // native context is the binding cap
  });

  it('falls back to conservative defaults for unknown models', () => {
    const result = computeDynamicNumCtx('unknown-model', makeDevice(16));
    // Uses default 2.5GB model size, 8192 default context
    expect(result).toBeGreaterThanOrEqual(4096);
    expect(result).toBeLessThanOrEqual(65_536);
  });
});

describe('getWorkingNumCtx with device', () => {
  it('uses dynamic sizing when device is provided', () => {
    const withDevice = getWorkingNumCtx('qwen3:4b', undefined, makeDevice(32));
    const withoutDevice = getWorkingNumCtx('qwen3:4b');
    expect(withDevice).toBeGreaterThan(withoutDevice);
  });

  it('falls back to fixed cap when no device provided', () => {
    const result = getWorkingNumCtx('qwen3:4b');
    expect(result).toBe(16_384); // default cap
  });
});
