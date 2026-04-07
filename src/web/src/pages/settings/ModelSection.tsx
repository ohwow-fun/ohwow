import { useState, useEffect, useCallback, useMemo } from 'react';
import { CircleNotch, PencilSimple, Check, X, Warning, Lightning, MagnifyingGlass } from '@phosphor-icons/react';
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

  // OpenRouter live model list
  interface ORModel {
    id: string; name: string; contextLength: number;
    pricing: { prompt: number; completion: number };
    supportsTools: boolean; supportsVision: boolean; isFree: boolean;
  }
  const [orModelSearch, setOrModelSearch] = useState('');
  const [orModels, setOrModels] = useState<ORModel[]>([]);
  const [orModelsLoading, setOrModelsLoading] = useState(false);

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
    cloudProvider,
    fetchCloudProvider,
    setCloudProvider,
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
    fetchCloudProvider();
  }, [fetchInstalled, fetchOpenRouter, fetchCloudProvider]);

  // Fetch OpenRouter models when connected
  useEffect(() => {
    if (!openRouterConnected) return;
    setOrModelsLoading(true);
    api<{ data: { models: ORModel[] } }>('/api/models/openrouter')
      .then(res => { setOrModels(res.data.models); setOrModelsLoading(false); })
      .catch(() => setOrModelsLoading(false));
  }, [openRouterConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredOrModels = useMemo(() => {
    const q = orModelSearch.toLowerCase().trim();
    if (!q) return orModels;
    return orModels.filter(m =>
      m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [orModels, orModelSearch]);

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
      {/* Cloud Provider Toggle */}
      <div className="mb-6">
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Cloud Provider</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setCloudProvider('anthropic')}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
              cloudProvider === 'anthropic'
                ? 'bg-white/10 border-white/20 text-white'
                : 'bg-white/[0.03] border-white/[0.06] text-neutral-400 hover:bg-white/[0.06]'
            }`}
          >
            Anthropic
          </button>
          <button
            onClick={() => setCloudProvider('openrouter')}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
              cloudProvider === 'openrouter'
                ? 'bg-white/10 border-white/20 text-white'
                : 'bg-white/[0.03] border-white/[0.06] text-neutral-400 hover:bg-white/[0.06]'
            }`}
          >
            OpenRouter
          </button>
        </div>
        <p className="text-[10px] text-neutral-500 mt-1.5">
          Which provider to use when running in cloud mode
        </p>
      </div>

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
                300+ models from every AI lab. Leave empty to remove.
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
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Lightning size={14} className="text-amber-400" />
                <span className="text-sm text-neutral-400">Model</span>
                {openRouterModel && (
                  <span className="text-xs text-white/60 ml-auto">{openRouterModel}</span>
                )}
              </div>
              {/* Search */}
              <div className="relative mb-2">
                <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  type="text"
                  value={orModelSearch}
                  onChange={e => setOrModelSearch(e.target.value)}
                  placeholder="Search 300+ models..."
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
                />
              </div>
              {/* Model list */}
              {orModelsLoading ? (
                <div className="flex items-center gap-1.5 py-2 text-xs text-neutral-400">
                  <CircleNotch size={12} className="animate-spin" /> Loading models...
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-px">
                  {filteredOrModels.slice(0, 50).map(m => {
                    const isActive = m.id === openRouterModel;
                    const ctx = m.contextLength >= 1_000_000 ? `${Math.round(m.contextLength / 1_000_000)}M`
                      : m.contextLength >= 1_000 ? `${Math.round(m.contextLength / 1_000)}K`
                      : String(m.contextLength);
                    return (
                      <button
                        key={m.id}
                        onClick={() => setOpenRouterModel(m.id)}
                        className={`w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors ${
                          isActive ? 'bg-white/10 text-white' : 'text-neutral-300 hover:bg-white/[0.06]'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="truncate font-medium">{m.name}</span>
                          <span className="flex items-center gap-1.5 text-neutral-500 shrink-0 ml-2">
                            {m.isFree && <span className="text-green-400">free</span>}
                            {m.supportsTools && <span>tools</span>}
                            {m.supportsVision && <span>vision</span>}
                            <span>{ctx}</span>
                          </span>
                        </div>
                        <div className="text-[10px] text-neutral-500 truncate">{m.id}</div>
                      </button>
                    );
                  })}
                  {filteredOrModels.length > 50 && (
                    <p className="text-[10px] text-neutral-500 px-2.5 py-1">
                      {filteredOrModels.length - 50} more. Refine your search.
                    </p>
                  )}
                  {filteredOrModels.length === 0 && (
                    <p className="text-xs text-neutral-500 px-2.5 py-2">
                      {orModelSearch ? 'No models match your search' : 'No models available'}
                    </p>
                  )}
                </div>
              )}
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
