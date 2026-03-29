import { describe, it, expect } from 'vitest';
import { parseModelTag } from '../llama-cpp-gguf.js';

describe('parseModelTag', () => {
  it('splits name and variant', () => {
    expect(parseModelTag('qwen3:4b')).toEqual({ name: 'qwen3', variant: '4b' });
    expect(parseModelTag('llama3.1:8b')).toEqual({ name: 'llama3.1', variant: '8b' });
  });

  it('defaults variant to latest when missing', () => {
    expect(parseModelTag('qwen3')).toEqual({ name: 'qwen3', variant: 'latest' });
  });

  it('handles complex tags', () => {
    expect(parseModelTag('gemma3:12b-it-qat')).toEqual({ name: 'gemma3', variant: '12b-it-qat' });
    expect(parseModelTag('qwen3.5:27b-q4_K_M')).toEqual({ name: 'qwen3.5', variant: '27b-q4_K_M' });
  });
});
