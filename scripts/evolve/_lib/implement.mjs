/**
 * Core implementation engine for the self-evolution system.
 * Runs Claude with tool-use to implement a bounded task.
 *
 * API key resolution order:
 *   1. anthropicApiKey arg (from caller)
 *   2. ANTHROPIC_API_KEY env
 *   3. openRouterApiKey from ~/.ohwow/config.json (uses OpenRouter with claude-haiku)
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function resolveClientAndModel(anthropicApiKey) {
  // Direct Anthropic key passed in — use it
  if (anthropicApiKey) {
    return {
      client: new Anthropic({ apiKey: anthropicApiKey }),
      model: 'claude-haiku-4-5',
    };
  }
  // Fallback: OpenRouter key from ohwow config — supports Anthropic tool-use format
  const configPath = path.join(os.homedir(), '.ohwow', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.openRouterApiKey) {
        return {
          client: new Anthropic({
            apiKey: config.openRouterApiKey,
            baseURL: 'https://openrouter.ai/api',
            defaultHeaders: {
              'HTTP-Referer': 'https://ohwow.fun',
              'X-Title': 'ohwow-self-evolve',
            },
          }),
          model: 'anthropic/claude-haiku-4-5',
        };
      }
    } catch {}
  }
  throw new Error('No usable LLM API key found. Set ANTHROPIC_API_KEY or configure openRouterApiKey in ~/.ohwow/config.json');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the repository',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites). Always read the file first.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command. Use for: reading file lists, running tests, git commands, grepping, and PREFERRED for making targeted edits via sed/python/awk.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory (defaults to targetRepo)' },
        modified_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of absolute file paths modified by this command (e.g., after sed -i). Required so the system can track and stage them for commit.',
        },
      },
      required: ['command'],
    },
  },
];

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function validatePath(filePath, allowedRoot) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(allowedRoot))) {
    throw new Error(`Path escapes allowed root: ${filePath}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

// Track file sizes read so we can guard against truncation in write_file
const _readSizes = new Map();

async function executeTool(toolName, toolInput, { targetRepo }) {
  if (toolName === 'read_file') {
    const safePath = validatePath(toolInput.path, targetRepo);
    try {
      const content = fs.readFileSync(safePath, 'utf8');
      _readSizes.set(safePath, content.length);
      // Return truncated to 6000 chars with a warning if large
      if (content.length > 6000) {
        return content.slice(0, 6000) + `\n\n[TRUNCATED: file is ${content.length} chars. Read in sections using bash head/sed if you need the rest. Do NOT write the whole file — only patch the specific lines that need changing using bash commands like sed -i.]`;
      }
      return content;
    } catch (err) {
      return `ERROR reading file: ${err.message}`;
    }
  }

  if (toolName === 'write_file') {
    const safePath = validatePath(toolInput.path, targetRepo);
    const content = toolInput.content;

    // Guard: if we previously read this file and the new content is suspiciously short
    // (less than 50% of the original), reject the write to prevent truncation
    const prevSize = _readSizes.get(safePath);
    if (prevSize && prevSize > 500 && content.length < prevSize * 0.5) {
      return `ERROR: write rejected — content is ${content.length} chars but original was ${prevSize} chars (${Math.round(content.length / prevSize * 100)}% of original). This looks like a truncation. Use bash with sed/patch to make targeted edits instead of rewriting the whole file.`;
    }

    fs.mkdirSync(path.dirname(safePath), { recursive: true });
    fs.writeFileSync(safePath, content, 'utf8');
    return `Written: ${safePath} (${content.length} chars)`;
  }

  if (toolName === 'bash') {
    const cwd = toolInput.cwd || targetRepo;
    try {
      const result = await execFileAsync('bash', ['-c', toolInput.command], {
        cwd,
        timeout: 60_000,
        env: { ...process.env, PATH: process.env.PATH },
      });
      return (result.stdout || '').slice(0, 4000) || '(no output)';
    } catch (err) {
      const stderr = (err.stderr || '').slice(0, 2000);
      const stdout = (err.stdout || '').slice(0, 2000);
      return `ERROR (exit ${err.code}):\n${stderr || stdout || err.message}`;
    }
  }
  // NOTE: modified_files from bash are tracked in the caller (implementTask loop)

  throw new Error(`Unknown tool: ${toolName}`);
}

// ---------------------------------------------------------------------------
// Main implementTask function
// ---------------------------------------------------------------------------

/**
 * Run Claude in a tool-use loop to implement the given task.
 * Returns { filesChanged, iterations, summary }.
 */
export async function implementTask(task, { anthropicApiKey } = {}) {
  const { client, model } = resolveClientAndModel(anthropicApiKey);

  const systemPrompt = `You are an expert software engineer implementing a specific, bounded code improvement task.
You have access to three tools: read_file, write_file, bash.

RULES:
- Change at most 5 files per task
- Never modify package.json, package-lock.json, or yarn.lock
- Never delete existing tests
- For SMALL targeted changes (e.g., changing a string constant, adding a line): PREFER bash with sed/python/awk over read_file + write_file. This is safer and avoids truncation.
- For NEW files: use write_file (you are writing from scratch, no truncation risk).
- For read_file: if the file is large and you only need a few lines, use bash grep/head/sed to read the specific section instead.
- write_file is ONLY safe when you have the COMPLETE file content. Never write a file if you only have a partial view.
- After making changes, verify with bash (e.g., grep to confirm old string is gone)
- When done, stop using tools and output a clear summary of what you changed and why

PREFERRED PATTERN for replacing a string in a file:
  bash: sed -i '' 's/old_string/new_string/g' /path/to/file   (macOS)
  or:   python3 -c "content=open('f').read(); open('f','w').write(content.replace('old','new'))"
Then verify with: bash grep -n 'old_string' /path/to/file

TARGET REPO: ${task.targetRepo}
Today: ${new Date().toISOString().slice(0, 10)}`;

  const userMessage = `TASK: ${task.title}

${task.description.trim()}

ACCEPTANCE CRITERIA:
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Start by using bash to find and read the relevant files, then implement the changes. Be surgical and minimal.`;

  const messages = [{ role: 'user', content: userMessage }];
  const filesChanged = new Set();
  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.messages.create({
      model,
      max_tokens: 8096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    // Append assistant turn to conversation
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let result;
        try {
          result = await executeTool(block.name, block.input, { targetRepo: task.targetRepo });
          if (block.name === 'write_file') filesChanged.add(block.input.path);
          // Track files modified via bash (e.g., sed -i)
          if (block.name === 'bash' && Array.isArray(block.input.modified_files)) {
            for (const f of block.input.modified_files) filesChanged.add(f);
          }
        } catch (err) {
          result = `ERROR: ${err.message}`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: String(result).slice(0, 8000),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  // Extract the final text summary from the last assistant message(s)
  const lastText = messages
    .filter(m => m.role === 'assistant')
    .flatMap(m => (Array.isArray(m.content) ? m.content : [m.content]))
    .filter(b => b?.type === 'text')
    .map(b => b.text)
    .join('\n')
    .slice(-2000);

  return {
    filesChanged: [...filesChanged],
    iterations,
    summary: lastText,
  };
}
