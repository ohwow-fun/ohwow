/**
 * useOllamaModels Hook
 * Fetches model summaries from the daemon HTTP API and listens for change events.
 */

import { useState, useEffect } from 'react';
import type { OllamaModelSummary } from '../../lib/ollama-monitor-types.js';
import { getEventBus } from './use-event-bus.js';

export function useOllamaModels(port: number): OllamaModelSummary[] {
  const [models, setModels] = useState<OllamaModelSummary[]>([]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      try {
        const resp = await fetch(`http://localhost:${port}/api/ollama/models`, {
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const json = await resp.json() as { data: OllamaModelSummary[] };
          if (!cancelled) setModels(json.data || []);
        }
      } catch {
        // Non-critical
      }
    };

    refresh();
    const interval = setInterval(refresh, 30_000);

    const bus = getEventBus();
    const onChange = () => { refresh(); };
    bus.on('ollama:models-changed', onChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      bus.off('ollama:models-changed', onChange);
    };
  }, [port]);

  return models;
}
