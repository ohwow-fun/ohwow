/**
 * Process Monitor
 *
 * Polls local AI/media services (Ollama, ComfyUI, Kokoro, Whisper)
 * and reports their status, memory usage, and capacity estimates.
 * Emits 'processes:changed' when any process status changes.
 */

import type { TypedEventBus } from './typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import { probeMediaCapabilities } from '../media/hardware-probe.js';
import { detectDevice } from './device-info.js';
import type { DeviceInfo } from './device-info.js';
import { logger } from './logger.js';

// ============================================================================
// TYPES
// ============================================================================

export type ProcessName = 'ollama' | 'comfyui' | 'kokoro' | 'whisper';

export interface ProcessStatus {
  name: ProcessName;
  running: boolean;
  url?: string;
  /** Estimated memory usage in MB (0 if not running). */
  memoryMB: number;
  /** Estimated VRAM usage in MB (0 if not running or CPU-only). */
  vramMB: number;
  /** Details: model names, voice list, etc. */
  details: Record<string, unknown>;
  lastChecked: string;
}

export interface CapacityEstimate {
  totalVramGB: number;
  usedVramGB: number;
  availableVramGB: number;
  /** Processes that would fit in remaining capacity. */
  canRun: string[];
  /** Processes that won't fit. */
  cannotRun: string[];
  /** Human-readable recommendations. */
  suggestions: string[];
}

export interface MeshCapacity {
  devices: Array<{
    name: string;
    isLocal: boolean;
    capacity: CapacityEstimate;
    processes: ProcessStatus[];
  }>;
  recommendations: string[];
}

// ============================================================================
// VRAM ESTIMATES (approximate, in MB)
// ============================================================================

/** Rough VRAM usage per service when running. */
const VRAM_ESTIMATES: Record<string, number> = {
  'comfyui-sd15': 4000,
  'comfyui-sdxl': 8000,
  'comfyui-flux': 12000,
  'comfyui-default': 6000,
  'kokoro': 1000,
  'whisper-base': 500,
  'whisper-medium': 1500,
  'whisper-large': 3000,
  'whisper-default': 1000,
};

// ============================================================================
// PROCESS MONITOR
// ============================================================================

export class ProcessMonitor {
  private ollamaUrl: string;
  private emitter: TypedEventBus<RuntimeEvents>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastStatuses: ProcessStatus[] = [];
  private lastDevice: DeviceInfo | null = null;

  constructor(ollamaUrl: string, emitter: TypedEventBus<RuntimeEvents>) {
    this.ollamaUrl = ollamaUrl.replace(/\/$/, '');
    this.emitter = emitter;
  }

  /** Start polling every 15 seconds. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Initial poll
    this.poll().catch(() => {});

    this.interval = setInterval(() => {
      this.poll().catch(() => {});
    }, 15_000);
  }

  /** Stop polling. */
  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Get latest process statuses. */
  getStatuses(): ProcessStatus[] {
    return this.lastStatuses;
  }

  /** Estimate capacity for a given device based on current processes. */
  estimateCapacity(device?: DeviceInfo): CapacityEstimate {
    const dev = device || this.lastDevice || detectDevice();
    const totalVramGB = estimateDeviceVram(dev);
    const usedVramMB = this.lastStatuses
      .filter(s => s.running)
      .reduce((sum, s) => sum + s.vramMB, 0);
    const usedVramGB = usedVramMB / 1024;
    const availableVramGB = Math.max(0, totalVramGB - usedVramGB);

    const canRun: string[] = [];
    const cannotRun: string[] = [];
    const suggestions: string[] = [];

    // Check what could still fit
    const possibleServices = [
      { label: 'ComfyUI (SD 1.5)', vramGB: 4 },
      { label: 'ComfyUI (SDXL)', vramGB: 8 },
      { label: 'ComfyUI (Flux)', vramGB: 12 },
      { label: 'Kokoro TTS', vramGB: 1 },
      { label: 'Whisper STT', vramGB: 1 },
      { label: 'Ollama (small model)', vramGB: 2 },
      { label: 'Ollama (medium model)', vramGB: 4 },
      { label: 'Ollama (large model)', vramGB: 8 },
    ];

    for (const svc of possibleServices) {
      if (svc.vramGB <= availableVramGB) {
        canRun.push(svc.label);
      } else {
        cannotRun.push(svc.label);
      }
    }

    if (availableVramGB < 2) {
      suggestions.push('Low available VRAM. Consider stopping unused models or services.');
    }
    if (totalVramGB >= 16 && availableVramGB >= 8) {
      suggestions.push(`${availableVramGB.toFixed(0)}GB available. Plenty of room for additional services.`);
    }

    return { totalVramGB, usedVramGB, availableVramGB, canRun, cannotRun, suggestions };
  }

