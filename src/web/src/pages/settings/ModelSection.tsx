import { useState, useEffect, useCallback } from 'react';
import { CircleNotch, PencilSimple, Check, X, Warning, Lightning } from '@phosphor-icons/react';
import { useApi } from '../../hooks/useApi';
import { api } from '../../api/client';
import { toast } from '../../components/Toast';
import { useModels } from '../../hooks/useModels';
import { useInferenceStatus } from '../../hooks/useInferenceStatus';
import { useWsListener } from '../../hooks/useWebSocket';
import { InstalledModelsList } from './models/InstalledModelsList';
import { InferenceStatusBar } from './models/InferenceStatusBar';
import { ModelCatalog } from './models/ModelCatalog';
import { DeleteModelModal } from './models/DeleteModelModal';

export function ModelSection() {
  const { data: apiKeyData, refetch: refetchApiKey } = useApi<{ key: string; value: string } | null>('/api/settings/anthropic_api_key');

  const [editingApiKey, setEditingApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savingApiKey, setSavingApiKey] = useState(false);

  // Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<{ tag: string; label: string; isActive: boolean; isOrchestrator: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [editingOpenRouterKey, setEditingOpenRouterKey] = useState(false);
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState('');
  const [savingOpenRouterKey, setSavingOpenRouterKey] = useState(false);

  const {
    installed,
    catalog,
    device,
    memoryTier,
    ollamaRunning,
    loading,
    catalogLoading,
    catalogLoaded,
    downloading,
    openRouterKey,
    openRouterModel,
    openRouterConnected,
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
  } = useModels();

  const { status: inferenceStatus } = useInferenceStatus();

  // Track model switch progress inline (in addition to toasts)
  const [switchState, setSwitchState] = useState<{
    model: string; status: 'switching' | 'complete' | 'failed';
    provider?: string; reason?: string;
  } | null>(null);

  useWsListener(useCallback((event: string, data: unknown) => {
    const d = data as Record<string, string>;
    if (event === 'model:switch-started') {
      setSwitchState({ model: d.model, status: 'switching' });
    } else if (event === 'model:switch-complete') {
      setSwitchState({ model: d.model, status: 'complete', provider: d.provider });
      fetchInstalled();
      setTimeout(() => setSwitchState(null), 3000);
    } else if (event === 'model:switch-failed') {
      setSwitchState({ model: d.model, status: 'failed', reason: d.reason });
      setTimeout(() => setSwitchState(null), 5000);
    }
  }, [fetchInstalled]));

  useEffect(() => {
    fetchInstalled();
    fetchOpenRouter();
  }, [fetchInstalled, fetchOpenRouter]);

  const maskedKey = (val: string | undefined | null, showLen = 8) => {
    if (!val) return 'Not set';
    return val.slice(0, showLen) + '\u2022'.repeat(Math.max(0, Math.min(val.length - showLen, 20)));
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    setSavingApiKey(true);
    try {
      await api('/api/settings/anthropic_api_key', {
        method: 'PUT',
        body: JSON.stringify({ value: apiKeyInput.trim() }),
      });
      toast('success', 'API key updated');
      setEditingApiKey(false);
      setApiKeyInput('');
      refetchApiKey();
    } catch {
      toast('error', 'Couldn\'t save API key');
    } finally {
      setSavingApiKey(false);
    }
  };

  const handleSaveOpenRouterKey = async () => {
    setSavingOpenRouterKey(true);
    try {
      await saveOpenRouterKey(openRouterKeyInput.trim());
      setEditingOpenRouterKey(false);
      setOpenRouterKeyInput('');
    } catch {
      toast('error', 'Couldn\'t save OpenRouter key');
    } finally {
      setSavingOpenRouterKey(false);
    }
  };

  const handleDeleteClick = (tag: string) => {
    const model = installed.find(m => m.tag === tag);
    setDeleteTarget({
      tag,
      label: model?.label || tag,
      isActive: model?.isActive || false,
      isOrchestrator: model?.isOrchestrator || false,
    });
  };

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const ok = await deleteModel(deleteTarget.tag);
    setDeleting(false);
    if (ok) setDeleteTarget(null);
  }, [deleteTarget, deleting, deleteModel]);

  return (
    <>
      {/* Anthropic API Key */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Anthropic API</h2>
        <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {editingApiKey ? (
            <div className="px-4 py-3">
              <label className="text-xs text-neutral-400 block mb-1">API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  placeholder="sk-ant-..."
                  className="flex-1 bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-white/20"
                  autoFocus
                />
                <button
                  onClick={handleSaveApiKey}
                  disabled={savingApiKey || !apiKeyInput.trim()}
                  className="text-success hover:text-success/80 transition-colors disabled:opacity-50"
                >
                  <Check size={16} />
                </button>
                <button
                  onClick={() => { setEditingApiKey(false); setApiKeyInput(''); }}
                  className="text-neutral-400 hover:text-white transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <span className="text-sm text-neutral-400">API Key</span>
                <span className="text-sm font-medium ml-3">{maskedKey(apiKeyData?.value, 12)}</span>
              </div>
              <button
                onClick={() => setEditingApiKey(true)}
                className="text-neutral-400 hover:text-white transition-colors"
              >
                <PencilSimple size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* OpenRouter */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">
          <span className="flex items-center gap-1.5">
            OpenRouter
            {openRouterConnected && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-success" />
            )}
          </span>
        </h2>
        <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {/* API Key */}
          {editingOpenRouterKey ? (
            <div className="px-4 py-3">
              <label className="text-xs text-neutral-400 block mb-1">API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={openRouterKeyInput}
                  onChange={e => setOpenRouterKeyInput(e.target.value)}
                  placeholder="sk-or-..."
                  className="flex-1 bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-white/20"
                  autoFocus
                />
                <button
                  onClick={handleSaveOpenRouterKey}
                  disabled={savingOpenRouterKey}
                  className="text-success hover:text-success/80 transition-colors disabled:opacity-50"
                >
                  <Check size={16} />
                </button>
                <button
                  onClick={() => { setEditingOpenRouterKey(false); setOpenRouterKeyInput(''); }}
                  className="text-neutral-400 hover:text-white transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="text-[10px] text-neutral-500 mt-1.5">
                Free frontier models. Leave empty to remove.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <span className="text-sm text-neutral-400">API Key</span>
                <span className="text-sm font-medium ml-3">{maskedKey(openRouterKey, 8)}</span>
              </div>
              <button
                onClick={() => setEditingOpenRouterKey(true)}
                className="text-neutral-400 hover:text-white transition-colors"
              >
                <PencilSimple size={14} />
              </button>
            </div>
          )}

          {/* Model Selector */}
          {openRouterConnected && (
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <Lightning size={14} className="text-amber-400" />
                <span className="text-sm text-neutral-400">Model</span>
              </div>
              <select
                value={openRouterModel || 'openrouter/optimus-alpha'}
                onChange={e => setOpenRouterModel(e.target.value)}
                className="bg-white/[0.06] border border-white/[0.08] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-white/20 cursor-pointer"
              >
                <option value="openrouter/optimus-alpha">Hunter Alpha (reasoning, 1M ctx)</option>
                <option value="openrouter/optimus-alpha">Healer Alpha (multimodal, 262K ctx)</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Local Models */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">
          Local Models
        </h2>

        {/* Inference status bar: active provider, VRAM, switch progress */}
        {inferenceStatus && (
          <InferenceStatusBar
            activeProvider={inferenceStatus.activeProvider}
            mlxModel={inferenceStatus.mlx?.model}
            switchInProgress={inferenceStatus.switchInProgress}
            switchState={switchState}
            capacity={inferenceStatus.capacity}
          />
        )}

        {/* Ollama not running warning */}
        {!loading && !ollamaRunning && (
          <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Warning size={16} className="text-warning shrink-0" />
              <p className="text-xs text-warning">Ollama is not running</p>
            </div>
            <button
              onClick={startOllama}
              disabled={!!downloading}
              className="px-2.5 py-1 text-[11px] font-medium bg-warning/10 border border-warning/30 text-warning rounded hover:bg-warning/20 disabled:opacity-50 transition-colors"
            >
              {downloading?.tag === '' ? 'Starting...' : 'Start Ollama'}
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-sm text-neutral-400">
            <CircleNotch size={16} className="animate-spin" /> Loading models...
          </div>
        ) : (
          <>
            {/* Installed models list */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs text-neutral-400">
                  Installed Models
                  {installed.length > 0 && (
                    <span className="ml-1.5 text-neutral-600">({installed.length})</span>
                  )}
                </h3>
              </div>
              <InstalledModelsList
                models={installed}
                downloading={downloading}
                onSetActive={setActiveModel}
                onSetOrchestrator={setOrchestratorModel}
                onUnload={unloadModel}
                onDelete={handleDeleteClick}
                onCancelDownload={cancelDownload}
              />
            </div>

            {/* Catalog browser */}
            <ModelCatalog
              catalog={catalog}
              device={device}
              memoryTier={memoryTier}
              loading={catalogLoading}
              loaded={catalogLoaded}
              downloading={downloading}
              onInstall={installModel}
              onCancelDownload={cancelDownload}
              onFetchCatalog={fetchCatalog}
            />
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      <DeleteModelModal
        open={!!deleteTarget}
        modelTag={deleteTarget?.tag || ''}
        modelLabel={deleteTarget?.label || ''}
        isActive={deleteTarget?.isActive || false}
        isOrchestrator={deleteTarget?.isOrchestrator || false}
        loading={deleting}
        onConfirm={handleDeleteConfirm}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
      />
    </>
  );
}
