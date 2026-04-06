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

// ============================================================================
// VRAM DETECTION
// ============================================================================

export interface VramInfo {
  totalGb: number;
  usedGb: number;
  freeGb: number;
}

/** Detect GPU/VRAM usage. Cached result refreshed when stale (> refreshMs). */
let cachedVram: VramInfo | null = null;
let vramCacheTime = 0;
const VRAM_CACHE_MS = 5 * 60 * 1000; // 5 minutes

export async function getVramInfo(forceRefresh = false): Promise<VramInfo | null> {
  if (!forceRefresh && cachedVram && (Date.now() - vramCacheTime) < VRAM_CACHE_MS) {
    return cachedVram;
  }

  const info = await detectVram();
  if (info) {
    cachedVram = info;
    vramCacheTime = Date.now();
  }
  return info;
}

async function detectVram(): Promise<VramInfo | null> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);

    // NVIDIA GPU: nvidia-smi reports total, used, free in MiB
    if (process.platform === 'linux' || process.platform === 'win32' || process.platform === 'darwin') {
      try {
        const { stdout } = await exec(
          'nvidia-smi',
          ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
          { timeout: 3000 },
        );
        const parts = stdout.trim().split('\n')[0].split(',').map(s => parseInt(s.trim(), 10));
        if (parts.length === 3 && parts.every(n => !isNaN(n))) {
          return {
            totalGb: Math.round((parts[0] / 1024) * 10) / 10,
            usedGb: Math.round((parts[1] / 1024) * 10) / 10,
            freeGb: Math.round((parts[2] / 1024) * 10) / 10,
          };
        }
      } catch {
        // No NVIDIA GPU
      }
    }

    // AMD ROCm (Linux)
    if (process.platform === 'linux') {
      try {
        const { stdout } = await exec('rocm-smi', ['--showmeminfo', 'vram', '--csv'], { timeout: 3000 });
        const lines = stdout.trim().split('\n').filter(l => !l.startsWith('GPU') && l.trim());
        if (lines.length > 0) {
          // CSV: GPU, VRAM Total, VRAM Used
          const parts = lines[0].split(',').map(s => parseInt(s.trim(), 10));
          if (parts.length >= 3) {
            const totalGb = Math.round((parts[1] / (1024 ** 3)) * 10) / 10;
            const usedGb = Math.round((parts[2] / (1024 ** 3)) * 10) / 10;
            return { totalGb, usedGb, freeGb: Math.round((totalGb - usedGb) * 10) / 10 };
          }
        }
      } catch {
        // No AMD GPU
      }
    }

    // Apple Silicon: unified memory, estimate ~75% available for GPU
    if (process.platform === 'darwin') {
      try {
        const { stdout: totalStr } = await exec('sysctl', ['-n', 'hw.memsize'], { timeout: 2000 });
        const totalBytes = parseInt(totalStr.trim(), 10);
        if (!isNaN(totalBytes)) {
          const totalGb = Math.round((totalBytes / (1024 ** 3)) * 0.75 * 10) / 10;
          // vm_stat to estimate used memory pressure on GPU
          const { stdout: vmStat } = await exec('vm_stat', [], { timeout: 2000 });
          const pageSize = 16384; // ARM64 page size
          const wiredMatch = vmStat.match(/Pages wired down:\s+(\d+)/);
          const activeMatch = vmStat.match(/Pages active:\s+(\d+)/);
          const wiredGb = wiredMatch ? (parseInt(wiredMatch[1], 10) * pageSize) / (1024 ** 3) : 0;
          const activeGb = activeMatch ? (parseInt(activeMatch[1], 10) * pageSize) / (1024 ** 3) : 0;
          // Estimate GPU usage as ~60% of wired+active (shared memory pressure)
          const estimatedUsedGb = Math.round((wiredGb + activeGb) * 0.6 * 10) / 10;
          const usedGb = Math.min(estimatedUsedGb, totalGb);
          return { totalGb, usedGb, freeGb: Math.round((totalGb - usedGb) * 10) / 10 };
        }
      } catch {
        // Not detectable
      }
    }
  } catch {
    // Not detectable
  }
  return null;
}

/** Get total VRAM in GB (synchronous estimate for connect payload). */
export function estimateTotalVramGb(): number {
  const totalMemGB = os.totalmem() / (1024 ** 3);

  if (process.platform === 'darwin' && os.arch() === 'arm64') {
    return Math.round(totalMemGB * 0.75);
  }

  // Try nvidia-smi synchronously
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    const mb = parseInt(output.split('\n')[0], 10);
    if (!isNaN(mb)) return Math.round(mb / 1024);
  } catch {
    // No NVIDIA
  }

  return 0;
}

