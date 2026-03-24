/**
 * Shared utility for parsing tool call arguments from Ollama models.
 * Small models often return non-JSON, empty strings, or truncated JSON.
 * Instead of silently falling back to {}, we return a structured error
 * so the model can self-correct.
 */

export function parseToolArguments(
  raw: string | undefined,
  toolName: string,
): { args: Record<string, unknown>; error?: string } {
  const input = raw || '{}';
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { args: {}, error: `Tool "${toolName}": arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}` };
    }
    return { args: parsed as Record<string, unknown> };
  } catch {
    const preview = input.length > 200 ? input.slice(0, 200) + '...' : input;
    return { args: {}, error: `Tool "${toolName}": malformed JSON arguments: ${preview}` };
  }
}
