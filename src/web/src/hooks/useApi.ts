/**
 * useApi Hook
 * Generic GET hook with loading/error state and refetch capability.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useApi<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!path) return;

    let cancelled = false;
    setLoading(true);

    api<{ data: T }>(path)
      .then(res => {
        if (!cancelled) {
          setData(res.data);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  return { data, loading, error, refetch };
}
