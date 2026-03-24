/**
 * Hardware Probe
 *
 * Detects available local media generation services (ComfyUI, Kokoro, Whisper)
 * and hardware capabilities. Used during TUI setup to auto-configure
 * media MCP servers.
 */

import os from 'os';
import { logger } from '../lib/logger.js';
import { commandExists } from '../lib/platform-utils.js';

export interface MediaCapabilities {
  comfyui: {
    available: boolean;
    url: string;
    models: string[];
  };
  kokoro: {
    available: boolean;
    url: string;
    voices: string[];
  };
  whisper: {
    available: boolean;
  };
  /** Estimated VRAM in GB (0 if not detectable). */
  vram: number;
  recommendedImageModel: string | null;
  recommendedVideoModel: string | null;
}

const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';
const DEFAULT_KOKORO_URL = 'http://127.0.0.1:8880';

/**
 * Probe for locally running media services.
 * Non-blocking: returns defaults for any service it can't reach.
 */
export async function probeMediaCapabilities(): Promise<MediaCapabilities> {
  const [comfyui, kokoro, whisper] = await Promise.all([
    probeComfyUI(),
    probeKokoro(),
    probeWhisper(),
  ]);

  // Estimate VRAM (best-effort, platform-specific)
  const vram = await estimateVRAM();

  // Recommend models based on available VRAM
  let recommendedImageModel: string | null = null;
  let recommendedVideoModel: string | null = null;

  if (comfyui.available) {
    if (vram >= 16) {
      recommendedImageModel = 'flux-schnell';
      recommendedVideoModel = 'ltx-video';
    } else if (vram >= 8) {
      recommendedImageModel = 'sd-1.5';
    }
  }

  return {
    comfyui,
    kokoro,
    whisper,
    vram,
    recommendedImageModel,
    recommendedVideoModel,
  };
}

async function probeComfyUI(): Promise<MediaCapabilities['comfyui']> {
  const url = DEFAULT_COMFYUI_URL;
  try {
    const response = await fetch(`${url}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { available: false, url, models: [] };
    }

    // Try to list available checkpoints
    let models: string[] = [];
    try {
      const modelsResp = await fetch(`${url}/object_info/CheckpointLoaderSimple`, {
        signal: AbortSignal.timeout(3000),
      });
      if (modelsResp.ok) {
        const data = await modelsResp.json() as Record<string, unknown>;
        const checkpointInfo = data['CheckpointLoaderSimple'] as Record<string, unknown> | undefined;
        const input = checkpointInfo?.['input'] as Record<string, unknown> | undefined;
        const required = input?.['required'] as Record<string, unknown> | undefined;
        const ckptName = required?.['ckpt_name'] as [string[]] | undefined;
        if (Array.isArray(ckptName?.[0])) {
          models = ckptName[0];
        }
      }
    } catch {
      // Models list is optional
    }

    logger.info(`[hardware-probe] ComfyUI detected at ${url} with ${models.length} model(s)`);
    return { available: true, url, models };
  } catch {
    return { available: false, url, models: [] };
  }
}

async function probeKokoro(): Promise<MediaCapabilities['kokoro']> {
  const url = DEFAULT_KOKORO_URL;
  try {
    const response = await fetch(`${url}/v1/audio/voices`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { available: false, url, voices: [] };
    }

    let voices: string[] = [];
    try {
      const data = await response.json() as { voices?: Array<{ name: string }> };
      voices = data.voices?.map(v => v.name) ?? [];
    } catch {
      // Voice list is optional
    }

    logger.info(`[hardware-probe] Kokoro TTS detected at ${url} with ${voices.length} voice(s)`);
    return { available: true, url, voices };
  } catch {
    return { available: false, url, voices: [] };
  }
}

async function probeWhisper(): Promise<MediaCapabilities['whisper']> {
  if (commandExists('whisper')) {
    logger.info('[hardware-probe] Whisper CLI detected');
    return { available: true };
  }
  if (commandExists('faster-whisper')) {
    logger.info('[hardware-probe] faster-whisper CLI detected');
    return { available: true };
  }
  return { available: false };
}

async function estimateVRAM(): Promise<number> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // macOS: check Metal GPU memory via system_profiler
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.memsize'], { timeout: 2000 });
      const totalBytes = parseInt(stdout.trim(), 10);
      if (!isNaN(totalBytes)) {
        // On Apple Silicon, GPU shares system RAM. Estimate ~75% available for GPU.
        const totalGB = totalBytes / (1024 ** 3);
        return Math.round(totalGB * 0.75);
      }
    }

    // Windows: nvidia-smi works identically, then fall back to system RAM estimate
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync(
          'nvidia-smi',
          ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
          { timeout: 3000 },
        );
        const mb = parseInt(stdout.trim().split('\n')[0], 10);
        if (!isNaN(mb)) return Math.round(mb / 1024);
      } catch {
        // No NVIDIA GPU
      }
      // Fallback: estimate from system RAM
      const totalGB = os.totalmem() / (1024 ** 3);
      return Math.round(totalGB * 0.75);
    }

    // Linux: try nvidia-smi, then rocm-smi (AMD), then /proc/meminfo fallback
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execFileAsync(
          'nvidia-smi',
          ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
          { timeout: 3000 },
        );
        const mb = parseInt(stdout.trim().split('\n')[0], 10);
        if (!isNaN(mb)) return Math.round(mb / 1024);
      } catch {
        // No NVIDIA GPU, try AMD
      }

      try {
        const { stdout } = await execFileAsync(
          'rocm-smi',
          ['--showmeminfo', 'vram', '--csv'],
          { timeout: 3000 },
        );
        // rocm-smi CSV output has a header row; look for total VRAM in bytes
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const match = line.match(/(\d{6,})/); // large number = bytes
          if (match) {
            const bytes = parseInt(match[1], 10);
            if (!isNaN(bytes) && bytes > 0) return Math.round(bytes / (1024 ** 3));
          }
        }
      } catch {
        // No AMD GPU either
      }

      // Fallback: estimate from system RAM (same heuristic as Apple Silicon)
      try {
        const { readFileSync } = await import('fs');
        const meminfo = readFileSync('/proc/meminfo', 'utf-8');
        const match = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
        if (match) {
          const totalGB = parseInt(match[1], 10) / (1024 * 1024);
          return Math.round(totalGB * 0.75);
        }
      } catch {
        // /proc/meminfo not available
      }
    }
  } catch {
    // Not detectable
  }
  return 0;
}
