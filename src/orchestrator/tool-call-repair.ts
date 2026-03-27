/**
 * Tool Call Repair Pipeline
 * Fixes common malformed tool calls from small local models:
 * markdown wrappers, structural JSON errors, hallucinated names, type mismatches.
 */

import type { OpenAITool, OpenAIToolCall } from '../execution/model-router.js';

export interface RepairResult {
  repaired: boolean;
  toolCall: OpenAIToolCall;
  repairs: string[];  // list of repairs applied (for logging)
  error?: string;     // if unrecoverable
}

/** Strip markdown code block wrappers and stray backticks. */
export function stripMarkdownWrappers(raw: string): string {
  let s = raw.trim();

  // Remove ```json ... ``` or ``` ... ```
  const fenceMatch = s.match(/^```(?:json|jsonc)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  // Remove stray leading/trailing backticks
  while (s.startsWith('`') && !s.startsWith('``')) s = s.slice(1);
  while (s.endsWith('`') && !s.endsWith('``')) s = s.slice(0, -1);

  return s.trim();
}

/** Fix common structural JSON issues from small models. */
export function repairJsonStructure(raw: string): string {
  let s = raw;

  // Trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');

  // Single quotes to double quotes (naive but handles most cases)
  // Only replace when it looks like JSON keys/values: {'key': 'value'}
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"');
  }

  // Unquoted keys: {name: "val"} → {"name": "val"}
  s = s.replace(/([{,]\s*)([a-zA-Z_]\w*)(\s*:)/g, '$1"$2"$3');

  // Missing closing braces/brackets
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }
  for (let i = 0; i < openBrackets; i++) s += ']';
  for (let i = 0; i < openBraces; i++) s += '}';

  return s;
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Fuzzy-match a hallucinated tool name against known tool names. */
export function fuzzyMatchToolName(name: string, knownNames: string[]): string | null {
  // Exact match first
  if (knownNames.includes(name)) return name;

  // Prefix match (e.g., "list_agent" for "list_agents")
  const prefixMatch = knownNames.find(k => k.startsWith(name) || name.startsWith(k));
  if (prefixMatch) return prefixMatch;

  // Levenshtein distance <= 2
  let bestMatch: string | null = null;
  let bestDist = 3; // threshold
  for (const known of knownNames) {
    const dist = levenshtein(name.toLowerCase(), known.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = known;
    }
  }
  return bestMatch;
}

/** Coerce argument types to match the tool schema. */
function coerceTypes(args: Record<string, unknown>, tool: OpenAITool): Record<string, unknown> {
  const props = tool.function.parameters.properties as Record<string, { type?: string }> | undefined;
  if (!props) return args;

  const result = { ...args };
  for (const [key, val] of Object.entries(result)) {
    const schema = props[key];
    if (!schema?.type || val == null) continue;

    if (schema.type === 'number' && typeof val === 'string') {
      const n = Number(val);
      if (!isNaN(n)) result[key] = n;
    } else if (schema.type === 'integer' && typeof val === 'string') {
      const n = parseInt(val, 10);
      if (!isNaN(n)) result[key] = n;
    } else if (schema.type === 'boolean' && typeof val === 'string') {
      if (val === 'true') result[key] = true;
      else if (val === 'false') result[key] = false;
    } else if (schema.type === 'string' && typeof val !== 'string') {
      result[key] = String(val);
    }
  }
  return result;
}

/**
 * Attempt to repair a malformed tool call.
 * Returns the original if no repair is needed, or the repaired version.
 */
export function repairToolCall(raw: OpenAIToolCall, knownTools: OpenAITool[]): RepairResult {
  const repairs: string[] = [];
  let toolCall = { ...raw, function: { ...raw.function } };
  const knownNames = knownTools.map(t => t.function.name);

  // Stage 1: Fuzzy-match tool name
  if (!knownNames.includes(toolCall.function.name)) {
    const match = fuzzyMatchToolName(toolCall.function.name, knownNames);
    if (match) {
      repairs.push(`name: "${toolCall.function.name}" → "${match}"`);
      toolCall.function.name = match;
    } else {
      return {
        repaired: false,
        toolCall: raw,
        repairs: [],
        error: `Unknown tool "${toolCall.function.name}"`,
      };
    }
  }

  // Stage 2: Parse and repair arguments
  let args: Record<string, unknown>;
  const rawArgs = toolCall.function.arguments;

  try {
    args = JSON.parse(rawArgs);
  } catch {
    // Try repair pipeline
    const stripped = stripMarkdownWrappers(rawArgs);
    if (stripped !== rawArgs) repairs.push('stripped markdown wrapper');

    const repaired = repairJsonStructure(stripped);
    if (repaired !== stripped) repairs.push('repaired JSON structure');

    try {
      args = JSON.parse(repaired);
    } catch {
      return {
        repaired: false,
        toolCall: raw,
        repairs,
        error: `Could not parse tool arguments after repair`,
      };
    }
  }

  // Stage 3: Type coercion
  const tool = knownTools.find(t => t.function.name === toolCall.function.name);
  if (tool) {
    const coerced = coerceTypes(args, tool);
    if (JSON.stringify(coerced) !== JSON.stringify(args)) {
      repairs.push('coerced argument types');
      args = coerced;
    }
  }

  // Write back repaired arguments
  if (repairs.length > 0) {
    toolCall = {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: JSON.stringify(args),
      },
    };
  }

  return {
    repaired: repairs.length > 0,
    toolCall,
    repairs,
  };
}
