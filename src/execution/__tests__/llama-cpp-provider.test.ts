import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlamaCppProvider } from '../providers/llama-cpp-provider.js';

describe('LlamaCppProvider', () => {
  let provider: LlamaCppProvider;

  beforeEach(() => {
    provider = new LlamaCppProvider('http://localhost:8085', 'qwen3:4b');
  });

  it('has name llama-cpp', () => {
    expect(provider.name).toBe('llama-cpp');
  });

  it('getDefaultModel returns the configured model', () => {
    expect(provider.getDefaultModel()).toBe('qwen3:4b');
  });

  it('setDefaultModel changes the model', () => {
    provider.setDefaultModel('llama3.1:8b');
    expect(provider.getDefaultModel()).toBe('llama3.1:8b');
  });

  it('resetAvailability resets the cache', async () => {
    // Mock fetch to return a health check
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await provider.isAvailable();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call uses cache
    await provider.isAvailable();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Reset forces re-check
    provider.resetAvailability();
    await provider.isAvailable();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('isAvailable checks /health endpoint (not /api/tags)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await provider.isAvailable();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8085/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    vi.unstubAllGlobals();
  });

  it('isAvailable returns false on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const available = await provider.isAvailable();
    expect(available).toBe(false);

    vi.unstubAllGlobals();
  });

  it('createMessage does not send options.num_ctx', async () => {
    let capturedBody: string | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hello!' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.createMessage({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    // Should NOT have options.num_ctx (that's Ollama-specific)
    expect(parsed.options).toBeUndefined();
    // Should have the standard fields
    expect(parsed.model).toBe('qwen3:4b');
    expect(parsed.stream).toBe(false);

    vi.unstubAllGlobals();
  });

  it('createMessage returns llama-cpp provider tag', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.createMessage({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.provider).toBe('llama-cpp');
    expect(result.content).toBe('Response');

    vi.unstubAllGlobals();
  });

  it('createMessageWithTools does not send options.num_ctx', async () => {
    let capturedBody: string | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'OK', tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.createMessageWithTools({
      messages: [{ role: 'user', content: 'Get weather' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } },
      }],
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.options).toBeUndefined();
    expect(parsed.tools).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('fires response callback on successful createMessage', async () => {
    const cb = vi.fn();
    provider.setResponseCallback(cb);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.createMessage({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(cb).toHaveBeenCalledWith('qwen3:4b', 10, 5, expect.any(Number));

    vi.unstubAllGlobals();
  });
});
