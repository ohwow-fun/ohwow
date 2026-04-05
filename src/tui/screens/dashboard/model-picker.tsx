/**
 * Model Picker Overlay
 * Unified search-first picker for browsing installed models, catalog models,
 * and cloud models. Supports inline installation with streaming progress.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelSource } from '../../../config.js';
import { validateAnthropicApiKey } from '../../../lib/anthropic-auth.js';

interface InstalledModel {
  tag: string;
  label: string;
  status: 'loaded' | 'installed' | 'unavailable';
  isActive: boolean;
  isOrchestrator: boolean;
  toolCalling?: boolean;
  vision?: boolean;
  sizeGB?: number | null;
}

interface CatalogModel {
  tag: string;
  label: string;
  description: string;
  sizeGB: number;
  minRAM: number;
  fits: boolean;
  installed: boolean;
  toolCalling?: boolean;
  vision?: boolean;
  contextSize?: number;
  family?: string;
}

type FlatItem =
  | { kind: 'installed'; data: InstalledModel }
  | { kind: 'catalog'; data: CatalogModel }
  | { kind: 'too_large'; data: CatalogModel };

type Step = 'source' | 'list' | 'cloud_auth';

const CLOUD_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
];

const MAX_VISIBLE = 12;

export interface ModelPickerProps {
  port: number;
  sessionToken: string;
  currentModel: string;
  anthropicApiKey?: string;
  anthropicOAuthToken?: string;
  cloudModel?: string;
  modelSource?: ModelSource;
  onSelect: (model: string, source: 'cloud' | 'local') => void;
  onClose: () => void;
  onApiKeySet?: (key: string) => void;
  isActive: boolean;
}

export function ModelPicker({
  port,
  sessionToken,
  currentModel,
  anthropicApiKey,
  anthropicOAuthToken,
  cloudModel,
  modelSource,
  onSelect,
  onClose,
  onApiKeySet,
  isActive,
}: ModelPickerProps) {
  // --- Step / source ---
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<'cloud' | 'local'>('local');
  const [sourceIdx, setSourceIdx] = useState(0);

  // --- Model data ---
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Device capacity ---
  const [deviceRAM, setDeviceRAM] = useState<number>(0);
  const [memoryTier, setMemoryTier] = useState<string>('');

  // --- Inline message ---
  const [message, setMessage] = useState<string | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Search ---
  const [searchQuery, setSearchQuery] = useState('');

  // --- List navigation ---
  const [listIdx, setListIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // --- Pull progress ---
  const [pulling, setPulling] = useState(false);
  const [pullTag, setPullTag] = useState('');
  const [pullStatus, setPullStatus] = useState('');
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // --- Cloud auth ---
  const [apiKey, setApiKey] = useState('');
  const [apiKeyValidating, setApiKeyValidating] = useState(false);
  const [apiKeyError, setApiKeyError] = useState('');

  // Detect if current model is cloud on mount
  useEffect(() => {
    const hasCloudKey = !!(anthropicApiKey || anthropicOAuthToken);
    const isCloud = hasCloudKey && CLOUD_MODELS.some(cm => cm.id === currentModel);
    setSource(isCloud ? 'cloud' : 'local');
    setSourceIdx(isCloud ? 0 : 1);
  }, [anthropicApiKey, anthropicOAuthToken, currentModel]);

  // --- API helper ---
  const apiFetch = useCallback(async <T = unknown>(path: string, options?: RequestInit): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
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

  const showMessage = useCallback((msg: string) => {
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    setMessage(msg);
    messageTimerRef.current = setTimeout(() => setMessage(null), 3000);
  }, []);

  // --- Fetch models when entering list step ---
  useEffect(() => {
    if (step !== 'list' || source === 'cloud') return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [installedRes, catalogRes] = await Promise.all([
          apiFetch<{
            data: {
              models: InstalledModel[];
              activeModel: string;
            };
          }>('/api/models/installed'),
          apiFetch<{
            data: {
              catalog: CatalogModel[];
              device: { totalMemoryGB: number };
              memoryTier: string;
            };
          }>('/api/models/catalog'),
        ]);

        if (cancelled) return;
        setInstalled(installedRes.data.models);
        // Store all uninstalled catalog models (both fitting and too-large)
        setCatalog(catalogRes.data.catalog.filter(m => !m.installed));
        setDeviceRAM(catalogRes.data.device.totalMemoryGB);
        setMemoryTier(catalogRes.data.memoryTier);
        setListIdx(0);
        setScrollOffset(0);
        setSearchQuery('');
      } catch {
        if (!cancelled) setError("Couldn't load models");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [step, source, apiFetch]);

  // --- Filtered + flat list ---
  const matchesQuery = useCallback((tag: string, label: string, family?: string) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return tag.toLowerCase().includes(q)
      || label.toLowerCase().includes(q)
      || (family ? family.toLowerCase().includes(q) : false);
  }, [searchQuery]);

  const filtered = useMemo(() => {
    const matchInstalled = installed.filter(m => matchesQuery(m.tag, m.label));
    const fittingCatalog = catalog.filter(m => m.fits && matchesQuery(m.tag, m.label, m.family));
    const tooLargeCatalog = catalog.filter(m => !m.fits && matchesQuery(m.tag, m.label, m.family));
    return { installed: matchInstalled, catalog: fittingCatalog, tooLarge: tooLargeCatalog };
  }, [installed, catalog, matchesQuery]);

  const flatList = useMemo<FlatItem[]>(() => [
    ...filtered.installed.map(m => ({ kind: 'installed' as const, data: m })),
    ...filtered.catalog.map(m => ({ kind: 'catalog' as const, data: m })),
    ...filtered.tooLarge.map(m => ({ kind: 'too_large' as const, data: m })),
  ], [filtered]);

  // Clamp listIdx when flatList shrinks
  useEffect(() => {
    if (flatList.length > 0 && listIdx >= flatList.length) {
      setListIdx(flatList.length - 1);
    }
  }, [flatList.length, listIdx]);

  // --- Pull model ---
  const startPull = useCallback(async (tag: string) => {
    setPulling(true);
    setPullTag(tag);
    setPullStatus(`Starting download of ${tag}...`);
    setPullPercent(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/models/${encodeURIComponent(tag)}/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        signal: controller.signal,
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
            if (progress.error) throw new Error(progress.error);
            setPullStatus(progress.status);
            if (progress.percent !== undefined) setPullPercent(progress.percent);
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Pull complete — select the model
      setPulling(false);
      abortRef.current = null;
      onSelect(tag, 'local');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPullStatus('Download cancelled');
      } else {
        setPullStatus(`Couldn't download: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      setPullPercent(null);
      // Keep pulling=true briefly so user sees the message, then reset
      setTimeout(() => {
        setPulling(false);
        setPullTag('');
        setPullStatus('');
      }, 2000);
      abortRef.current = null;
    }
  }, [port, sessionToken, onSelect]);

  // --- Format helpers ---
  const formatContext = (size?: number) => {
    if (!size) return '';
    if (size >= 1_000_000) return `${Math.round(size / 1_000_000)}M`;
    if (size >= 1_000) return `${Math.round(size / 1_000)}K`;
    return String(size);
  };

  const formatSize = (gb: number) => {
    if (gb < 1) return `${Math.round(gb * 1000)}MB`;
    return `${gb}GB`;
  };

  // --- Input handling ---
  useInput((input, key) => {
    if (!isActive) return;

    // --- Pull in progress ---
    if (pulling) {
      if (key.escape && abortRef.current) {
        abortRef.current.abort();
      }
      return;
    }

    // --- Source step ---
    if (step === 'source') {
      if (key.escape) { onClose(); return; }
      if (input === 'j' || key.downArrow) { setSourceIdx(i => Math.min(i + 1, 1)); return; }
      if (input === 'k' || key.upArrow) { setSourceIdx(i => Math.max(i - 1, 0)); return; }
      if (key.return) {
        const selected = sourceIdx === 0 ? 'cloud' : 'local';
        if (selected === 'cloud') {
          const hasKey = !!(anthropicApiKey || anthropicOAuthToken);
          if (!hasKey) {
            setStep('cloud_auth');
            setApiKeyError('');
            return;
          }
        }
        setSource(selected);
        setStep('list');
        setListIdx(0);
        setSearchQuery('');
        return;
      }
      return;
    }

    // --- Cloud auth step ---
    if (step === 'cloud_auth') {
      if (key.escape) {
        setStep('source');
        setSourceIdx(0);
        setApiKey('');
        setApiKeyError('');
        return;
      }
      if (apiKeyValidating) return;
      if (key.backspace || key.delete) {
        setApiKey(k => k.slice(0, -1));
        setApiKeyError('');
        return;
      }
      if (key.return) {
        if (!apiKey.trim()) return;
        setApiKeyValidating(true);
        setApiKeyError('');
        validateAnthropicApiKey(apiKey.trim()).then(valid => {
          setApiKeyValidating(false);
          if (valid) {
            onApiKeySet?.(apiKey.trim());
            setSource('cloud');
            setStep('list');
            setListIdx(0);
            setApiKey('');
          } else {
            setApiKeyError('Invalid API key. Check and try again.');
          }
        });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setApiKey(k => k + input);
        setApiKeyError('');
      }
      return;
    }

    // --- List step (cloud) ---
    if (step === 'list' && source === 'cloud') {
      const cloudList = CLOUD_MODELS;
      if (key.escape) { setStep('source'); setSourceIdx(0); return; }
      if (input === 'j' || key.downArrow) { setListIdx(i => Math.min(i + 1, cloudList.length - 1)); return; }
      if (input === 'k' || key.upArrow) { setListIdx(i => Math.max(i - 1, 0)); return; }
      if (key.return) {
        const selected = cloudList[listIdx];
        if (selected) onSelect(selected.id, 'cloud');
        return;
      }
      return;
    }

    // --- List step (local) ---
    if (step === 'list' && source === 'local') {
      if (key.escape) {
        if (searchQuery) {
          setSearchQuery('');
          setListIdx(0);
          setScrollOffset(0);
          return;
        }
        setStep('source');
        setSourceIdx(1);
        return;
      }
      if (input === 'j' || key.downArrow) {
        setListIdx(i => {
          const next = Math.min(i + 1, flatList.length - 1);
          // Adjust scroll
          if (next >= scrollOffset + MAX_VISIBLE) {
            setScrollOffset(next - MAX_VISIBLE + 1);
          }
          return next;
        });
        return;
      }
      if (input === 'k' || key.upArrow) {
        setListIdx(i => {
          const next = Math.max(i - 1, 0);
          if (next < scrollOffset) {
            setScrollOffset(next);
          }
          return next;
        });
        return;
      }
      if (key.return && flatList.length > 0) {
        const item = flatList[listIdx];
        if (!item) return;
        if (item.kind === 'installed') {
          onSelect(item.data.tag, 'local');
        } else if (item.kind === 'too_large') {
          showMessage(`This model needs ${item.data.minRAM}GB RAM. Your device has ${deviceRAM}GB.`);
        } else {
          startPull(item.data.tag);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery(q => q.slice(0, -1));
        setListIdx(0);
        setScrollOffset(0);
        return;
      }
      // Typing to search
      if (input && !key.ctrl && !key.meta && !key.escape) {
        setSearchQuery(q => q + input);
        setListIdx(0);
        setScrollOffset(0);
        return;
      }
    }
  }, { isActive });

  // ==========================================================================
  // RENDER
  // ==========================================================================

  // --- Pull progress view ---
  if (pulling) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text bold>Switch Model  <Text color="cyan">{'\u2299'} Local</Text></Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">Downloading {pullTag}...</Text>
          <Text color="gray">{pullStatus}</Text>
          {pullPercent !== null && (
            <Box marginTop={1}>
              <Text color="green">
                {'\u2588'.repeat(Math.floor(pullPercent / 4))}
                {'\u2591'.repeat(25 - Math.floor(pullPercent / 4))}
              </Text>
              <Text color="gray"> {pullPercent}%</Text>
            </Box>
          )}
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // --- Source step ---
  if (step === 'source') {
    const hasCloudKey = !!(anthropicApiKey || anthropicOAuthToken);
    const cloudCount = hasCloudKey ? CLOUD_MODELS.length : 0;
    const localCount = installed.length || '...';
    const sources = [
      { key: 'cloud' as const, icon: '\u2601', label: 'Cloud', count: cloudCount === 0 ? 'set up' : String(cloudCount), color: 'magenta' as const },
      { key: 'local' as const, icon: '\u2299', label: 'Local', count: String(localCount), color: 'cyan' as const },
    ];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text bold>Switch Model</Text>
        <Text color="gray" dimColor>Current: {currentModel}</Text>
        <Box marginTop={1} flexDirection="column">
          {sources.map((s, i) => {
            const isSelected = i === sourceIdx;
            return (
              <Text key={s.key}>
                <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '\u276F ' : '  '}</Text>
                <Text color={isSelected ? 'cyan' : s.color}>
                  {s.icon} {s.label} ({s.count})
                </Text>
              </Text>
            );
          })}
        </Box>
        <Text color="gray" dimColor>j/k to navigate {'\u00B7'} Enter to select {'\u00B7'} Esc to cancel</Text>
      </Box>
    );
  }

  // --- Cloud auth step ---
  if (step === 'cloud_auth') {
    const masked = apiKey.length <= 8
      ? '\u2022'.repeat(apiKey.length)
      : apiKey.slice(0, 7) + '\u2022'.repeat(Math.min(apiKey.length - 7, 20));
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text bold>Switch Model  <Text color="magenta">{'\u2601'} Cloud</Text></Text>
        <Text bold>Connect to Claude</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Paste your Anthropic API key:</Text>
          <Box marginTop={1}>
            <Text color="cyan">API key: </Text>
            <Text>{masked}</Text>
            <Text color="cyan">{'\u2588'}</Text>
          </Box>
        </Box>
        {apiKeyValidating && (
          <Box marginTop={1}>
            <Text color="yellow">Validating key...</Text>
          </Box>
        )}
        {apiKeyError !== '' && (
          <Box marginTop={1}>
            <Text color="red">{apiKeyError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color="gray" dimColor>Enter to confirm {'\u00B7'} Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  // --- Cloud model list ---
  if (step === 'list' && source === 'cloud') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text bold>Switch Model  <Text color="magenta">{'\u2601'} Cloud</Text></Text>
        <Text color="gray" dimColor>Current: {currentModel}</Text>
        <Box marginTop={1} flexDirection="column">
          {CLOUD_MODELS.map((m, i) => {
            const isSelected = i === listIdx;
            const isActive = m.id === cloudModel && modelSource === 'cloud';
            let label = m.label;
            if (isActive) label += ' (active)';
            return (
              <Text key={m.id}>
                <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '\u276F ' : '  '}</Text>
                <Text color={isSelected ? 'cyan' : isActive ? 'green' : 'magenta'}>
                  {'\u2601'} {label}
                </Text>
              </Text>
            );
          })}
        </Box>
        <Text color="gray" dimColor>j/k to navigate {'\u00B7'} Enter to select {'\u00B7'} Esc to go back</Text>
      </Box>
    );
  }

  // --- Local model list with search ---
  const visibleItems = flatList.slice(scrollOffset, scrollOffset + MAX_VISIBLE);
  const hasMore = flatList.length > scrollOffset + MAX_VISIBLE;
  const hasAbove = scrollOffset > 0;

  // Section boundary indices in flat list
  const installedCount = filtered.installed.length;
  const catalogCount = filtered.catalog.length;
  const tooLargeStart = installedCount + catalogCount;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>Switch Model  <Text color="cyan">{'\u2299'} Local</Text></Text>
      <Text color="gray" dimColor>Current: {currentModel}</Text>
      {deviceRAM > 0 && (
        <Text color="gray" dimColor>Device: {deviceRAM}GB RAM ({memoryTier} tier)</Text>
      )}

      {/* Search input */}
      <Box marginTop={1}>
        <Text color="cyan">Search: </Text>
        <Text>{searchQuery}</Text>
        <Text color="cyan">{'\u2588'}</Text>
      </Box>

      {loading ? (
        <Box marginTop={1}>
          <Text color="gray">Loading models...</Text>
        </Box>
      ) : error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : flatList.length === 0 ? (
        <Box marginTop={1}>
          <Text color="gray">{searchQuery ? 'No models match your search' : 'No models available'}</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {/* Section headers + items */}
          {hasAbove && <Text color="gray" dimColor>  {'\u2191'} {scrollOffset} more above</Text>}

          {visibleItems.map((item, vi) => {
            const globalIdx = vi + scrollOffset;
            const isSelected = globalIdx === listIdx;

            // Show section headers at boundaries
            let header: React.ReactNode = null;
            if (globalIdx === 0 && filtered.installed.length > 0) {
              header = <Text bold color="gray">INSTALLED</Text>;
            }
            if (globalIdx === installedCount && filtered.catalog.length > 0) {
              header = <Text bold color="gray">AVAILABLE</Text>;
            }
            if (globalIdx === tooLargeStart && filtered.tooLarge.length > 0) {
              header = <Text bold color="red" dimColor>TOO LARGE</Text>;
            }

            if (item.kind === 'installed') {
              const m = item.data;
              const statusBadge = m.status === 'loaded' ? 'loaded' : m.status;
              const activeLabel = m.isActive ? ' (active)' : '';
              // Warn if model is a tight fit (uses > 60% of device RAM)
              const isTightFit = deviceRAM > 0 && m.sizeGB != null && m.sizeGB > deviceRAM * 0.6;
              const prefix = isSelected ? '\u276F ' : '  ';
              return (
                <React.Fragment key={`i-${m.tag}`}>
                  {header}
                  <Text>
                    <Text color={isSelected ? 'cyan' : 'white'}>{prefix}</Text>
                    <Text color={isSelected ? 'cyan' : m.isActive ? 'green' : 'white'}>
                      {'\u2299'} {m.tag}{activeLabel}
                    </Text>
                    <Text color="gray">  {statusBadge}</Text>
                    {isTightFit && (
                      <Text color="yellow">  {'\u26A0'} {m.sizeGB}GB (tight fit)</Text>
                    )}
                  </Text>
                </React.Fragment>
              );
            }

            if (item.kind === 'too_large') {
              const m = item.data;
              const prefix = isSelected ? '\u276F ' : '  ';
              return (
                <React.Fragment key={`t-${m.tag}`}>
                  {header}
                  <Text dimColor>
                    <Text color={isSelected ? 'red' : 'gray'}>{prefix}</Text>
                    <Text color={isSelected ? 'red' : 'gray'}>
                      {'\u2717'} {m.tag}
                    </Text>
                    <Text color="gray">  {formatSize(m.sizeGB)} / {deviceRAM}GB</Text>
                    <Text color="gray">  (needs {m.minRAM}GB)</Text>
                  </Text>
                </React.Fragment>
              );
            }

            // Catalog item (fits)
            const m = item.data;
            const badges: string[] = [];
            if (m.toolCalling) badges.push('[tools]');
            if (m.vision) badges.push('[vision]');
            const ctx = formatContext(m.contextSize);
            if (ctx) badges.push(ctx);
            const sizeLabel = deviceRAM > 0
              ? `${formatSize(m.sizeGB)} / ${deviceRAM}GB`
              : formatSize(m.sizeGB);
            const prefix = isSelected ? '\u276F ' : '  ';
            return (
              <React.Fragment key={`c-${m.tag}`}>
                {header}
                <Text>
                  <Text color={isSelected ? 'cyan' : 'white'}>{prefix}</Text>
                  <Text color={isSelected ? 'cyan' : 'yellow'}>
                    {'\u2193'} {m.tag}
                  </Text>
                  <Text color="gray">  {sizeLabel}</Text>
                  {badges.length > 0 && <Text color="gray">  {badges.join(' ')}</Text>}
                </Text>
              </React.Fragment>
            );
          })}

          {hasMore && <Text color="gray" dimColor>  {'\u2193'} {flatList.length - scrollOffset - MAX_VISIBLE} more below</Text>}
        </Box>
      )}

      {message && (
        <Box marginTop={1}>
          <Text color="yellow">{message}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          j/k navigate {'\u00B7'} Enter select/install {'\u00B7'} type to search {'\u00B7'} Esc back
        </Text>
      </Box>
    </Box>
  );
}
