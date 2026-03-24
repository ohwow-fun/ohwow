/**
 * useTier Hook
 * Fetches the runtime tier and model status from the public /api/runtime/tier endpoint.
 * Does not require auth — this endpoint is public.
 */

import { useState, useEffect } from 'react';

type RuntimeTier = 'free' | 'connected';

interface TierState {
  tier: RuntimeTier;
  modelReady: boolean;
  loading: boolean;
}

export function useTier(): TierState {
  const [tier, setTier] = useState<RuntimeTier>('connected');
  const [modelReady, setModelReady] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/runtime/tier')
      .then(res => res.json())
      .then((body: { data: { tier: string; modelReady?: boolean } }) => {
        if (!cancelled) {
          const raw = body.data.tier;
          // Map any paid tier name to 'connected', backward compat
          const resolved: RuntimeTier = raw === 'free' ? 'free' : 'connected';
          setTier(resolved);
          setModelReady(body.data.modelReady ?? true);
        }
      })
      .catch(() => {
        // Default to connected if fetch fails (backwards compat)
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  return { tier, modelReady, loading };
}
