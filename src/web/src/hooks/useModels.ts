/**
 * useModels Hook
 * Manages local Ollama model state: installed models, catalog, downloads, active model.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { api, getToken } from '../api/client';
import { toast } from '../components/Toast';
import type { InstalledModel, CatalogModel, DeviceInfo } from '../pages/settings/models/model-types';

interface ModelsState {
  installed: InstalledModel[];
  catalog: CatalogModel[];
  activeModel: string;
  orchestratorModel: string;
  device: DeviceInfo | null;
  memoryTier: string;
  ollamaRunning: boolean;
  loading: boolean;
  catalogLoading: boolean;
  catalogLoaded: boolean;
  downloading: { tag: string; percent: number; message: string } | null;
  openRouterKey: string;
  openRouterModel: string;
  openRouterConnected: boolean;
}

interface SSEProgress {
  phase?: string;
  message: string;
  percent?: number;
  done?: boolean;
  error?: string;
}

/** Consume an SSE response stream, calling onEvent for each parsed event. */
async function consumeSSE(
  res: Response,
  onEvent: (event: SSEProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          let parsed: SSEProgress;
          try {
            parsed = JSON.parse(data) as SSEProgress;
          } catch {
            continue; // Skip malformed JSON only
          }
          onEvent(parsed); // Let callback errors propagate
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function useModels() {
  const [state, setState] = useState<ModelsState>({
    installed: [],
    catalog: [],
    activeModel: '',
    orchestratorModel: '',
    device: null,
    memoryTier: '',
    ollamaRunning: false,
    loading: true,
    catalogLoading: false,
    catalogLoaded: false,
    downloading: null,
    openRouterKey: '',
    openRouterModel: '',
    openRouterConnected: false,
  });

  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight SSE download on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  /** Fetch installed models, active model, and Ollama status. */
  const fetchInstalled = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const res = await api<{ data: { models: InstalledModel[]; activeModel: string; orchestratorModel: string; ollamaRunning: boolean } }>('/api/models/installed');
      setState(s => ({
        ...s,
        installed: res.data.models,
        activeModel: res.data.activeModel,
        orchestratorModel: res.data.orchestratorModel || '',
        ollamaRunning: res.data.ollamaRunning,
        loading: false,
      }));
    } catch {
      setState(s => ({ ...s, loading: false }));
    }
  }, []);

  /** Fetch the full model catalog with device info. */
  const fetchCatalog = useCallback(async () => {
    setState(s => ({ ...s, catalogLoading: true }));
    try {
      const res = await api<{ data: { catalog: CatalogModel[]; device: DeviceInfo; memoryTier: string } }>('/api/models/catalog');
      setState(s => ({
        ...s,
        catalog: res.data.catalog,
        device: res.data.device,
        memoryTier: res.data.memoryTier,
        catalogLoading: false,
        catalogLoaded: true,
      }));
    } catch {
      setState(s => ({ ...s, catalogLoading: false }));
    }
  }, []);

  /** Set a model as active. Optimistic update with atomic prev capture. */
  const setActiveModel = useCallback(async (tag: string) => {
    let prev = '';
    setState(s => {
      prev = s.activeModel;
      return {
        ...s,
        activeModel: tag,
        installed: s.installed.map(m => ({ ...m, isActive: m.tag === tag })),
      };
    });
    try {
      await api('/api/models/active', {
        method: 'PUT',
        body: JSON.stringify({ model: tag }),
      });
      toast('success', 'Active model updated');
    } catch {
      setState(s => ({
        ...s,
        activeModel: prev,
        installed: s.installed.map(m => ({ ...m, isActive: m.tag === prev })),
      }));
      toast('error', 'Couldn\'t update active model');
    }
  }, []);

  /** Set the orchestrator model. Empty string clears the override (auto). */
  const setOrchestratorModel = useCallback(async (tag: string) => {
    let prev = '';
    setState(s => {
      prev = s.orchestratorModel;
      return {
        ...s,
        orchestratorModel: tag,
        installed: s.installed.map(m => ({ ...m, isOrchestrator: tag ? m.tag === tag : false })),
      };
    });
    try {
      await api('/api/models/orchestrator', {
        method: 'PUT',
        body: JSON.stringify({ model: tag }),
      });
      toast('success', tag ? 'Orchestrator model updated' : 'Orchestrator reset to auto');
    } catch {
      setState(s => ({
        ...s,
        orchestratorModel: prev,
        installed: s.installed.map(m => ({ ...m, isOrchestrator: prev ? m.tag === prev : false })),
      }));
      toast('error', 'Couldn\'t update orchestrator model');
    }
  }, []);

  /** Unload a model from memory without deleting it. */
  const unloadModel = useCallback(async (tag: string) => {
    setState(s => ({
      ...s,
      installed: s.installed.map(m => m.tag === tag ? { ...m, status: 'installed' as const } : m),
    }));
    try {
      await api(`/api/models/${encodeURIComponent(tag)}/unload`, { method: 'POST' });
      toast('success', 'Model unloaded from memory');
    } catch {
      // Re-fetch to get correct state
      await fetchInstalled();
      toast('error', 'Couldn\'t unload model');
    }
  }, [fetchInstalled]);

  /** Install a model via SSE (ensure-ollama then download-model). */
  const installModel = useCallback(async (tag: string) => {
    if (abortRef.current) return; // Already downloading

    const controller = new AbortController();
    abortRef.current = controller;

    setState(s => ({ ...s, downloading: { tag, percent: 0, message: 'Setting things up...' } }));

    try {
      // Step 1: Ensure Ollama is running
      const ollamaRes = await fetch('/api/onboarding/ensure-ollama', {
        method: 'POST',
        signal: controller.signal,
      });
      if (!ollamaRes.ok || !ollamaRes.body) throw new Error('Couldn\'t start Ollama');

      await consumeSSE(ollamaRes, (progress) => {
        setState(s => s.downloading ? ({
          ...s,
          downloading: { ...s.downloading, message: progress.message },
        }) : s);
        if (progress.error) throw new Error(progress.error);
      }, controller.signal);

      // Step 2: Download the model
      setState(s => s.downloading ? ({
        ...s,
        downloading: { ...s.downloading, percent: 0, message: 'Starting download...' },
      }) : s);

      const token = getToken();
      const downloadRes = await fetch('/api/onboarding/download-model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ tag }),
        signal: controller.signal,
      });
      if (!downloadRes.ok || !downloadRes.body) throw new Error('Couldn\'t start download');

      await consumeSSE(downloadRes, (progress) => {
        setState(s => s.downloading ? ({
          ...s,
          downloading: {
            ...s.downloading,
            message: progress.message,
            percent: progress.percent ?? s.downloading!.percent,
          },
        }) : s);
        if (progress.error) throw new Error(progress.error);
      }, controller.signal);

      // Done
      setState(s => ({ ...s, downloading: null }));
      toast('success', 'Model installed');

      // Refetch installed models
      const res = await api<{ data: { models: InstalledModel[]; activeModel: string; orchestratorModel: string; ollamaRunning: boolean } }>('/api/models/installed');
      setState(s => ({
        ...s,
        installed: res.data.models,
        activeModel: res.data.activeModel,
        orchestratorModel: res.data.orchestratorModel || '',
        ollamaRunning: res.data.ollamaRunning,
        // Update catalog installed flags
        catalog: s.catalog.map(m => m.tag === tag ? { ...m, installed: true } : m),
      }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setState(s => ({ ...s, downloading: null }));
      toast('error', err instanceof Error ? err.message : 'Download failed');
    } finally {
      abortRef.current = null;
    }
  }, []);

  /** Cancel an in-progress download. */
  const cancelDownload = useCallback(() => {
    abortRef.current?.abort();
    setState(s => ({ ...s, downloading: null }));
  }, []);

  /** Delete a model. Returns true on success, false on failure. */
  const deleteModel = useCallback(async (tag: string): Promise<boolean> => {
    try {
      await api(`/api/models/${encodeURIComponent(tag)}`, { method: 'DELETE' });
      toast('success', 'Model deleted');

      // Refetch
      const res = await api<{ data: { models: InstalledModel[]; activeModel: string; orchestratorModel: string; ollamaRunning: boolean } }>('/api/models/installed');
      setState(s => ({
        ...s,
        installed: res.data.models,
        activeModel: res.data.activeModel,
        orchestratorModel: res.data.orchestratorModel || '',
        ollamaRunning: res.data.ollamaRunning,
        catalog: s.catalog.map(m => m.tag === tag ? { ...m, installed: false } : m),
      }));
      return true;
    } catch {
      toast('error', 'Couldn\'t delete model');
      return false;
    }
  }, []);

  /** Start Ollama via SSE (for when it's not running). */
  const startOllama = useCallback(async () => {
    setState(s => ({ ...s, downloading: { tag: '', percent: 0, message: 'Starting Ollama...' } }));
    try {
      const ollamaRes = await fetch('/api/onboarding/ensure-ollama', { method: 'POST' });
      if (!ollamaRes.ok || !ollamaRes.body) throw new Error('Couldn\'t start Ollama');

      await consumeSSE(ollamaRes, (progress) => {
        setState(s => s.downloading ? ({
          ...s,
          downloading: { ...s.downloading, message: progress.message },
        }) : s);
        if (progress.error) throw new Error(progress.error);
      });

      setState(s => ({ ...s, downloading: null, ollamaRunning: true }));
      toast('success', 'Ollama is running');
      // Refetch installed models
      await fetchInstalled();
    } catch (err) {
      setState(s => ({ ...s, downloading: null }));
      toast('error', err instanceof Error ? err.message : 'Couldn\'t start Ollama');
    }
  }, [fetchInstalled]);

  /** Fetch OpenRouter configuration status. */
  const fetchOpenRouter = useCallback(async () => {
    try {
      const [keyRes, modelRes] = await Promise.all([
        api<{ data: { key: string; value: string } | null }>('/api/settings/openrouter_api_key'),
        api<{ data: { key: string; value: string } | null }>('/api/settings/openrouter_model'),
      ]);
      setState(s => ({
        ...s,
        openRouterKey: keyRes.data?.value || '',
        openRouterModel: modelRes.data?.value || '',
        openRouterConnected: !!keyRes.data?.value,
      }));
    } catch {
      // Settings may not exist yet
    }
  }, []);

  /** Save OpenRouter API key. */
  const saveOpenRouterKey = useCallback(async (key: string) => {
    try {
      await api('/api/settings/openrouter_api_key', {
        method: 'PUT',
        body: JSON.stringify({ value: key }),
      });
      setState(s => ({
        ...s,
        openRouterKey: key ? '****' + key.slice(-4) : '',
        openRouterConnected: !!key,
      }));
      toast('success', key ? 'OpenRouter API key saved' : 'OpenRouter API key removed');
    } catch {
      toast('error', 'Couldn\'t save OpenRouter API key');
    }
  }, []);

  /** Set OpenRouter model. */
  const setOpenRouterModel = useCallback(async (model: string) => {
    try {
      await api('/api/settings/openrouter_model', {
        method: 'PUT',
        body: JSON.stringify({ value: model }),
      });
      setState(s => ({ ...s, openRouterModel: model }));
      toast('success', 'OpenRouter model updated');
    } catch {
      toast('error', 'Couldn\'t update OpenRouter model');
    }
  }, []);

  return {
    ...state,
    fetchInstalled,
    fetchCatalog,
    setActiveModel,
    setOrchestratorModel,
    unloadModel,
    installModel,
    cancelDownload,
    deleteModel,
    startOllama,
    fetchOpenRouter,
    saveOpenRouterKey,
    setOpenRouterModel,
  };
}
