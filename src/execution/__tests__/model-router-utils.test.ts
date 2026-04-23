/**
 * Tests for pure utility functions in model-router.ts
 *
 * - shouldForceLocalForBurn: burn-level routing guard
 * - inferProviderFromModel: provider inference from model string
 */

import { describe, it, expect } from 'vitest';
import { shouldForceLocalForBurn, inferProviderFromModel } from '../model-router.js';

describe('shouldForceLocalForBurn', () => {
  it('returns false when burnLevel=0 and callerForceLocal=false', () => {
    expect(shouldForceLocalForBurn(0, false)).toBe(false);
  });

  it('returns true when callerForceLocal=true regardless of burnLevel', () => {
    expect(shouldForceLocalForBurn(0, true)).toBe(true);
    expect(shouldForceLocalForBurn(1, true)).toBe(true);
    expect(shouldForceLocalForBurn(2, true)).toBe(true);
  });

  it('returns true when burnLevel=1 and callerForceLocal=false', () => {
    expect(shouldForceLocalForBurn(1, false)).toBe(true);
  });

  it('returns true when burnLevel=2 and callerForceLocal=false', () => {
    expect(shouldForceLocalForBurn(2, false)).toBe(true);
  });
});

describe('inferProviderFromModel', () => {
  it('returns null for empty string', () => {
    expect(inferProviderFromModel('')).toBeNull();
  });

  it('returns "anthropic" for claude- prefix', () => {
    expect(inferProviderFromModel('claude-haiku-4-5')).toBe('anthropic');
    expect(inferProviderFromModel('claude-sonnet-4-6')).toBe('anthropic');
    expect(inferProviderFromModel('claude-opus-4-7')).toBe('anthropic');
  });

  it('returns "mlx" for mlx-community/ prefix', () => {
    expect(inferProviderFromModel('mlx-community/Llama-3.2-3B')).toBe('mlx');
    expect(inferProviderFromModel('mlx-community/gemma-2b')).toBe('mlx');
  });

  it('returns "openrouter" for other slash-containing model strings', () => {
    expect(inferProviderFromModel('anthropic/claude-haiku-4-5')).toBe('openrouter');
    expect(inferProviderFromModel('meta-llama/llama-3-8b')).toBe('openrouter');
  });

  it('returns "ollama" for colon-containing model strings', () => {
    expect(inferProviderFromModel('llama3:8b')).toBe('ollama');
    expect(inferProviderFromModel('mistral:latest')).toBe('ollama');
    expect(inferProviderFromModel('qwen2.5:7b')).toBe('ollama');
  });

  it('returns null for plain model names with no prefix or separator', () => {
    expect(inferProviderFromModel('gpt-4o')).toBeNull();
    expect(inferProviderFromModel('unknown-model')).toBeNull();
  });
});
