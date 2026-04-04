/**
 * Model Manager Screen
 * List installed models with actions: set active, set orchestrator, load, unload, pull, delete.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelSource } from '../../config.js';
import { updateConfigFile } from '../../config.js';
import { validateAnthropicApiKey } from '../../lib/anthropic-auth.js';
import { getModelTurboQuantInfo } from '../../lib/ollama-models.js';

interface InstalledModelInfo {
  tag: string;
  label: string;
  status: 'loaded' | 'installed' | 'unavailable';
  isActive: boolean;
  isOrchestrator: boolean;
  mlxModelId?: string | null;
}

interface InferenceStatusInfo {
  activeProvider: 'mlx' | 'llama-cpp' | 'ollama';
  mlx: { url: string; model: string | null } | null;
  switchInProgress: boolean;
  capacity: { totalVramGB: number; usedVramGB: number; availableVramGB: number };
}

interface CatalogModel {
  tag: string;
  label: string;
  description: string;
  sizeGB: number;
  fits: boolean;
  installed: boolean;
}

type View = 'list' | 'catalog' | 'cloud';

const CLOUD_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Fast, affordable' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', description: 'Balanced intelligence and speed' },
];

interface ModelManagerProps {
  port: number;
  sessionToken: string;
  onBack: () => void;
  modelSource?: ModelSource;
  anthropicApiKey?: string;
  cloudModel?: string;
}

export function ModelManager({ port, sessionToken, onBack, modelSource = 'local', anthropicApiKey = '', cloudModel = 'claude-haiku-4-5-20251001' }: ModelManagerProps) {
  const [models, setModels] = useState<InstalledModelInfo[]>([]);
  const [_activeModel, setActiveModel] = useState('');
  const [_orchestratorModel, setOrchestratorModel] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Catalog (pull) sub-view
  const [view, setView] = useState<View>('list');
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogIdx, setCatalogIdx] = useState(0);
  const [pullProgress, setPullProgress] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number | null>(null);

  // Cloud view state
  const [cloudIdx, setCloudIdx] = useState(0);
  const [cloudKeyInput, setCloudKeyInput] = useState(anthropicApiKey);
  const [cloudKeyEditing, setCloudKeyEditing] = useState(false);
  const [cloudKeyValidating, setCloudKeyValidating] = useState(false);

  // Inference status (provider, VRAM, switch progress)
  const [inferenceStatus, setInferenceStatus] = useState<InferenceStatusInfo | null>(null);

  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apiFetch = useCallback(async <T = unknown>(path: string, options?: RequestInit): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        ...options?.headers,
      },
      signal: options?.signal || AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(body || `HTTP ${res.status}`);
    }
    return res.json() as T;
  }, [port, sessionToken]);

  const fetchModels = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch<{
        data: {
          models: InstalledModelInfo[];
          activeModel: string;
          orchestratorModel: string;
        };
      }>('/api/models/installed');
      setModels(res.data.models);
      setActiveModel(res.data.activeModel);
      setOrchestratorModel(res.data.orchestratorModel);
      if (selectedIdx >= res.data.models.length && res.data.models.length > 0) {
        setSelectedIdx(res.data.models.length - 1);
      }
    } catch {
      setMessage('Couldn\'t load models');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, selectedIdx]);

  const fetchInferenceStatus = useCallback(async () => {
    try {
      const res = await apiFetch<InferenceStatusInfo>('/api/inference/status');
      setInferenceStatus(res);
    } catch {
      // Older daemon may not have this endpoint
    }
  }, [apiFetch]);

  useEffect(() => { fetchModels(); fetchInferenceStatus(); }, [fetchModels, fetchInferenceStatus]);

  const showMessage = (msg: string) => {
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    setMessage(msg);
    messageTimerRef.current = setTimeout(() => setMessage(null), 3000);
  };

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await apiFetch<{
        data: {
          catalog: CatalogModel[];
        };
      }>('/api/models/catalog');
      // Only show models that fit and aren't installed
      const available = res.data.catalog.filter(m => m.fits && !m.installed);
      setCatalog(available);
      setCatalogIdx(0);
    } catch {
      showMessage('Couldn\'t load model catalog');
    }
  }, [apiFetch]);

  const startPull = useCallback(async (tag: string) => {
    setActionInProgress(true);
    setPullProgress(`Starting download of ${tag}...`);
    setPullPercent(null);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/models/${encodeURIComponent(tag)}/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const progress = JSON.parse(line) as { status: string; percent?: number; error?: string };
            if (progress.error) {
              throw new Error(progress.error);
            }
            setPullProgress(progress.status);
            if (progress.percent !== undefined) {
              setPullPercent(progress.percent);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      setPullProgress(null);
      setPullPercent(null);
      setView('list');
      showMessage(`Downloaded ${tag}`);
      await fetchModels();
    } catch (err) {
      setPullProgress(null);
      setPullPercent(null);
      showMessage(`Couldn't download: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setActionInProgress(false);
    }
  }, [port, sessionToken, fetchModels]);

  useInput((input, key) => {
    if (actionInProgress) return;

    // --- Cloud sub-view ---
    if (view === 'cloud') {
      if (cloudKeyEditing) {
        if (key.escape) {
          setCloudKeyEditing(false);
          return;
        }
        if (key.return && cloudKeyInput.trim() && !cloudKeyValidating) {
          setCloudKeyValidating(true);
          validateAnthropicApiKey(cloudKeyInput.trim())
            .then((valid) => {
              if (valid) {
                updateConfigFile({ anthropicApiKey: cloudKeyInput.trim() });
                showMessage('API key saved');
                setCloudKeyEditing(false);
              } else {
                showMessage('Invalid API key');
              }
            })
            .catch(() => showMessage('Could not validate key'))
            .finally(() => setCloudKeyValidating(false));
          return;
        }
        if (key.backspace || key.delete) {
          setCloudKeyInput(prev => prev.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setCloudKeyInput(prev => prev + input);
          return;
        }
        return;
      }

      if (key.escape) { setView('list'); return; }
      if (input === 'j' || key.downArrow) {
        setCloudIdx(i => Math.min(i + 1, CLOUD_MODELS.length - 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setCloudIdx(i => Math.max(i - 1, 0));
        return;
      }
      // Set selected cloud model as orchestrator
      if (input === 's') {
        const selected = CLOUD_MODELS[cloudIdx];
        if (selected) {
          updateConfigFile({ cloudModel: selected.id, modelSource: 'cloud' });
          showMessage(`Set ${selected.label} as orchestrator (cloud)`);
        }
        return;
      }
      // Enter/change API key
      if (input === 'e') {
        setCloudKeyEditing(true);
        return;
      }
      return;
    }

    // --- Catalog sub-view ---
    if (view === 'catalog') {
      if (key.escape) {
        setView('list');
        return;
      }
      if (catalog.length === 0) return;

      if (input === 'j' || key.downArrow) {
        setCatalogIdx(i => Math.min(i + 1, catalog.length - 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setCatalogIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (key.return) {
        const model = catalog[catalogIdx];
        if (model) {
          startPull(model.tag);
        }
        return;
      }
      return;
    }

    // --- Main list view ---
    if (key.escape) {
      onBack();
      return;
    }

    // Clear delete confirmation on any other key
    if (deleteConfirm && input !== 'd') {
      setDeleteConfirm(null);
    }

    if (models.length === 0) {
      // Allow pull even with no models installed
      if (input === 'p') {
        setView('catalog');
        fetchCatalog();
        return;
      }
      return;
    }

    // Navigate
    if (input === 'j' || key.downArrow) {
      setSelectedIdx(i => Math.min(i + 1, models.length - 1));
      return;
    }
    if (input === 'k' || key.upArrow) {
      setSelectedIdx(i => Math.max(i - 1, 0));
      return;
    }

    const model = models[selectedIdx];
    if (!model) return;

    // Set active
    if (input === 'a') {
      if (model.isActive) {
        showMessage('Already the active model');
        return;
      }
      setActionInProgress(true);
      apiFetch('/api/models/active', {
        method: 'PUT',
        body: JSON.stringify({ model: model.tag }),
      })
        .then(() => {
          showMessage(`Set ${model.tag} as active`);
          return fetchModels();
        })
        .catch(() => showMessage('Couldn\'t set active model'))
        .finally(() => setActionInProgress(false));
      return;
    }

    // Set orchestrator (toggle: press again to clear)
    if (input === 's') {
      const newModel = model.isOrchestrator ? '' : model.tag;
      setActionInProgress(true);
      apiFetch('/api/models/orchestrator', {
        method: 'PUT',
        body: JSON.stringify({ model: newModel }),
      })
        .then(() => {
          showMessage(newModel ? `Set ${model.tag} as orchestrator` : 'Reset orchestrator to auto');
          return fetchModels();
        })
        .catch(() => showMessage('Couldn\'t set orchestrator model'))
        .finally(() => setActionInProgress(false));
      return;
    }

    // Load into VRAM
    if (input === 'l') {
      if (model.status === 'loaded') {
        showMessage('Model is already loaded in memory');
        return;
      }
      if (model.status === 'unavailable') {
        showMessage('Model is unavailable');
        return;
      }
      setActionInProgress(true);
      setMessage(`Loading ${model.tag} into memory...`);
      apiFetch(`/api/models/${encodeURIComponent(model.tag)}/load`, {
        method: 'POST',
        signal: AbortSignal.timeout(130_000),
      })
        .then(() => {
          showMessage(`Loaded ${model.tag} into memory`);
          return fetchModels();
        })
        .catch(() => showMessage('Couldn\'t load model'))
        .finally(() => setActionInProgress(false));
      return;
    }

    // Unload from VRAM (Ollama or MLX)
    if (input === 'u') {
      // Allow unloading MLX model even when it's the active model
      const isMLXModel = inferenceStatus?.activeProvider === 'mlx' && !!model.mlxModelId;
      if (!isMLXModel && model.status !== 'loaded') {
        showMessage('Model is not loaded in memory');
        return;
      }
      if (!isMLXModel && model.isActive) {
        showMessage('Can\'t unload the active model');
        return;
      }
      if (!isMLXModel && model.isOrchestrator) {
        showMessage('Can\'t unload the orchestrator model');
        return;
      }
      setActionInProgress(true);
      // Use MLX unload endpoint if this model is running on MLX
      const unloadUrl = isMLXModel
        ? '/api/inference/mlx/unload'
        : `/api/models/${encodeURIComponent(model.tag)}/unload`;
      apiFetch(unloadUrl, {
        method: 'POST',
      })
        .then(() => {
          showMessage(isMLXModel ? `Unloaded MLX model from GPU` : `Unloaded ${model.tag} from memory`);
          fetchInferenceStatus();
          return fetchModels();
        })
        .catch(() => showMessage('Couldn\'t unload model'))
        .finally(() => setActionInProgress(false));
      return;
    }

    // Pull new model from catalog
    if (input === 'p') {
      setView('catalog');
      fetchCatalog();
      return;
    }

    // Delete model (double-press to confirm)
    if (input === 'd') {
      if (model.isActive) {
        showMessage('Can\'t delete the active model');
        return;
      }
      if (model.isOrchestrator) {
        showMessage('Can\'t delete the orchestrator model');
        return;
      }
      if (deleteConfirm === model.tag) {
        // Second press: confirmed
        setDeleteConfirm(null);
        setActionInProgress(true);
        apiFetch(`/api/models/${encodeURIComponent(model.tag)}`, {
          method: 'DELETE',
        })
          .then(() => {
            showMessage(`Deleted ${model.tag}`);
            return fetchModels();
          })
          .catch(() => showMessage('Couldn\'t delete model'))
          .finally(() => setActionInProgress(false));
      } else {
        // First press: ask for confirmation
        setDeleteConfirm(model.tag);
        setMessage(`Delete ${model.tag}? Press d again to confirm.`);
      }
      return;
    }

    // Cloud models view
    if (input === 'c') {
      setView('cloud');
      return;
    }

    // Refresh
    if (input === 'R') {
      fetchModels();
    }
  });

  // --- Catalog sub-view ---
  if (view === 'catalog') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Pull New Model</Text>
          <Text color="gray">                                   Esc to go back</Text>
        </Box>

        {pullProgress ? (
          <Box flexDirection="column">
            <Text color="cyan">{pullProgress}</Text>
            {pullPercent !== null && (
              <Box>
                <Text color="green">
                  {'█'.repeat(Math.floor(pullPercent / 4))}
                  {'░'.repeat(25 - Math.floor(pullPercent / 4))}
                </Text>
                <Text color="gray"> {pullPercent}%</Text>
              </Box>
            )}
          </Box>
        ) : catalog.length === 0 ? (
          <Text color="gray">No additional models available for your device</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold>AVAILABLE MODELS</Text>
            <Text color="gray" dimColor>Models that fit your device and are not installed yet</Text>
            <Box marginTop={1} flexDirection="column">
              {catalog.map((model, idx) => {
                const isSelected = idx === catalogIdx;
                return (
                  <Box key={model.tag} flexDirection="column">
                    <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                      {isSelected ? '▸ ' : '  '}
                      {model.label}
                      <Text color="gray"> ({model.tag}, {model.sizeGB}GB)</Text>
                    </Text>
                    {isSelected && model.description && (
                      <Text color="gray">    {model.description}</Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {message && (
          <Box marginTop={1}>
            <Text color="yellow">{message}</Text>
          </Box>
        )}

        {!pullProgress && (
          <Box marginTop={1}>
            <Text color="gray">
              j/k navigate   Enter download   Esc back
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // --- Cloud sub-view ---
  if (view === 'cloud') {
    const hasKey = !!anthropicApiKey;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Cloud Models</Text>
          <Text color="gray">                                     Esc to go back</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="gray">Auth: </Text>
          <Text color={hasKey ? 'green' : 'yellow'}>
            {hasKey ? '● API key configured' : '○ No API key'}
          </Text>
        </Box>

        {cloudKeyEditing ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="cyan">API key: </Text>
            <Text>{cloudKeyInput ? cloudKeyInput.slice(0, 7) + '•'.repeat(Math.min(cloudKeyInput.length - 7, 20)) : ''}</Text>
            <Text color="cyan">█</Text>
            {cloudKeyValidating && <Text color="yellow"> Validating...</Text>}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text bold>CLAUDE MODELS</Text>
            <Box marginTop={1} flexDirection="column">
              {CLOUD_MODELS.map((model, idx) => {
                const isSelected = idx === cloudIdx;
                const isActive = model.id === cloudModel && modelSource === 'cloud';
                return (
                  <Box key={model.id}>
                    <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                      {isSelected ? '▸ ' : '  '}
                      {isActive ? '◉' : '○'} {model.label}
                      <Text color="gray"> ({model.description})</Text>
                      {isActive && <Text color="magenta"> ◆ Active</Text>}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {message && (
          <Box marginTop={1}>
            <Text color="yellow">{message}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color="gray">
            {cloudKeyEditing
              ? 'Enter save   Esc cancel'
              : 'j/k navigate  s set orchestrator  e enter API key  Esc back'}
          </Text>
        </Box>
      </Box>
    );
  }

  // --- Main list view ---
  const providerLabel = inferenceStatus?.activeProvider === 'mlx' ? ' [MLX]'
    : inferenceStatus?.activeProvider === 'llama-cpp' ? ' [llama.cpp]'
    : '';
  const vramInfo = inferenceStatus?.capacity
    ? `VRAM ${inferenceStatus.capacity.usedVramGB.toFixed(1)}/${inferenceStatus.capacity.totalVramGB.toFixed(0)}GB`
    : '';

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Model Manager</Text>
        {providerLabel && <Text color="green">{providerLabel}</Text>}
        {vramInfo && <Text color="gray">  {vramInfo}</Text>}
        <Text color="gray">        Esc to go back</Text>
      </Box>

      {inferenceStatus?.switchInProgress && (
        <Box marginBottom={1}>
          <Text color="cyan">⟳ Model switch in progress...</Text>
        </Box>
      )}

      {loading && models.length === 0 ? (
        <Text color="gray">Loading models...</Text>
      ) : models.length === 0 ? (
        <Box flexDirection="column">
          <Text color="gray">No models installed</Text>
          <Box marginTop={1}>
            <Text color="gray">Press </Text>
            <Text bold color="white">p</Text>
            <Text color="gray"> to download a model</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>INSTALLED MODELS</Text>
          {models.map((model, idx) => {
            const isSelected = idx === selectedIdx;
            const isLoaded = model.status === 'loaded';
            const dot = isLoaded ? '◉' : '●';
            const dotColor = isLoaded ? 'green' : 'gray';

            const badges: string[] = [];
            if (model.isActive) badges.push('★ Active');
            if (model.isOrchestrator) badges.push('◆ Orchestrator');
            if (model.mlxModelId) badges.push('◈ MLX');
            const tqInfo = getModelTurboQuantInfo(model.tag);
            if (tqInfo.compatible) badges.push(`⚡ TQ ${tqInfo.ratio4bit}x`);

            return (
              <Box key={model.tag}>
                <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                  {isSelected ? '▸ ' : '  '}
                  <Text color={dotColor}>{dot}</Text>
                  {' '}{model.tag}
                  {'  '}
                  <Text color="gray">{model.status.padEnd(12)}</Text>
                  {badges.map(b => (
                    <Text key={b} color={b.startsWith('★') ? 'yellow' : b.startsWith('◈') ? 'green' : b.startsWith('⚡') ? 'cyan' : 'magenta'}>{' '}{b}</Text>
                  ))}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {message && (
        <Box marginTop={1}>
          <Text color="yellow">{message}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          j/k navigate  a active  s orchestrator  l load  u unload  p pull  c cloud  d delete  Esc back
        </Text>
      </Box>
    </Box>
  );
}
