import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MLXProvider } from '../providers/mlx-provider.js';

describe('MLXProvider', () => {
  let provider: MLXProvider;

  beforeEach(() => {
    provider = new MLXProvider('http://localhost:8090', 'mlx-community/gemma-4-e4b-it-4bit');
  });

  it('has name mlx', () => {
    expect(provider.name).toBe('mlx');
  });

  it('getDefaultModel returns the configured model', () => {
    expect(provider.getDefaultModel()).toBe('mlx-community/gemma-4-e4b-it-4bit');
  });

  it('setDefaultModel changes the model', () => {
    provider.setDefaultModel('mlx-community/gemma-4-e2b-it-4bit');
    expect(provider.getDefaultModel()).toBe('mlx-community/gemma-4-e2b-it-4bit');
  });

  it('resetAvailability resets the cache', async () => {
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

  it('isAvailable checks /health endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await provider.isAvailable();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8090/health',
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

  it('createMessage returns mlx provider tag', async () => {
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

    expect(result.provider).toBe('mlx');
    expect(result.content).toBe('Response');

    vi.unstubAllGlobals();
  });

  it('createMessage sends to /v1/chat/completions', async () => {
    let capturedUrl: string | undefined;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.createMessage({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedUrl).toBe('http://localhost:8090/v1/chat/completions');

    vi.unstubAllGlobals();
  });

  it('createMessageWithTools sends tools array', async () => {
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
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].function.name).toBe('get_weather');

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

    expect(cb).toHaveBeenCalledWith('mlx-community/gemma-4-e4b-it-4bit', 10, 5, expect.any(Number));

    vi.unstubAllGlobals();
  });
});
