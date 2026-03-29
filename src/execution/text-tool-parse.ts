/**
 * Text-based tool call parser.
 *
 * Catches tool calls that models emit as markdown code blocks instead of
 * structured tool_use / tool_calls. Acts as a resilience layer when
 * structured tool calling fails or isn't available.
 */

export interface ExtractedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface TextToolParseResult {
  toolCalls: ExtractedToolCall[];
  cleanedText: string;
}

/**
 * Extract tool calls embedded as markdown code blocks in model text output.
 *
 * Supported formats (in priority order):
 *
 * 1. ```tool_call\n{"tool":"name","arguments":{...}}\n```
 * 2. ```tool_call\ntool_name\n{"arg":"val"}\n```
 * 3. ```\ntool_name\n```           (bare tool name, no args)
 * 4. ```tool_name\n```             (tool name as language tag)
 */
export function extractToolCallsFromText(
  text: string,
  knownToolNames: Set<string>,
): TextToolParseResult {
  const toolCalls: ExtractedToolCall[] = [];
  let cleanedText = text;

  // Pass 1: ```tool_call blocks (structured format from system prompt guidance)
  const toolCallBlockRe = /```tool_call\n([\s\S]*?)```/g;
  for (const match of text.matchAll(toolCallBlockRe)) {
    const body = match[1].trim();
    const parsed = tryParseToolCallJSON(body, knownToolNames);
    if (parsed) {
      toolCalls.push(parsed);
      cleanedText = cleanedText.replace(match[0], '');
      continue;
    }
    // Fallback: first line is tool name, second line is JSON args
    const lines = body.split('\n').filter(l => l.trim());
    if (lines.length >= 1 && knownToolNames.has(lines[0].trim())) {
      const name = lines[0].trim();
      let args: Record<string, unknown> = {};
      if (lines.length >= 2) {
        try {
          args = JSON.parse(lines.slice(1).join('\n'));
        } catch {
          // no valid JSON args, use empty
        }
      }
      toolCalls.push({ name, arguments: args });
      cleanedText = cleanedText.replace(match[0], '');
    }
  }

  // Pass 2: generic code blocks containing a bare known tool name
  // Only run if pass 1 found nothing
  if (toolCalls.length === 0) {
    const genericBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
    for (const match of text.matchAll(genericBlockRe)) {
      const langTag = match[1].trim();
      const body = match[2].trim();
      const firstLine = body.split('\n')[0]?.trim() ?? '';

      let toolName: string | null = null;

      if (langTag && knownToolNames.has(langTag)) {
        toolName = langTag;
      } else if (firstLine && knownToolNames.has(firstLine)) {
        toolName = firstLine;
      }

      if (toolName) {
        let args: Record<string, unknown> = {};
        // Try parsing remaining lines as JSON
        const remaining = toolName === langTag ? body : body.split('\n').slice(1).join('\n');
        if (remaining.trim()) {
          try {
            args = JSON.parse(remaining.trim());
          } catch {
            // no valid JSON args
          }
        }
        toolCalls.push({ name: toolName, arguments: args });
        cleanedText = cleanedText.replace(match[0], '');
      }
    }
  }

  return {
    toolCalls,
    cleanedText: cleanedText.trim(),
  };
}

/** Try to parse body as {"tool": "name", "arguments": {...}} */
function tryParseToolCallJSON(
  body: string,
  knownToolNames: Set<string>,
): ExtractedToolCall | null {
  try {
    const obj = JSON.parse(body);
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.tool === 'string' &&
      knownToolNames.has(obj.tool)
    ) {
      return {
        name: obj.tool,
        arguments: (typeof obj.arguments === 'object' && obj.arguments !== null)
          ? obj.arguments
          : {},
      };
    }
  } catch {
    // not valid JSON
  }
  return null;
}
