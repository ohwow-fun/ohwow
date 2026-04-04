/**
 * Device Info
 * Detects hardware capabilities for local model recommendations.
 */

import os from 'os';
import { execSync } from 'child_process';

export interface DeviceInfo {
  arch: string;
  platform: string;
  totalMemoryGB: number;
  /** Currently free/available RAM (accounts for other running processes). */
  freeMemoryGB: number;
  cpuModel: string;
  cpuCores: number;
  isAppleSilicon: boolean;
  hasNvidiaGpu: boolean;
  gpuName?: string;
  /** Whether MLX framework is available (Apple Silicon + python3 + mlx-vlm installed) */
  mlxAvailable: boolean;
  /** Python 3 executable path for launching mlx_vlm.server */
  pythonPath?: string;
}

/**
 * Detect device hardware info using Node.js os module.
 * NVIDIA GPU detection only works on Linux (via nvidia-smi).
 */
export function detectDevice(): DeviceInfo {
  const arch = os.arch();
  const platform = os.platform();
  const totalMemoryGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const freeMemoryGB = parseFloat((os.freemem() / (1024 * 1024 * 1024)).toFixed(1));
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Unknown';
  const cpuCores = cpus.length;
  const isAppleSilicon = arch === 'arm64' && platform === 'darwin';

  let hasNvidiaGpu = false;
  let gpuName: string | undefined;

  if (platform === 'linux' || platform === 'win32') {
    try {
      // nvidia-smi works identically on Linux and Windows (ships with NVIDIA drivers)
      const output = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      if (output) {
        hasNvidiaGpu = true;
        gpuName = output.split('\n')[0].trim();
      }
    } catch {
      if (platform === 'linux') {
        // AMD ROCm (Linux only — ROCm doesn't support Windows)
        try {
          const output = execSync('rocm-smi --showproductname --csv', {
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).toString().trim();
          const lines = output.split('\n').filter(l => !l.startsWith('device') && l.trim());
          if (lines.length > 0) {
            const parts = lines[0].split(',');
            gpuName = (parts[1] || parts[0]).trim();
          }
        } catch {
          // No GPU detected
        }
      }
      if (platform === 'win32' && !gpuName) {
        // Fallback: WMI query for any GPU
        try {
          const output = execSync('wmic path win32_videocontroller get caption', {
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).toString().trim();
          const lines = output.split('\n').slice(1).filter(l => l.trim());
          if (lines.length > 0) gpuName = lines[0].trim();
        } catch {
          // No GPU detected
        }
      }
    }
  }

  // MLX detection: Apple Silicon + python3 + mlx-vlm installed
  let mlxAvailable = false;
  let pythonPath: string | undefined;

  if (isAppleSilicon) {
    try {
      execSync('python3 -c "import mlx_vlm"', {
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      mlxAvailable = true;
      pythonPath = 'python3';
    } catch {
      // mlx-vlm not installed or python3 not available
    }
  }

  return {
    arch,
    platform,
    totalMemoryGB,
    freeMemoryGB,
    cpuModel,
    cpuCores,
    isAppleSilicon,
    hasNvidiaGpu,
    gpuName,
    mlxAvailable,
    pythonPath,
  };
}

export type MemoryTier = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

/** Classify device into a memory tier for model recommendations. */
export function getMemoryTier(device: DeviceInfo): MemoryTier {
  const ram = device.totalMemoryGB;
  if (ram < 4) return 'tiny';
  if (ram < 8) return 'small';
  if (ram < 16) return 'medium';
  if (ram < 32) return 'large';
  return 'xlarge';
}

/** Compact one-line device summary (e.g., "MacBook Pro M2 | 16 GB RAM | Apple Silicon"). */
export function formatDeviceCompact(info: DeviceInfo): string {
  const parts: string[] = [];
  // Simplify CPU name
  const cpuShort = info.cpuModel.replace(/\s+/g, ' ').replace(/ CPU.*/, '').trim();
  parts.push(cpuShort);
  parts.push(`${info.totalMemoryGB} GB RAM`);
  if (info.isAppleSilicon) parts.push('Apple Silicon');
  else if (info.hasNvidiaGpu && info.gpuName) parts.push(info.gpuName);
  return parts.join(' | ');
}

/** Human-readable summary of device info (for display in the wizard). */
export function formatDeviceSummary(info: DeviceInfo): string[] {
  const lines: string[] = [];
  lines.push(`CPU: ${info.cpuModel} (${info.cpuCores} cores)`);
  lines.push(`RAM: ${info.totalMemoryGB} GB`);
  lines.push(`Arch: ${info.arch} / ${info.platform}`);
  if (info.isAppleSilicon) lines.push('Apple Silicon: Yes (unified memory, great for local AI)');
  if (info.mlxAvailable) lines.push('MLX-VLM: Available (native Metal inference for vision models)');
  if (info.hasNvidiaGpu && info.gpuName) lines.push(`GPU: ${info.gpuName}`);
  return lines;
}
