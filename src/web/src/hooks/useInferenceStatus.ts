/**
 * useInferenceStatus Hook
 * Polls /api/inference/status for active provider, VRAM capacity, and model switch state.
 * Refreshes on WebSocket events for real-time updates during model switches.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { useWsListener } from './useWebSocket';

export interface InferenceCapacity {
  totalVramGB: number;
  usedVramGB: number;
  availableVramGB: number;
}

export interface InferenceStatus {
  activeProvider: 'mlx' | 'llama-cpp' | 'ollama';
  mlx: { url: string; model: string | null } | null;
  llamaCpp: { url: string } | null;
  switchInProgress: boolean;
  capacity: InferenceCapacity;
  processes: Array<{ name: string; running: boolean; vramMB: number }>;
}

const POLL_INTERVAL_MS = 10_000;

export function useInferenceStatus() {
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const tickRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api<InferenceStatus>('/api/inference/status');
      setStatus(res);
    } catch {
      // Endpoint may not exist on older daemons
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Refresh on model switch and inference events
  useWsListener(useCallback((event: string) => {
    if (
      event === 'model:switch-started' ||
      event === 'model:switch-complete' ||
      event === 'model:switch-failed' ||
      event === 'inference:capabilities-changed'
    ) {
      tickRef.current++;
      fetchStatus();
    }
  }, [fetchStatus]));

  return { status, loading, refetch: fetchStatus };
}
