import type { AutomationAction } from '../../types';
import { buildFieldGroups } from '../utils/field-utils';
import { FieldPicker } from '../configs/FieldPicker';

const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'greater_than', label: 'greater than' },
  { value: 'less_than', label: 'less than' },
  { value: 'exists', label: 'exists' },
  { value: 'not_exists', label: 'does not exist' },
];

interface ConditionFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  previousSteps: AutomationAction[];
  sampleFields: string[];
  samplePayload?: Record<string, unknown> | null;
}

export function ConditionForm({
  config,
  onChange,
  previousSteps,
  sampleFields,
  samplePayload,
}: ConditionFormProps) {
  const condition = (config.condition || { field: '', operator: 'equals', value: '' }) as {
    field: string;
    operator: string;
    value?: string;
  };

  const showValue = !['exists', 'not_exists'].includes(condition.operator);
  const fieldGroups = buildFieldGroups({ sampleFields, samplePayload, previousSteps });

  const handleChange = (field: string, value: string) => {
    const updated = { ...condition, [field]: value };
    onChange({ ...config, condition: updated });
  };

  return (
    <div className="space-y-3" data-testid="condition-form">
      <p className="text-xs text-neutral-500">
        Branch execution based on a condition. Pick a field or type a path manually.
      </p>

      <div>
        <label className="mb-1 block text-xs text-neutral-400">Field</label>
        <FieldPicker
          value={condition.field}
          onChange={(v) => handleChange('field', v)}
          placeholder="trigger.country"
          fieldGroups={fieldGroups}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-neutral-400">Operator</label>
        <select
          value={condition.operator}
          onChange={(e) => handleChange('operator', e.target.value)}
          className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-white/20 focus:outline-none"
        >
          {OPERATORS.map(({ value, label }) => (
            <option key={value} value={value} className="bg-black">
              {label}
            </option>
          ))}
        </select>
      </div>

      {showValue && (
        <div>
          <label className="mb-1 block text-xs text-neutral-400">Value</label>
          <input
            type="text"
            value={condition.value || ''}
            onChange={(e) => handleChange('value', e.target.value)}
            placeholder="US"
            className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
          />
        </div>
      )}
    </div>
  );
}
