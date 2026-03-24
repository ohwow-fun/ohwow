import type { AutomationAction } from '../../types';
import { buildFieldGroups } from '../utils/field-utils';
import { InsertFieldButton } from './FieldPicker';
import { useRef } from 'react';

interface WebhookForwardConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  previousSteps: AutomationAction[];
  sampleFields: string[];
  samplePayload?: Record<string, unknown> | null;
}

export function WebhookForwardConfig({
  config,
  onChange,
  previousSteps,
  sampleFields,
  samplePayload,
}: WebhookForwardConfigProps) {
  const urlRef = useRef<HTMLInputElement>(null);
  const fieldGroups = buildFieldGroups({ sampleFields, samplePayload, previousSteps });

  return (
    <div className="space-y-3" data-testid="webhook-forward-config">
      <p className="text-xs text-neutral-500">Forward data to an external URL.</p>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-neutral-400">URL</label>
          <InsertFieldButton
            fieldGroups={fieldGroups}
            textareaRef={urlRef}
            onInsert={(newValue) => onChange({ ...config, url: newValue })}
          />
        </div>
        <input
          ref={urlRef}
          type="text"
          value={(config.url as string) || ''}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
          placeholder="https://example.com/webhook"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-neutral-400 block mb-1">Method</label>
        <select
          value={(config.method as string) || 'POST'}
          onChange={(e) => onChange({ ...config, method: e.target.value })}
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white focus:border-white/20 focus:outline-none"
        >
          <option value="POST" className="bg-black">POST</option>
          <option value="PUT" className="bg-black">PUT</option>
          <option value="PATCH" className="bg-black">PATCH</option>
        </select>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={(config.include_all_data as boolean) ?? true}
            onChange={(e) => onChange({ ...config, include_all_data: e.target.checked })}
            className="rounded border-white/20 bg-white/[0.03]"
          />
          <span className="text-xs text-neutral-400">Include all trigger and step data</span>
        </label>
      </div>
    </div>
  );
}
