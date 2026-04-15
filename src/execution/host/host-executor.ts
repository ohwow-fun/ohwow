/**
 * Host-reach tool executor.
 *
 * Thin, typed wrappers around the specific macOS commands we want agents
 * to reach for. Each function validates input, constructs the command
 * WITHOUT string concatenation (uses argv), spawns it, and returns a
 * structured result. No shell interpolation reaches the OS.
 */

import { spawn } from 'node:child_process';
import { logger } from '../../lib/logger.js';

export interface HostToolResult {
  content: string;
  is_error?: boolean;
}

const ALLOWED_SOUNDS = new Set([
  'Glass', 'Ping', 'Hero', 'Submarine', 'Tink', 'Funk', 'Basso',
  'Blow', 'Bottle', 'Frog', 'Morse', 'Pop', 'Purr', 'Sosumi',
]);

function runArgv(
  cmd: string,
  argv: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });

    const timer = opts.timeoutMs
      ? setTimeout(() => { killed = true; child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed) stderr += `\n[timeout after ${opts.timeoutMs}ms]`;
      resolve({ stdout, stderr, exitCode: killed ? 124 : (code ?? 1) });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\n${err.message}`, exitCode: 1 });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function notifyUser(input: Record<string, unknown>): Promise<HostToolResult> {
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const sound = typeof input.sound === 'string' ? input.sound : undefined;
  if (!title || !body) {
    return { content: "Error: notify_user requires 'title' and 'body'.", is_error: true };
  }
  if (sound && !ALLOWED_SOUNDS.has(sound)) {
    return {
      content: `Error: sound '${sound}' is not in the allowed list. Valid: ${[...ALLOWED_SOUNDS].join(', ')}.`,
      is_error: true,
    };
  }
  // AppleScript quoting: escape backslashes and double quotes.
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const soundClause = sound ? ` sound name "${esc(sound)}"` : '';
  const script = `display notification "${esc(body)}" with title "${esc(title)}"${soundClause}`;
  const result = await runArgv('osascript', ['-e', script], { timeoutMs: 5000 });
  logger.info({ tool: 'notify_user', exit_code: result.exitCode, has_sound: Boolean(sound) }, 'host tool executed');
  if (result.exitCode !== 0) {
    return { content: `Error: notification failed (exit ${result.exitCode}): ${result.stderr.trim()}`, is_error: true };
  }
  return { content: `Notification shown: ${title}` };
}

async function speak(input: Record<string, unknown>): Promise<HostToolResult> {
  const text = typeof input.text === 'string' ? input.text : '';
  const voice = typeof input.voice === 'string' ? input.voice : undefined;
  if (!text) return { content: "Error: speak requires 'text'.", is_error: true };
  if (text.length > 500) {
    return { content: 'Error: text exceeds 500 chars; trim before speaking.', is_error: true };
  }
  const args: string[] = [];
  if (voice) args.push('-v', voice);
  args.push(text);
  const result = await runArgv('say', args, { timeoutMs: 30000 });
  logger.info({ tool: 'speak', exit_code: result.exitCode, text_len: text.length, voice }, 'host tool executed');
  if (result.exitCode !== 0) {
    return { content: `Error: say failed (exit ${result.exitCode}): ${result.stderr.trim()}`, is_error: true };
  }
  return { content: `Spoke: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` };
}

async function clipboardRead(): Promise<HostToolResult> {
  const result = await runArgv('pbpaste', [], { timeoutMs: 2000 });
  logger.info({ tool: 'clipboard_read', exit_code: result.exitCode, bytes: result.stdout.length }, 'host tool executed');
  if (result.exitCode !== 0) {
    return { content: `Error: pbpaste failed: ${result.stderr.trim()}`, is_error: true };
  }
  // Cap to a sensible size so a clipboard full of a log file doesn't blow
  // out the model context.
  const MAX = 10 * 1024;
  const text = result.stdout.length > MAX
    ? result.stdout.slice(0, MAX) + `\n[clipboard truncated: ${result.stdout.length} bytes exceeded ${MAX} byte limit]`
    : result.stdout;
  if (text.length === 0) return { content: '(clipboard is empty or contains non-text data)' };
  return { content: text };
}

async function clipboardWrite(input: Record<string, unknown>): Promise<HostToolResult> {
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.length === 0) {
    return { content: "Error: clipboard_write requires non-empty 'text'.", is_error: true };
  }
  if (text.length > 100_000) {
    return { content: 'Error: text exceeds 100KB; too large for clipboard.', is_error: true };
  }
  const result = await runArgv('pbcopy', [], { input: text, timeoutMs: 2000 });
  logger.info({ tool: 'clipboard_write', exit_code: result.exitCode, bytes: text.length }, 'host tool executed');
  if (result.exitCode !== 0) {
    return { content: `Error: pbcopy failed: ${result.stderr.trim()}`, is_error: true };
  }
  return { content: `Clipboard updated (${text.length} chars).` };
}

async function openUrl(input: Record<string, unknown>): Promise<HostToolResult> {
  const url = typeof input.url === 'string' ? input.url : '';
  // Strict: only http/https. Reject javascript:, file:, data:, etc.
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    return {
      content: `Error: url must be a well-formed http(s) URL. Got: ${url.slice(0, 80)}`,
      is_error: true,
    };
  }
  const result = await runArgv('open', [url], { timeoutMs: 3000 });
  logger.info({ tool: 'open_url', exit_code: result.exitCode, url_host: safeHost(url) }, 'host tool executed');
  if (result.exitCode !== 0) {
    return { content: `Error: open failed (exit ${result.exitCode}): ${result.stderr.trim()}`, is_error: true };
  }
  return { content: `Opened: ${url}` };
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return 'invalid'; }
}

export async function executeHostReachTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<HostToolResult> {
  switch (toolName) {
    case 'notify_user': return notifyUser(input);
    case 'speak': return speak(input);
    case 'clipboard_read': return clipboardRead();
    case 'clipboard_write': return clipboardWrite(input);
    case 'open_url': return openUrl(input);
    default:
      return { content: `Error: unknown host-reach tool: ${toolName}`, is_error: true };
  }
}
