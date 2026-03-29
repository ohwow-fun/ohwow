import { describe, it, expect } from 'vitest';
import { LlamaCppManager } from '../llama-cpp-manager.js';

describe('LlamaCppManager.cacheTypeFromBits', () => {
  it('maps 2 to turbo2', () => {
    expect(LlamaCppManager.cacheTypeFromBits(2)).toBe('turbo2');
  });

  it('maps 3 to turbo3', () => {
    expect(LlamaCppManager.cacheTypeFromBits(3)).toBe('turbo3');
  });

  it('maps 4 to turbo4', () => {
    expect(LlamaCppManager.cacheTypeFromBits(4)).toBe('turbo4');
  });
});

describe('LlamaCppManager', () => {
  it('getUrl returns default when not started', () => {
    const manager = new LlamaCppManager();
    expect(manager.getUrl()).toBe('http://127.0.0.1:8085');
  });

  it('isRunning returns false when not started', async () => {
    const manager = new LlamaCppManager();
    expect(await manager.isRunning()).toBe(false);
  });

  it('stop is safe to call when not started', async () => {
    const manager = new LlamaCppManager();
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
