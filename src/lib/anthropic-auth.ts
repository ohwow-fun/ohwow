/**
 * Anthropic Authentication
 * API key validation for Claude cloud models.
 */

/**
 * Validate an Anthropic API key by making a lightweight count-tokens request.
 * Only 401 means the key is invalid. Any other response (200, 400, 403, etc.)
 * means the key itself is recognized by Anthropic.
 */
export async function validateAnthropicApiKey(key: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // 401 = invalid key. Anything else (200, 400, 403) = key is valid
    return res.status !== 401;
  } catch {
    return false;
  }
}
