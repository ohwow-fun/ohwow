/**
 * Resources Settings Subtab
 * Shows device info, running AI/media processes, VRAM capacity, and suggestions.
 * Polls GET /api/process-status from the daemon.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { ProcessStatus, CapacityEstimate } from '../../../lib/process-monitor.js';
import type { DeviceInfo } from '../../../lib/device-info.js';
import { detectDevice, formatDeviceCompact } from '../../../lib/device-info.js';
import type { InferenceCapabilities } from '../../../lib/inference-capabilities.js';
import { useEvent } from '../../hooks/use-event-bus.js';

interface ResourcesTabProps {
  port: number;
}

interface ProcessStatusResponse {
  statuses: ProcessStatus[];
  capacity: CapacityEstimate;
}

const STATUS_COLORS: Record<string, string> = {
  running: 'green',
  stopped: 'gray',
};

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${mb}MB`;
}

function capacityBar(used: number, total: number, width: number): string {
  if (total <= 0) return '[unknown]';
  const ratio = Math.min(1, used / total);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${Math.round(ratio * 100)}%`;
}

export function ResourcesTab({ port }: ResourcesTabProps) {
  const [statuses, setStatuses] = useState<ProcessStatus[]>([]);
  const [capacity, setCapacity] = useState<CapacityEstimate | null>(null);
  const [device] = useState<DeviceInfo>(() => detectDevice());
  const capabilitiesEvent = useEvent('inference:capabilities-changed');
  const [capabilities, setCapabilities] = useState<InferenceCapabilities | null>(null);

  useEffect(() => {
    if (capabilitiesEvent) setCapabilities(capabilitiesEvent);
  }, [capabilitiesEvent]);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/process-status`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok || cancelled) return;
        const data = await resp.json() as ProcessStatusResponse;
        if (cancelled) return;
        setStatuses(data.statuses);
        setCapacity(data.capacity);
      } catch {
        // Daemon may not be running
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [port]);

  return (
    <Box flexDirection="column">
      {/* Device Info */}
      <Text bold color="cyan">Device</Text>
      <Text>  {formatDeviceCompact(device)}</Text>
      <Text>  RAM: <Text color="gray">{device.totalMemoryGB}GB</Text>  CPU: <Text color="gray">{device.cpuCores} cores</Text></Text>
      {device.gpuName && <Text>  GPU: <Text color="gray">{device.gpuName}</Text></Text>}

      {/* TurboQuant Status */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">KV Cache Compression</Text>
        {capabilities?.turboQuantActive ? (
          <>
            <Text>  <Text color="green">●</Text> TurboQuant {capabilities.turboQuantBits}-bit active via {capabilities.provider}</Text>
            <Text color="gray">  Cache: K={capabilities.cacheTypeK}  V={capabilities.cacheTypeV}</Text>
          </>
        ) : (
          <Text>  <Text color="gray">○</Text> <Text color="gray">Not active. Set turboQuantBits in config and install llama-server.</Text></Text>
        )}
      </Box>

      {/* Process Table */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Processes</Text>
        {statuses.length === 0 ? (
          <Text color="gray">  Loading...</Text>
        ) : (
          statuses.map((proc) => (
            <Box key={proc.name}>
              <Text>  </Text>
              <Text color={STATUS_COLORS[proc.running ? 'running' : 'stopped']}>
                {proc.running ? '●' : '○'}
              </Text>
              <Text> </Text>
              <Text bold>{proc.name.padEnd(10)}</Text>
              <Text color="gray">
                {proc.running
                  ? `RAM: ${formatMB(proc.memoryMB)}  VRAM: ${formatMB(proc.vramMB)}`
                  : 'Not running'}
              </Text>
              {proc.running && proc.details.modelCount != null && (
                <Text color="gray">  ({proc.details.modelCount as number} model{(proc.details.modelCount as number) === 1 ? '' : 's'})</Text>
              )}
              {proc.running && proc.details.voiceCount != null && (
                <Text color="gray">  ({proc.details.voiceCount as number} voice{(proc.details.voiceCount as number) === 1 ? '' : 's'})</Text>
              )}
            </Box>
          ))
        )}
      </Box>

      {/* VRAM Capacity */}
      {capacity && capacity.totalVramGB > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">VRAM Capacity</Text>
          <Text>  {capacityBar(capacity.usedVramGB, capacity.totalVramGB, 20)}</Text>
          <Text color="gray">  {capacity.usedVramGB.toFixed(1)}GB / {capacity.totalVramGB}GB used</Text>
        </Box>
      )}

      {/* Suggestions */}
      {capacity && capacity.suggestions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Suggestions</Text>
          {capacity.suggestions.map((s, i) => (
            <Text key={i} color="gray">  {s}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
