import { useState, useEffect, useMemo } from 'react';
import {
  Cube,
  Magnet,
  PencilLine,
  Headset,
  GearSix,
  ChartBar,
  Handshake,
  MagnifyingGlass,
  CheckCircle,
  Lightning,
  Robot,
  ArrowRight,
  X,
  SpinnerGap,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { api } from '../api/client';
import { toast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';

// ============================================================================
// TYPES
// ============================================================================

interface TemplateBundle {
  id: string;
  slug: string;
  name: string;
  description: string;
  long_description: string | null;
  icon: string;
  category: string;
  business_types: string[];
  tags: string[];
  difficulty: string;
  agents: Array<{ ref_id: string; name: string; role: string }>;
  automations: Array<{ ref_id: string; name: string; trigger_type: string }>;
  variables: Array<{
    key: string;
    label: string;
    description: string;
    type: string;
    required: boolean;
    default_value?: string;
    placeholder?: string;
    options?: Array<{ label: string; value: string }>;
  }>;
  featured: boolean;
  install_count: number;
  installed?: boolean;
}

const CATEGORY_META: Record<string, { label: string; Icon: PhosphorIcon }> = {
  lead_gen: { label: 'Lead Gen', Icon: Magnet },
  content: { label: 'Content', Icon: PencilLine },
  support: { label: 'Support', Icon: Headset },
  operations: { label: 'Ops', Icon: GearSix },
  analytics: { label: 'Analytics', Icon: ChartBar },
  sales: { label: 'Sales', Icon: Handshake },
};

const DIFFICULTY_COLORS: Record<string, string> = {
  beginner: 'bg-green-500/20 text-green-400',
  intermediate: 'bg-yellow-500/20 text-yellow-400',
  advanced: 'bg-red-500/20 text-red-400',
};

// ============================================================================
// MAIN PAGE
// ============================================================================

export function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<TemplateBundle | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installValues, setInstallValues] = useState<Record<string, string>>({});

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const res = await api<{ templates: TemplateBundle[] }>('/api/templates');
      setTemplates(res.templates || []);
    } catch {
      toast('error', 'Couldn\'t load templates');
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => {
    let list = templates;
    if (category) list = list.filter((t) => t.category === category);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      );
    }
    return list;
  }, [templates, category, search]);

  const openInstall = (template: TemplateBundle) => {
    setSelected(template);
    const defaults: Record<string, string> = {};
    template.variables.forEach((v) => {
      defaults[v.key] = v.default_value || '';
    });
    setInstallValues(defaults);
  };

  const handleInstall = async () => {
    if (!selected) return;
    setInstalling(true);
    try {
      await api(`/api/templates/${selected.slug}/install`, {
        method: 'POST',
        body: JSON.stringify({ variableValues: installValues }),
      });
      toast('success', `Installed "${selected.name}"`);
      setSelected(null);
      loadTemplates();
    } catch {
      toast('error', 'Couldn\'t install template. Try again?');
    } finally {
      setInstalling(false);
    }
  };

  const categories = ['all', ...Object.keys(CATEGORY_META)];

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader
        title="Templates"
        subtitle="Pre-built agent and automation bundles you can install in one click."
      />

      {/* Category filter + search */}
      <div className="flex items-center gap-3 mt-4 mb-6 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat === 'all' ? null : cat)}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${
                (cat === 'all' && !category) || cat === category
                  ? 'bg-white/10 text-white border border-white/20'
                  : 'bg-white/[0.03] text-neutral-500 border border-white/[0.06] hover:text-neutral-300'
              }`}
            >
              {cat === 'all' ? 'All' : CATEGORY_META[cat]?.label || cat}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <MagnifyingGlass
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      </div>

      {/* Template grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Cube size={40} weight="thin" />}
          title="No templates found"
          description={search || category ? 'Try a different filter.' : 'Templates will appear here.'}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((t) => {
            const catMeta = CATEGORY_META[t.category];
            const CatIcon = catMeta?.Icon || Cube;
            return (
              <button
                key={t.id}
                onClick={() => (t.installed ? null : openInstall(t))}
                className="text-left border border-white/[0.06] rounded-lg bg-white/[0.02] hover:bg-white/[0.04] p-4 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <CatIcon size={20} weight="bold" className="text-neutral-400" />
                  <span className="text-sm font-medium text-white truncate">{t.name}</span>
                  {t.installed && (
                    <CheckCircle size={16} weight="fill" className="text-green-400 ml-auto flex-shrink-0" />
                  )}
                </div>
                <p className="text-xs text-neutral-400 line-clamp-2 mb-3">{t.description}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] text-neutral-400">
                    {catMeta?.label || t.category}
                  </span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${DIFFICULTY_COLORS[t.difficulty] || 'bg-white/[0.06] text-neutral-400'}`}>
                    {t.difficulty}
                  </span>
                  <span className="text-[10px] text-neutral-500 flex items-center gap-0.5">
                    <Robot size={10} /> {t.agents.length}
                  </span>
                  <span className="text-[10px] text-neutral-500 flex items-center gap-0.5">
                    <Lightning size={10} /> {t.automations.length}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Install modal */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => !installing && setSelected(null)}
        >
          <div
            className="bg-[#111] border border-white/10 rounded-xl p-6 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Install {selected.name}</h2>
              <button
                onClick={() => setSelected(null)}
                className="text-neutral-500 hover:text-white"
                disabled={installing}
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-neutral-400 mb-4">
              This will create {selected.agents.length === 1 ? '1 agent' : `${selected.agents.length} agents`} and{' '}
              {selected.automations.length === 1 ? '1 automation' : `${selected.automations.length} automations`}.
            </p>

            {selected.variables.length > 0 && (
              <div className="space-y-3 mb-4">
                {selected.variables.map((v) => (
                  <div key={v.key}>
                    <label className="block text-xs text-neutral-400 mb-1">
                      {v.label}
                      {v.required && <span className="text-red-400 ml-0.5">*</span>}
                    </label>
                    {v.type === 'select' && v.options ? (
                      <select
                        value={installValues[v.key] || ''}
                        onChange={(e) =>
                          setInstallValues((prev) => ({ ...prev, [v.key]: e.target.value }))
                        }
                        className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-white/20"
                      >
                        <option value="">Select...</option>
                        {v.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={v.type === 'email' ? 'email' : v.type === 'url' ? 'url' : 'text'}
                        value={installValues[v.key] || ''}
                        onChange={(e) =>
                          setInstallValues((prev) => ({ ...prev, [v.key]: e.target.value }))
                        }
                        placeholder={v.placeholder || ''}
                        className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
                      />
                    )}
                    {v.description && (
                      <p className="text-[10px] text-neutral-500 mt-0.5">{v.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={handleInstall}
              disabled={installing}
              className="w-full py-2.5 bg-white text-black text-sm font-medium rounded-lg hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {installing ? (
                <>
                  <SpinnerGap size={14} className="animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  Install Template
                  <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
