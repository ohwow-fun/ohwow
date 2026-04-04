import { describe, it, expect } from 'vitest';
import {
  createDefaultCapabilities,
  createLlamaCppCapabilities,
  createMLXCapabilities,
  createOllamaCapabilities,
} from '../inference-capabilities.js';

describe('createDefaultCapabilities', () => {
  it('returns turboQuantActive=false', () => {
    const caps = createDefaultCapabilities();
    expect(caps.turboQuantActive).toBe(false);
    expect(caps.turboQuantBits).toBe(0);
    expect(caps.cacheTypeK).toBeNull();
    expect(caps.cacheTypeV).toBeNull();
    expect(caps.provider).toBe('ollama');
  });

  it('includes a timestamp', () => {
    const before = Date.now();
    const caps = createDefaultCapabilities();
    expect(caps.detectedAt).toBeGreaterThanOrEqual(before);
    expect(caps.detectedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('createLlamaCppCapabilities', () => {
  it('returns turboQuantActive=true with correct bits', () => {
    const caps = createLlamaCppCapabilities(4, 'turbo4', 'turbo4');
    expect(caps.turboQuantActive).toBe(true);
    expect(caps.turboQuantBits).toBe(4);
    expect(caps.cacheTypeK).toBe('turbo4');
    expect(caps.cacheTypeV).toBe('turbo4');
    expect(caps.provider).toBe('llama-cpp');
  });

  it('works with 2-bit and 3-bit', () => {
    const caps2 = createLlamaCppCapabilities(2, 'turbo2', 'turbo2');
    expect(caps2.turboQuantBits).toBe(2);

    const caps3 = createLlamaCppCapabilities(3, 'turbo3', 'turbo3');
    expect(caps3.turboQuantBits).toBe(3);
  });
});

describe('createMLXCapabilities', () => {
  it('returns turboQuantActive=true with mlx provider', () => {
    const caps = createMLXCapabilities(4, 'turboquant-4bit', 'turboquant-4bit');
    expect(caps.turboQuantActive).toBe(true);
    expect(caps.provider).toBe('mlx');
    expect(caps.turboQuantBits).toBe(4);
    expect(caps.cacheTypeK).toBe('turboquant-4bit');
    expect(caps.cacheTypeV).toBe('turboquant-4bit');
  });

  it('works with 2-bit and 3-bit', () => {
    const caps2 = createMLXCapabilities(2, 'turboquant-2bit', 'turboquant-2bit');
    expect(caps2.turboQuantBits).toBe(2);

    const caps3 = createMLXCapabilities(3, 'turboquant-3bit', 'turboquant-3bit');
    expect(caps3.turboQuantBits).toBe(3);
  });
});

describe('createOllamaCapabilities', () => {
  it('returns turboQuantActive=true with ollama provider', () => {
    const caps = createOllamaCapabilities(4, 'turbo4', 'turbo4');
    expect(caps.turboQuantActive).toBe(true);
    expect(caps.provider).toBe('ollama');
    expect(caps.turboQuantBits).toBe(4);
  });
});
