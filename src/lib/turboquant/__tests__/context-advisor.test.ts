import { describe, it, expect } from 'vitest';
import {
  effectiveCompressionRatio,
  getFamilyCompressionRatio,
  computeEnhancedNumCtx,
} from '../context-advisor.js';
import type { DeviceInfo } from '../../device-info.js';

function makeDevice(totalMemoryGB: number, freeMemoryGB?: number): DeviceInfo {
  return {
    arch: 'arm64',
    platform: 'darwin',
    totalMemoryGB,
    freeMemoryGB: freeMemoryGB ?? totalMemoryGB * 0.6,
    cpuModel: 'Apple M1',
    cpuCores: 8,
    isAppleSilicon: true,
    hasNvidiaGpu: false,
    mlxAvailable: false,
  };
}

describe('effectiveCompressionRatio', () => {
  it('returns ~3.8 for 4-bit (16/4 * 0.95)', () => {
    expect(effectiveCompressionRatio(4)).toBeCloseTo(3.8, 1);
  });

  it('returns ~7.6 for 2-bit (16/2 * 0.95)', () => {
    expect(effectiveCompressionRatio(2)).toBeCloseTo(7.6, 1);
  });

  it('returns ~5.07 for 3-bit', () => {
    expect(effectiveCompressionRatio(3)).toBeCloseTo(5.07, 1);
  });
});

describe('getFamilyCompressionRatio', () => {
  it('returns higher ratios for known families', () => {
    expect(getFamilyCompressionRatio('qwen', 4)).toBe(3.8);
    expect(getFamilyCompressionRatio('llama', 4)).toBe(3.8);
    expect(getFamilyCompressionRatio('gemma', 4)).toBe(4.0);
  });

  it('returns lower ratios for deepseek (MLA already compresses)', () => {
    expect(getFamilyCompressionRatio('deepseek', 4)).toBe(1.5);
    expect(getFamilyCompressionRatio('deepseek', 2)).toBe(2.5);
  });

  it('returns conservative defaults for unknown families', () => {
    const ratio = getFamilyCompressionRatio('unknown-family', 4);
    expect(ratio).toBe(3.0);
  });

  it('2-bit ratios are higher than 4-bit', () => {
    for (const family of ['qwen', 'llama', 'gemma', 'phi']) {
      expect(getFamilyCompressionRatio(family, 2))
        .toBeGreaterThan(getFamilyCompressionRatio(family, 4));
    }
  });
});

describe('computeEnhancedNumCtx', () => {
  it('returns enhanced > standard for supported families', () => {
    const device = makeDevice(16);
    const advisory = computeEnhancedNumCtx('qwen3:4b', device, 'qwen', 4);

    expect(advisory.enhancedNumCtx).toBeGreaterThan(advisory.standardNumCtx);
    expect(advisory.modelSupported).toBe(true);
    expect(advisory.compressionRatio).toBe(3.8);
  });

  it('provides a helpful explanation', () => {
    const device = makeDevice(16);
    const advisory = computeEnhancedNumCtx('qwen3:4b', device, 'qwen', 4);

    expect(advisory.explanation).toContain('TurboQuant');
    expect(advisory.explanation).toContain('4-bit');
  });

  it('returns minimum context when RAM is insufficient', () => {
    const device = makeDevice(4, 2); // very low RAM
    const advisory = computeEnhancedNumCtx('qwen3:4b', device, 'qwen', 4);

    expect(advisory.standardNumCtx).toBe(4096);
    expect(advisory.enhancedNumCtx).toBe(4096);
    expect(advisory.modelSupported).toBe(false);
  });

  it('respects native context size cap', () => {
    // Model with small native context on a huge machine
    const device = makeDevice(128);
    // phi4-mini has 16K context
    const advisory = computeEnhancedNumCtx('phi4-mini', device, 'phi', 4);

    // Both should be capped at native context size
    expect(advisory.standardNumCtx).toBeLessThanOrEqual(16_384);
    expect(advisory.enhancedNumCtx).toBeLessThanOrEqual(16_384);
  });

  it('uses raised safety caps with TurboQuant', () => {
    const device = makeDevice(12); // < 16GB
    const advisory = computeEnhancedNumCtx('qwen3:4b', device, 'qwen', 4);

    // Standard cap for <16GB is 65K, TurboQuant raises it to 131K
    // Enhanced should be able to exceed 65K if RAM allows
    expect(advisory.enhancedNumCtx).toBeGreaterThanOrEqual(advisory.standardNumCtx);
  });

  it('2-bit gives higher enhancement than 4-bit', () => {
    const device = makeDevice(32);
    const advisory2 = computeEnhancedNumCtx('qwen3:8b', device, 'qwen', 2);
    const advisory4 = computeEnhancedNumCtx('qwen3:8b', device, 'qwen', 4);

    expect(advisory2.enhancedNumCtx).toBeGreaterThanOrEqual(advisory4.enhancedNumCtx);
    expect(advisory2.compressionRatio).toBeGreaterThan(advisory4.compressionRatio);
  });
});
