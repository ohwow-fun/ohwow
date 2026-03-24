import { Plus, Trash } from '@phosphor-icons/react';
import type { AutomationAction } from '../../types';
import { buildFieldGroups } from '../utils/field-utils';
import { FieldPicker } from './FieldPicker';

interface TransformMapping {
  target: string;
  source: string;
  transform?: string;
}

const TRANSFORMS = [
  { value: '', label: 'None' },
  { value: 'uppercase', label: 'Uppercase' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'trim', label: 'Trim' },
  { value: 'to_number', label: 'To Number' },
  { value: 'to_string', label: 'To String' },
  { value: 'json_parse', label: 'JSON Parse' },
];

export function TransformDataConfig({
  config,
  onChange,
  previousSteps,
  sampleFields,
  samplePayload,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  previousSteps: AutomationAction[];
  sampleFields: string[];
  samplePayload?: Record<string, unknown> | null;
}) {
  const mappings = (config.mappings || []) as TransformMapping[];

  const handleUpdate = (index: number, field: keyof TransformMapping, value: string) => {
    const updated = mappings.map((m, i) =>
      i === index ? { ...m, [field]: value || undefined } : m
    );
    onChange({ ...config, mappings: updated });
  };

  const handleAdd = () => {
    onChange({ ...config, mappings: [...mappings, { target: '', source: '' }] });
  };

  const handleRemove = (index: number) => {
    onChange({ ...config, mappings: mappings.filter((_, i) => i !== index) });
  };

  const fieldGroups = buildFieldGroups({ sampleFields, samplePayload, previousSteps });

  return (
    <div className="space-y-3" data-testid="transform-data-config">
      <p className="text-xs text-neutral-500">
        Map and transform data from previous steps. Pick a source field or type a path manually.
      </p>

      {mappings.map((mapping, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Source</label>
            <FieldPicker
              value={mapping.source || ''}
              onChange={(v) => handleUpdate(i, 'source', v)}
              placeholder="trigger.email"
              fieldGroups={fieldGroups}
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Target Field</label>
            <input
              type="text"
              value={mapping.target || ''}
              onChange={(e) => handleUpdate(i, 'target', e.target.value)}
              placeholder="formatted_name"
              className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Transform</label>
            <select
              value={mapping.transform || ''}
              onChange={(e) => handleUpdate(i, 'transform', e.target.value)}
              className="px-2 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white focus:border-white/20 focus:outline-none"
            >
              {TRANSFORMS.map(({ value, label }) => (
                <option key={value} value={value} className="bg-black">{label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => handleRemove(i)}
            className="p-2 text-neutral-600 hover:text-red-400 transition-colors"
          >
            <Trash size={14} />
          </button>
        </div>
      ))}

      <button
        onClick={handleAdd}
        className="flex items-center gap-1 text-xs text-neutral-400 hover:text-white transition-colors"
      >
        <Plus size={12} weight="bold" />
        Add Mapping
      </button>
    </div>
  );
}