// ============================================================================
// FLEET SENSING (battery, power, network, user presence)
// ============================================================================

export interface FleetSensingData {
  batteryPercent?: number;
  powerSource?: 'ac' | 'battery' | 'usb' | 'unknown';
  networkType?: 'ethernet' | 'wifi' | 'cellular' | 'unknown';
  screenActive?: boolean;
  userActive?: boolean;
}

let cachedFleetSensing: FleetSensingData | null = null;
let fleetSensingCacheTime = 0;
const FLEET_SENSING_CACHE_MS = 30 * 1000; // 30 seconds

export async function getFleetSensingData(forceRefresh = false): Promise<FleetSensingData> {
  if (!forceRefresh && cachedFleetSensing && (Date.now() - fleetSensingCacheTime) < FLEET_SENSING_CACHE_MS) {
    return cachedFleetSensing;
  }

  const data: FleetSensingData = {};

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);

    if (process.platform === 'darwin') {
      // Battery + power source via pmset
      try {
        const { stdout } = await exec('pmset', ['-g', 'batt'], { timeout: 2000 });
        const pctMatch = stdout.match(/(\d+)%/);
        if (pctMatch) data.batteryPercent = parseInt(pctMatch[1], 10);

        if (stdout.includes('AC Power')) data.powerSource = 'ac';
        else if (stdout.includes('Battery Power')) data.powerSource = 'battery';
        else data.powerSource = 'unknown';
      } catch {
        // Desktop Mac (no battery)
        data.powerSource = 'ac';
      }

      // Network type via route + networksetup
      try {
        const { stdout: routeOut } = await exec('route', ['-n', 'get', 'default'], { timeout: 2000 });
        const ifMatch = routeOut.match(/interface:\s+(\w+)/);
        if (ifMatch) {
          const iface = ifMatch[1];
          if (iface.startsWith('en0')) data.networkType = 'wifi';
          else if (iface.startsWith('en') || iface.startsWith('bridge')) data.networkType = 'ethernet';
          else if (iface.startsWith('pdp_ip') || iface.startsWith('utun')) data.networkType = 'cellular';
          else data.networkType = 'unknown';
        }
      } catch {
        data.networkType = 'unknown';
      }

      // User idle time via ioreg
      try {
        const { stdout } = await exec('ioreg', ['-c', 'IOHIDSystem'], { timeout: 2000 });
        const idleMatch = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
        if (idleMatch) {
          const idleNs = parseInt(idleMatch[1], 10);
          const idleSec = idleNs / 1_000_000_000;
          data.screenActive = idleSec < 300; // Screen active if idle < 5 min
          data.userActive = idleSec < 60; // User active if idle < 1 min
        }
      } catch {
        data.userActive = true;
        data.screenActive = true;
      }
    } else if (process.platform === 'linux') {
      // Battery via /sys/class/power_supply
      try {
        const { readFileSync } = await import('fs');
        const capacity = readFileSync('/sys/class/power_supply/BAT0/capacity', 'utf-8').trim();
        data.batteryPercent = parseInt(capacity, 10);
        const status = readFileSync('/sys/class/power_supply/BAT0/status', 'utf-8').trim();
        data.powerSource = status === 'Charging' || status === 'Full' ? 'ac' : 'battery';
      } catch {
        data.powerSource = 'ac'; // Desktop Linux (no battery)
      }

      // Network type via ip route
      try {
        const { stdout } = await exec('ip', ['route', 'get', '1.1.1.1'], { timeout: 2000 });
        const devMatch = stdout.match(/dev\s+(\S+)/);
        if (devMatch) {
          const iface = devMatch[1];
          if (iface.startsWith('wl')) data.networkType = 'wifi';
          else if (iface.startsWith('eth') || iface.startsWith('en')) data.networkType = 'ethernet';
          else if (iface.startsWith('wwan')) data.networkType = 'cellular';
          else data.networkType = 'unknown';
        }
      } catch {
        data.networkType = 'unknown';
      }

      data.userActive = true;
      data.screenActive = true;
    } else {
      // Windows or other — defaults
      data.powerSource = 'unknown';
      data.networkType = 'unknown';
      data.userActive = true;
      data.screenActive = true;
    }
  } catch {
    // Non-critical
  }

  cachedFleetSensing = data;
  fleetSensingCacheTime = Date.now();
  return data;
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
