/**
 * Tool result summarization for context window protection.
 * Truncates verbose tool results before injecting into message history.
 */

/** Per-tool token budget overrides. Tools not listed use DEFAULT_MAX_CHARS. */
const TOOL_MAX_CHARS: Record<string, number> = {
  // List tools return arrays that can be very long
  list_agents: 2000,
  list_tasks: 2000,
  list_contacts: 2000,
  list_projects: 1500,
  list_workflows: 1500,
  list_goals: 1500,
  list_knowledge: 1500,
  list_whatsapp_chats: 1000,
  list_whatsapp_connections: 1000,
  list_telegram_chats: 1000,
  list_telegram_connections: 1000,
  list_a2a_connections: 1000,
  list_peers: 1000,
  list_workflow_triggers: 1000,
  get_activity_feed: 2000,

  // Detail tools can return large outputs
  get_task_detail: 3000,
  get_workflow_detail: 2000,
  get_project_board: 2000,

  // Research/scraping can return very large results
  deep_research: 4000,
  scrape_url: 3000,
  scrape_bulk: 3000,
  scrape_search: 3000,

  // Bash tools
  run_bash: 5000,

  // File tools
  local_read_file: 4000,
  local_list_directory: 2000,
  local_search_content: 2000,
  local_search_files: 1500,

  // Agent output can be very large
  run_agent: 3000,
  delegate_subtask: 3000,

  // Knowledge search
  search_knowledge: 3000,
  search_contacts: 1500,

  // Business intelligence — usually compact
  get_business_pulse: 1500,
  get_contact_pipeline: 1500,
  get_daily_reps_status: 1000,
  get_workspace_stats: 1500,
};

const DEFAULT_MAX_CHARS = 5000;

/** Tools whose results should never be truncated (errors, plan updates, etc.) */
const NEVER_TRUNCATE = new Set([
  'update_plan',
  'approve_task',
  'reject_task',
  'request_browser',
]);

/**
 * Summarize a tool result to fit within the tool's character budget.
 * Preserves error messages in full. Handles JSON arrays and plain text differently.
 */
export function summarizeToolResult(toolName: string, content: string, isError: boolean): string {
  // Never truncate errors — the model needs full error context
  if (isError) return content;

  // Never truncate certain tools
  if (NEVER_TRUNCATE.has(toolName)) return content;

  const maxChars = TOOL_MAX_CHARS[toolName] ?? DEFAULT_MAX_CHARS;

  // Already within budget
  if (content.length <= maxChars) return content;

  // Try to detect JSON arrays and truncate intelligently
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    return truncateJsonArray(trimmed, maxChars, toolName);
  }

  // Try JSON object
  if (trimmed.startsWith('{')) {
    return truncateJsonObject(trimmed, maxChars);
  }

  // Plain text truncation
  return truncateText(content, maxChars);
}

function truncateJsonArray(json: string, maxChars: number, _toolName: string): string {
  try {
    const arr = JSON.parse(json) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) return json;

    // Binary search for the max number of items that fit
    let lo = 1;
    let hi = arr.length;
    let bestItems = 0;
    let bestJson = '';

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = JSON.stringify(arr.slice(0, mid));
      const suffix = mid < arr.length ? `\n\n(${arr.length - mid} more items, ${arr.length} total)` : '';

      if ((candidate + suffix).length <= maxChars) {
        bestItems = mid;
        bestJson = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Guard: if even a single item exceeds maxChars, fall back to text truncation
    if (bestItems === 0) {
      return truncateText(json, maxChars);
    }

    const suffix = bestItems < arr.length ? `\n\n(${arr.length - bestItems} more items, ${arr.length} total)` : '';
    return bestJson + suffix;
  } catch {
    // Not valid JSON — fall back to text truncation
    return truncateText(json, maxChars);
  }
}

function truncateJsonObject(json: string, maxChars: number): string {
  // For JSON objects, just truncate the string representation
  if (json.length <= maxChars) return json;
  const cutoff = maxChars - 50;
  return json.slice(0, cutoff) + '\n... (truncated, full result was ' + json.length + ' chars)';
}

function truncateText(text: string, maxChars: number): string {
  const lines = text.split('\n');
  let result = '';
  let lineCount = 0;

  for (const line of lines) {
    if ((result + line + '\n').length > maxChars - 80) break;
    result += line + '\n';
    lineCount++;
  }

  const remainingLines = lines.length - lineCount;
  if (remainingLines > 0) {
    result += `\n... (truncated, ${remainingLines} more lines)`;
  }

  return result.trimEnd();
}
