import { useState } from 'react';
import { CircleNotch, Download, CaretDown, CaretUp } from '@phosphor-icons/react';
import type { CatalogModel, DeviceInfo } from './model-types';

type Filter = 'all' | 'fits' | 'vision' | 'tools';

interface Props {
  catalog: CatalogModel[];
  device: DeviceInfo | null;
  memoryTier: string;
  loading: boolean;
  loaded: boolean;
  downloading: { tag: string; percent: number; message: string } | null;
  onInstall: (tag: string) => void;
  onCancelDownload: () => void;
  onFetchCatalog: () => void;
}

const FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'fits', label: 'Fits your device' },
  { value: 'vision', label: 'Vision' },
  { value: 'tools', label: 'Tool calling' },
];

function tierLabel(tier: string): string {
  const labels: Record<string, string> = {
    tiny: 'Tiny (< 4 GB)',
    small: 'Small (4-8 GB)',
    medium: 'Medium (8-16 GB)',
    large: 'Large (16-32 GB)',
    xlarge: 'XLarge (32 GB+)',
  };
  return labels[tier] || tier;
}

export function ModelCatalog({
  catalog,
  device,
  memoryTier,
  loading,
  loaded,
  downloading,
  onInstall,
  onCancelDownload,
  onFetchCatalog,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const handleToggle = () => {
    if (!expanded && !loaded) {
      onFetchCatalog();
    }
    setExpanded(e => !e);
  };

  const filtered = catalog.filter(m => {
    if (filter === 'fits') return m.fits;
    if (filter === 'vision') return m.vision;
    if (filter === 'tools') return m.toolCalling;
    return true;
  });

  // Group by tier
  const tiers = ['tiny', 'small', 'medium', 'large', 'xlarge'];
  const grouped = tiers
    .map(tier => ({
      tier,
      models: filtered.filter(m => m.tier === tier),
    }))
    .filter(g => g.models.length > 0);

  return (
    <div>
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 text-sm font-medium text-neutral-400 uppercase tracking-wider hover:text-white transition-colors mb-3"
      >
        Browse Models
        {expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
      </button>

      {expanded && (
        <>
          {/* Device info */}
          {device && (
            <div className="bg-white/5 rounded-lg p-3 mb-4 text-xs text-neutral-400">
              <span>{device.cpuModel}</span>
              <span className="mx-1.5">&middot;</span>
              <span>{device.totalMemoryGB} GB RAM</span>
              <span className="mx-1.5">&middot;</span>
              <span>{memoryTier} tier</span>
            </div>
          )}

          {/* Filters */}
          <div className="flex gap-1.5 mb-4 flex-wrap">
            {FILTER_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors ${
                  filter === opt.value
                    ? 'border-white/20 bg-white/10 text-white'
                    : 'border-white/[0.08] text-neutral-400 hover:border-white/20'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8 gap-2 text-sm text-neutral-400">
              <CircleNotch size={16} className="animate-spin" /> Loading catalog...
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.map(group => (
                <div key={group.tier}>
                  <h4 className="text-[11px] font-medium text-neutral-400/70 uppercase tracking-wider mb-2">
                    {tierLabel(group.tier)}
                  </h4>
                  <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
                    {group.models.map(model => {
                      const isDownloading = downloading?.tag === model.tag;
                      const canInstall = !downloading && !model.installed;

                      return (
                        <div
                          key={model.tag}
                          className={`px-4 py-3 ${!model.fits ? 'opacity-50' : ''}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium">{model.label}</span>
                                <span className="text-[10px] px-1.5 py-0.5 bg-white/[0.06] rounded text-neutral-400 font-mono">
                                  {model.family}
                                </span>
                                {model.recommended && (
                                  <span className="text-[10px] px-1.5 py-0.5 bg-success/20 text-success rounded font-medium">
                                    Recommended
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-neutral-400 mt-0.5">{model.description}</p>
                              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                {model.vision && (
                                  <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">Vision</span>
                                )}
                                {model.toolCalling && (
                                  <span className="text-[10px] px-1.5 py-0.5 bg-white/10 text-neutral-300 rounded">Tools</span>
                                )}
                                <span className="text-[10px] text-neutral-400">{model.sizeGB} GB</span>
                                {!model.fits && (
                                  <span className="text-[10px] text-warning">Needs {model.minRAM} GB RAM</span>
                                )}
                              </div>
                            </div>

                            <div className="shrink-0">
                              {model.installed ? (
                                <span className="text-[11px] text-success px-2 py-1">Installed</span>
                              ) : isDownloading ? (
                                <div className="flex items-center gap-2">
                                  <CircleNotch size={14} className="animate-spin text-white" />
                                  <span className="text-xs text-neutral-400">{downloading.percent}%</span>
                                  <button
                                    onClick={onCancelDownload}
                                    className="text-[11px] text-neutral-400 hover:text-critical transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => onInstall(model.tag)}
                                  disabled={!canInstall || !model.fits}
                                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-white text-black rounded hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                  <Download size={12} /> Install
                                </button>
                              )}
                            </div>
                          </div>

                          {isDownloading && (
                            <div className="mt-2">
                              <div className="w-full bg-white/[0.06] rounded-full h-1.5">
                                <div
                                  className="bg-white h-1.5 rounded-full transition-all duration-300"
                                  style={{ width: `${downloading.percent}%` }}
                                />
                              </div>
                              <p className="text-[10px] text-neutral-400 mt-1">{downloading.message}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {filtered.length === 0 && (
                <p className="text-sm text-neutral-400 text-center py-4">No models match this filter</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
