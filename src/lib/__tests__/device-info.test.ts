import { describe, it, expect } from 'vitest';
import { detectDevice, getMemoryTier, formatDeviceCompact } from '../device-info.js';
import type { DeviceInfo } from '../device-info.js';

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    arch: 'arm64',
    platform: 'darwin',
    totalMemoryGB: 16,
    freeMemoryGB: 10,
    cpuModel: 'Apple M1',
    cpuCores: 8,
    isAppleSilicon: true,
    hasNvidiaGpu: false,
    mlxAvailable: false,
    ...overrides,
  };
}

describe('getMemoryTier', () => {
  it('returns tiny for < 4 GB', () => {
    expect(getMemoryTier(makeDevice({ totalMemoryGB: 2 }))).toBe('tiny');
  });

  it('returns small for 4 GB (boundary: >= 4)', () => {
    expect(getMemoryTier(makeDevice({ totalMemoryGB: 4 }))).toBe('small');
  });

  it('returns medium for 8 GB', () => {
    expect(getMemoryTier(makeDevice({ totalMemoryGB: 8 }))).toBe('medium');
  });

  it('returns large for 16 GB', () => {
    expect(getMemoryTier(makeDevice({ totalMemoryGB: 16 }))).toBe('large');
  });

  it('returns xlarge for 32 GB', () => {
    expect(getMemoryTier(makeDevice({ totalMemoryGB: 32 }))).toBe('xlarge');
  });
});

describe('detectDevice', () => {
  it('returns all expected fields (not null/undefined)', () => {
    const info = detectDevice();
    expect(info.arch).toBeDefined();
    expect(info.platform).toBeDefined();
    expect(info.totalMemoryGB).toBeGreaterThan(0);
    expect(info.cpuModel).toBeDefined();
    expect(info.cpuCores).toBeGreaterThan(0);
    expect(typeof info.isAppleSilicon).toBe('boolean');
    expect(typeof info.hasNvidiaGpu).toBe('boolean');
  });
});

describe('formatDeviceCompact', () => {
  it('produces a non-empty string', () => {
    const result = formatDeviceCompact(makeDevice());
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes RAM amount', () => {
    const device = makeDevice({ totalMemoryGB: 32 });
    const result = formatDeviceCompact(device);
    expect(result).toContain('32 GB RAM');
  });

  it('includes Apple Silicon for arm64+darwin', () => {
    const device = makeDevice({ arch: 'arm64', platform: 'darwin', isAppleSilicon: true });
    const result = formatDeviceCompact(device);
    expect(result).toContain('Apple Silicon');
  });

  it('includes GPU name for NVIDIA device', () => {
    const device = makeDevice({
      isAppleSilicon: false,
      hasNvidiaGpu: true,
      gpuName: 'RTX 4090',
      arch: 'x64',
      platform: 'linux',
    });
    const result = formatDeviceCompact(device);
    expect(result).toContain('RTX 4090');
    expect(result).not.toContain('Apple Silicon');
  });
});
