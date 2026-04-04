/** Shared types for the model management UI. */

export interface DeviceInfo {
  arch: string;
  platform: string;
  totalMemoryGB: number;
  cpuModel: string;
  cpuCores: number;
  isAppleSilicon: boolean;
  hasNvidiaGpu: boolean;
  gpuName?: string;
  mlxAvailable?: boolean;
  pythonPath?: string;
}

export interface InstalledModel {
  tag: string;
  label: string;
  description: string;
  sizeGB: number | null;
  features: string[];
  family: string | null;
  toolCalling: boolean;
  vision: boolean;
  status: 'loaded' | 'installed' | 'unavailable';
  totalRequests: number;
  totalDurationMs: number;
  lastUsedAt: string | null;
  isActive: boolean;
  isOrchestrator: boolean;
  inCatalog: boolean;
}

export interface CatalogModel {
  tag: string;
  label: string;
  description: string;
  sizeGB: number;
  minRAM: number;
  features: string[];
  family: string;
  tier: string;
  recommended?: boolean;
  toolCalling?: boolean;
  vision?: boolean;
  fits: boolean;
  installed: boolean;
}
