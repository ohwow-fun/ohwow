/**
 * Sandboxed Code Execution — Local Workspace
 *
 * Same VM-based sandbox as cloud, executes JavaScript in an isolated
 * context with no filesystem, network, or process access.
 */

import vm from 'vm';

export interface RunCodeInput {
  language: 'javascript';
  code: string;
  timeout_ms?: number;
}

export interface RunCodeOutput {
  success: boolean;
  result: unknown;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export const RUN_CODE_TOOL_DEFINITION = {
  name: 'run_code',
  description: 'Execute JavaScript code in a sandboxed environment for data transformations, calculations, or text processing. No filesystem, network, or process access.',
  input_schema: {
    type: 'object' as const,
    properties: {
      language: { type: 'string', enum: ['javascript'] },
      code: { type: 'string', description: 'JavaScript code to execute' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default: 5000, max: 30000)' },
    },
    required: ['language', 'code'],
  },
};

export function runCode(input: RunCodeInput): RunCodeOutput {
  const startTime = Date.now();
  const timeoutMs = Math.min(input.timeout_ms || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const stdout: string[] = [];
  const stderr: string[] = [];

  const sandbox = vm.createContext({
    Math, JSON, Date, Array, Object, Map, Set, RegExp,
    Number, String, Boolean,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    console: {
      log: (...args: unknown[]) => stdout.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => stderr.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => stderr.push(args.map(String).join(' ')),
    },
    setTimeout: undefined, setInterval: undefined, setImmediate: undefined,
    process: undefined, require: undefined, fetch: undefined, Buffer: undefined,
    global: undefined, globalThis: undefined,
  });

  try {
    const result = vm.runInContext(input.code, sandbox, { timeout: timeoutMs, displayErrors: true });

    return {
      success: true,
      result: sanitizeResult(result),
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      result: null,
      stdout: stdout.join('\n'),
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

function sanitizeResult(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}
