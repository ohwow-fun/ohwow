/**
 * Ollama Installer & Manager
 * Handles checking, installing, starting Ollama and pulling models.
 */

import { spawn, execSync } from 'child_process';
import { commandExists } from './platform-utils.js';

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
}

/** Check if ollama CLI is installed. */
export async function isOllamaInstalled(): Promise<boolean> {
  try {
    execSync('ollama --version', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if Ollama server is running by hitting the API. */
export async function isOllamaRunning(url = 'http://localhost:11434'): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** List models already pulled in Ollama. */
export async function listInstalledModels(url = 'http://localhost:11434'): Promise<string[]> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return data.models?.map(m => m.name) || [];
  } catch {
    return [];
  }
}

/** Install Ollama. Yields progress lines. */
export async function* installOllama(platform: string): AsyncGenerator<string> {
  if (platform === 'darwin') {
    // Try brew first, fall back to curl
    yield 'Checking for Homebrew...';
    if (commandExists('brew')) {
      yield 'Installing Ollama via Homebrew...';
      yield* runCommand('brew', ['install', 'ollama']);
    } else {
      yield 'Installing Ollama via official installer...';
      yield* runCommand('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh']);
    }
  } else if (platform === 'linux') {
    yield 'Installing Ollama via official installer...';
    yield* runCommand('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh']);
  } else if (platform === 'win32') {
    if (commandExists('winget')) {
      yield 'Installing Ollama via winget...';
      yield* runCommand('winget', ['install', '--id', 'Ollama.Ollama', '-e', '--accept-source-agreements', '--accept-package-agreements']);
    } else {
      yield 'Download Ollama from https://ollama.com/download/windows';
    }
  } else {
    yield `Automatic install not supported on ${platform}.`;
    yield 'Download Ollama from https://ollama.com/download';
  }
}

/** Start Ollama server in the background. */
export async function startOllama(): Promise<void> {
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait up to 10 seconds for it to be ready
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await isOllamaRunning()) return;
  }
  throw new Error('Ollama server did not start within 10 seconds');
}

/** Pull a model with progress updates. */
export async function* pullModel(tag: string): AsyncGenerator<PullProgress> {
  const child = spawn('ollama', ['pull', tag], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';

  const lines = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      buffer += data.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ollama pull exited with code ${code}`));
    });
    child.on('error', reject);
  });

  // Poll buffer for progress updates
  const startTime = Date.now();
  while (true) {
    await sleep(300);

    if (buffer) {
      const currentBuffer = buffer;
      buffer = '';

      // Parse ollama pull output lines
      const outputLines = currentBuffer.split('\n').filter(Boolean);
      for (const line of outputLines) {
        const percentMatch = line.match(/(\d+)%/);
        if (percentMatch) {
          yield {
            status: line.trim(),
            percent: parseInt(percentMatch[1], 10),
          };
        } else {
          yield { status: line.trim() };
        }
      }
    }

    // Check if process has ended
    if (child.exitCode !== null) break;

    // Safety timeout: 30 minutes
    if (Date.now() - startTime > 30 * 60 * 1000) {
      child.kill();
      throw new Error('Model pull timed out after 30 minutes');
    }
  }

  await lines;
  yield { status: 'Done', percent: 100 };
}

/** Run a command and yield stdout/stderr lines. */
async function* runCommand(cmd: string, args: string[]): AsyncGenerator<string> {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let done = false;
  let exitError: Error | null = null;

  child.stdout.on('data', (data: Buffer) => { buffer += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { buffer += data.toString(); });
  child.on('close', (code) => {
    done = true;
    if (code !== 0) exitError = new Error(`Command exited with code ${code}`);
  });
  child.on('error', (err) => {
    done = true;
    exitError = err;
  });

  while (!done) {
    await sleep(200);
    if (buffer) {
      const lines = buffer.split('\n');
      buffer = '';
      for (const line of lines) {
        if (line.trim()) yield line.trim();
      }
    }
  }

  // Flush remaining
  if (buffer) {
    for (const line of buffer.split('\n')) {
      if (line.trim()) yield line.trim();
    }
  }

  if (exitError) throw exitError;
}

/** List models currently loaded in VRAM (running). */
export async function listRunningModels(url = 'http://localhost:11434'): Promise<string[]> {
  try {
    const res = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return data.models?.map(m => m.name) || [];
  } catch {
    return [];
  }
}

/** Load a model into VRAM by sending a no-op generate request. */
export async function loadModel(tag: string, url = 'http://localhost:11434'): Promise<void> {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tag, prompt: ' ', stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Ollama returned ${res.status}`);
  }
  // Drain response body
  if (res.body) {
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** Unload a model from memory without deleting it (sets keep_alive to 0). */
export async function unloadModel(tag: string, url = 'http://localhost:11434'): Promise<void> {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tag, keep_alive: 0 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Ollama returned ${res.status}`);
  }
  // Drain the streaming response body
  if (res.body) {
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
