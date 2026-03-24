/**
 * API Client
 * Fetch wrapper that attaches the local session token from localStorage.
 */

const API_BASE = import.meta.env.DEV ? '' : '';

export function getToken(): string | null {
  return localStorage.getItem('ohwow-session-token');
}

export function setToken(token: string) {
  localStorage.setItem('ohwow-session-token', token);
}

export function clearToken() {
  localStorage.removeItem('ohwow-session-token');
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/ui/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * SSE streaming for chat endpoint.
 * Returns an async generator of parsed events.
 */
export async function* streamChat(
  message: string,
  sessionId?: string,
  model?: string,
): AsyncGenerator<Record<string, unknown>> {
  const token = getToken();

  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message, sessionId, model }),
  });

  if (!res.ok || !res.body) {
    throw new Error('Chat request failed');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }
}
