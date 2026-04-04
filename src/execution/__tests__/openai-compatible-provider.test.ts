import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleProvider } from '../providers/openai-compatible-provider.js';

describe('OpenAICompatibleProvider', () => {
  let provider: OpenAICompatibleProvider;

  beforeEach(() => {
    provider = new OpenAICompatibleProvider('http://localhost:8000', 'mistral-7b');
  });

  it('has name openai-compatible', () => {
    expect(provider.name).toBe('openai-compatible');
  });

  it('getDefaultModel returns the configured model', () => {
    expect(provider.getDefaultModel()).toBe('mistral-7b');
  });

  it('setDefaultModel changes the model', () => {
    provider.setDefaultModel('llama3.1:8b');
    expect(provider.getDefaultModel()).toBe('llama3.1:8b');
  });

  it('createMessage calls /v1/chat/completions with correct model and messages', async () => {
    let capturedUrl = '';
    let capturedBody: string | undefined;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      capturedUrl = url;
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

    const result = await provider.createMessage({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedUrl).toBe('http://localhost:8000/v1/chat/completions');
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe('mistral-7b');
    expect(parsed.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(parsed.stream).toBe(false);
    expect(parsed.options).toBeUndefined();
    expect(result.provider).toBe('openai-compatible');
    expect(result.content).toBe('Hello!');

    vi.unstubAllGlobals();
  });

  it('includes auth header when apiKey is provided', async () => {
    const authedProvider = new OpenAICompatibleProvider('http://localhost:8000', 'mistral-7b', 'sk-test-key');
    let capturedHeaders: unknown;
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await authedProvider.createMessage({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedHeaders).toEqual(expect.objectContaining({
      'Authorization': 'Bearer sk-test-key',
      'Content-Type': 'application/json',
    }));

    vi.unstubAllGlobals();
  });

  it('omits auth header when no apiKey', async () => {
    let capturedHeaders: unknown;
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await provider.createMessage({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const headers = capturedHeaders as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');

    vi.unstubAllGlobals();
  });

  it('isAvailable returns true on 200 from /v1/models', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const available = await provider.isAvailable();

    expect(available).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/v1/models',
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

  it('isAvailable sends auth header when apiKey is provided', async () => {
    const authedProvider = new OpenAICompatibleProvider('http://localhost:8000', 'mistral-7b', 'sk-test-key');
    let capturedHeaders: unknown;
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal('fetch', mockFetch);

    await authedProvider.isAvailable();

    const headers = capturedHeaders as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key');

    vi.unstubAllGlobals();
  });

  it('availability is cached for TTL duration', async () => {
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

  it('createMessageWithTools sends tools and returns tool calls', async () => {
    let capturedBody: string | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'OK', tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
          ] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.createMessageWithTools({
      messages: [{ role: 'user', content: 'Get weather' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } },
      }],
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tool_choice).toBe('auto');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');

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

    expect(cb).toHaveBeenCalledWith('mistral-7b', 10, 5, expect.any(Number));

    vi.unstubAllGlobals();
  });
});
