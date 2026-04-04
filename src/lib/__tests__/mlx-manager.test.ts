import { describe, it, expect } from 'vitest';
import { MLXManager } from '../mlx-manager.js';

describe('MLXManager', () => {
  it('getUrl returns default when not started', () => {
    const manager = new MLXManager();
    expect(manager.getUrl()).toBe('http://127.0.0.1:8090');
  });

  it('isRunning returns false when not started', async () => {
    const manager = new MLXManager();
    expect(await manager.isRunning()).toBe(false);
  });

  it('stop is safe to call when not started', async () => {
    const manager = new MLXManager();
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('getCapabilities returns null before start', () => {
    const manager = new MLXManager();
    expect(manager.getCapabilities()).toBeNull();
  });

  it('getModel returns null before start', () => {
    const manager = new MLXManager();
    expect(manager.getModel()).toBeNull();
  });

  it('checkAvailable returns false when mlx-vlm is not installed', () => {
    // On CI/non-macOS this will always be false
    const result = MLXManager.checkAvailable('nonexistent-python');
    expect(result).toBe(false);
  });
});
