import { describe, it, expect } from 'vitest';
import { shouldForceLocalForBurn, inferProviderFromModel } from '../model-router.js';

describe('shouldForceLocalForBurn', () => {
  it('returns false when burnLevel=0 and callerForceLocal=false', () => {
    const result = shouldForceLocalForBurn(0, false);
    expect(result).toBe(false);
  });

  it('returns true when callerForceLocal=true regardless of burnLevel', () => {
    expect(shouldForceLocalForBurn(0, true)).toBe(true);
    expect(shouldForceLocalForBurn(1, true)).toBe(true);
    expect(shouldForceLocalForBurn(2, true)).toBe(true);
  });

  it('returns true when burnLevel=1 and callerForceLocal=false', () => {
    const result = shouldForceLocalForBurn(1, false);
    expect(result).toBe(true);
  });

  it('returns true when burnLevel=2 and callerForceLocal=false', () => {
    const result = shouldForceLocalForBurn(2, false);
    expect(result).toBe(true);
  });
});

describe('inferProviderFromModel', () => {
  it('returns "anthropic" for a model starting with "claude-"', () => {
    const result = inferProviderFromModel('claude-3-5-sonnet-20241022');
    expect(result).toBe('anthropic');
  });

  it('returns "anthropic" for various claude models', () => {
    expect(inferProviderFromModel('claude-opus')).toBe('anthropic');
    expect(inferProviderFromModel('claude-haiku-4-5-20251001')).toBe('anthropic');
  });

  it('returns "mlx" for a model starting with "mlx-community/"', () => {
    const result = inferProviderFromModel('mlx-community/Mistral-7B-Instruct-v0.1');
    expect(result).toBe('mlx');
  });

  it('returns "openrouter" for a model containing "/" but not starting with "mlx-community/"', () => {
    expect(inferProviderFromModel('meta-llama/llama-2-70b')).toBe('openrouter');
    expect(inferProviderFromModel('anthropic/claude-3')).toBe('openrouter');
    expect(inferProviderFromModel('deepseek/deepseek-chat')).toBe('openrouter');
  });

  it('returns "ollama" for a model containing ":" (e.g. "llama3:8b")', () => {
    expect(inferProviderFromModel('llama3:8b')).toBe('ollama');
    expect(inferProviderFromModel('qwen:0.6b')).toBe('ollama');
    expect(inferProviderFromModel('gemma2:9b')).toBe('ollama');
  });

  it('returns null for an unrecognised model string with no special characters', () => {
    const result = inferProviderFromModel('unknownmodel');
    expect(result).toBeNull();
  });

  it('returns null for an empty string', () => {
    const result = inferProviderFromModel('');
    expect(result).toBeNull();
  });
});