  /** Build capacity across local + peer devices. */
  buildMeshCapacity(
    peerRows?: Array<{ name: string; gpu_name?: string; total_memory_gb?: number; processes?: ProcessStatus[] }>,
  ): MeshCapacity {
    const dev = this.lastDevice || detectDevice();
    const localCapacity = this.estimateCapacity(dev);

    const devices: MeshCapacity['devices'] = [
      {
        name: `${dev.cpuModel} (local)`,
        isLocal: true,
        capacity: localCapacity,
        processes: this.lastStatuses,
      },
    ];

    const recommendations: string[] = [...localCapacity.suggestions];

    if (peerRows) {
      for (const peer of peerRows) {
        const peerDevice: DeviceInfo = {
          arch: 'unknown',
          platform: 'unknown',
          totalMemoryGB: peer.total_memory_gb || 0,
          freeMemoryGB: (peer.total_memory_gb || 0) * 0.5, // estimate for remote peers
          cpuModel: peer.name,
          cpuCores: 0,
          isAppleSilicon: false,
          hasNvidiaGpu: !!peer.gpu_name,
          gpuName: peer.gpu_name,
        };
        const peerProcesses = peer.processes || [];
        const peerUsedVram = peerProcesses.filter(p => p.running).reduce((s, p) => s + p.vramMB, 0);
        const peerTotalVram = estimateDeviceVram(peerDevice);

        devices.push({
          name: peer.name,
          isLocal: false,
          capacity: {
            totalVramGB: peerTotalVram,
            usedVramGB: peerUsedVram / 1024,
            availableVramGB: Math.max(0, peerTotalVram - peerUsedVram / 1024),
            canRun: [],
            cannotRun: [],
            suggestions: [],
          },
          processes: peerProcesses,
        });

        if (peerUsedVram === 0 && peerTotalVram >= 8) {
          recommendations.push(
            `"${peer.name}" has ${peerTotalVram}GB VRAM with no GPU processes. Consider routing heavy workloads there.`,
          );
        }
      }
    }

    return { devices, recommendations };
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  private async poll(): Promise<void> {
    const [ollamaStatus, mediaCapabilities] = await Promise.all([
      this.probeOllama(),
      probeMediaCapabilities(),
    ]);

    this.lastDevice = detectDevice();

    const now = new Date().toISOString();

    const statuses: ProcessStatus[] = [
      ollamaStatus,
      {
        name: 'comfyui' as const,
        running: mediaCapabilities.comfyui.available,
        url: mediaCapabilities.comfyui.url,
        memoryMB: mediaCapabilities.comfyui.available ? estimateComfyMemory(mediaCapabilities.comfyui.models) : 0,
        vramMB: mediaCapabilities.comfyui.available ? estimateComfyVram(mediaCapabilities.comfyui.models) : 0,
        details: {
          models: mediaCapabilities.comfyui.models,
          modelCount: mediaCapabilities.comfyui.models.length,
        },
        lastChecked: now,
      },
      {
        name: 'kokoro' as const,
        running: mediaCapabilities.kokoro.available,
        url: mediaCapabilities.kokoro.url,
        memoryMB: mediaCapabilities.kokoro.available ? 500 : 0,
        vramMB: mediaCapabilities.kokoro.available ? VRAM_ESTIMATES['kokoro'] : 0,
        details: {
          voices: mediaCapabilities.kokoro.voices,
          voiceCount: mediaCapabilities.kokoro.voices.length,
        },
        lastChecked: now,
      },
      {
        name: 'whisper' as const,
        running: mediaCapabilities.whisper.available,
        memoryMB: mediaCapabilities.whisper.available ? 300 : 0,
        vramMB: mediaCapabilities.whisper.available ? VRAM_ESTIMATES['whisper-default'] : 0,
        details: {},
        lastChecked: now,
      },
    ];

    // Detect changes
    const changed = this.hasChanged(statuses);
    this.lastStatuses = statuses;

    if (changed) {
      logger.debug('[process-monitor] Process statuses changed');
      this.emitter.emit('processes:changed', statuses);
    }
  }

  private async probeOllama(): Promise<ProcessStatus> {
    const now = new Date().toISOString();
    try {
      const response = await fetch(`${this.ollamaUrl}/api/ps`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return { name: 'ollama', running: false, url: this.ollamaUrl, memoryMB: 0, vramMB: 0, details: {}, lastChecked: now };
      }

      const data = await response.json() as { models?: Array<{ name: string; size: number; size_vram?: number }> };
      const models = data.models || [];
      const totalVram = models.reduce((sum, m) => sum + (m.size_vram || 0), 0);
      const totalSize = models.reduce((sum, m) => sum + m.size, 0);

      return {
        name: 'ollama',
        running: true,
        url: this.ollamaUrl,
        memoryMB: Math.round(totalSize / (1024 * 1024)),
        vramMB: Math.round(totalVram / (1024 * 1024)),
        details: {
          loadedModels: models.map(m => m.name),
          modelCount: models.length,
        },
        lastChecked: now,
      };
    } catch {
      return { name: 'ollama', running: false, url: this.ollamaUrl, memoryMB: 0, vramMB: 0, details: {}, lastChecked: now };
    }
  }

  private hasChanged(newStatuses: ProcessStatus[]): boolean {
    if (this.lastStatuses.length !== newStatuses.length) return true;
    for (let i = 0; i < newStatuses.length; i++) {
      const prev = this.lastStatuses[i];
      const next = newStatuses[i];
      if (prev.running !== next.running || prev.vramMB !== next.vramMB) return true;
    }
    return false;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function estimateDeviceVram(device: DeviceInfo): number {
  if (device.isAppleSilicon) {
    // Apple Silicon shares system RAM; ~75% available for GPU
    return Math.round(device.totalMemoryGB * 0.75);
  }
  if (device.hasNvidiaGpu) {
    // Common NVIDIA VRAM sizes based on GPU name hints
    const name = device.gpuName?.toLowerCase() || '';
    if (name.includes('4090') || name.includes('a100')) return 24;
    if (name.includes('4080') || name.includes('3090')) return 24;
    if (name.includes('4070')) return 12;
    if (name.includes('3080')) return 10;
    if (name.includes('3070') || name.includes('4060')) return 8;
    return 8; // conservative default
  }
  return 0;
}

function estimateComfyVram(models: string[]): number {
  if (models.length === 0) return VRAM_ESTIMATES['comfyui-default'];
  const modelStr = models.join(' ').toLowerCase();
  if (modelStr.includes('flux')) return VRAM_ESTIMATES['comfyui-flux'];
  if (modelStr.includes('sdxl') || modelStr.includes('xl')) return VRAM_ESTIMATES['comfyui-sdxl'];
  if (modelStr.includes('sd_1') || modelStr.includes('1.5')) return VRAM_ESTIMATES['comfyui-sd15'];
  return VRAM_ESTIMATES['comfyui-default'];
}

function estimateComfyMemory(models: string[]): number {
  // ComfyUI system RAM usage is typically ~2-4GB
  return models.length > 0 ? 3000 : 2000;
}
