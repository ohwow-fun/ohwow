import { useState } from 'react';
import { ClipboardText, Clock, Check, Warning } from '@phosphor-icons/react';
import { flattenJson } from '../utils/field-utils';

interface SampleJsonInputProps {
  onSampleParsed: (fields: string[], payload: Record<string, unknown>) => void;
  existingSamplePayload?: Record<string, unknown> | null;
}

export function SampleJsonInput({
  onSampleParsed,
  existingSamplePayload,
}: SampleJsonInputProps) {
  const [activeTab, setActiveTab] = useState<'paste' | 'history'>(
    existingSamplePayload ? 'history' : 'paste',
  );
  const [rawJson, setRawJson] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [previewFields, setPreviewFields] = useState<string[]>([]);
  const [parsedPayload, setParsedPayload] = useState<Record<string, unknown> | null>(null);

  function handleJsonChange(value: string) {
    setRawJson(value);
    setParseError(null);
    setPreviewFields([]);
    setParsedPayload(null);

    if (!value.trim()) return;

    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setParseError('Must be a JSON object (not an array or primitive)');
        return;
      }
      const { fields, payload } = flattenJson(parsed);
      setPreviewFields(fields);
      setParsedPayload(payload);
    } catch {
      setParseError('Invalid JSON');
    }
  }

  function handleConfirmPaste() {
    if (parsedPayload && previewFields.length > 0) {
      onSampleParsed(previewFields, parsedPayload);
    }
  }

  function handleSelectExisting() {
    if (!existingSamplePayload) return;
    const { fields, payload } = flattenJson(existingSamplePayload);
    onSampleParsed(fields, payload);
  }

  const tabs = [
    { id: 'paste' as const, label: 'Paste JSON', icon: ClipboardText },
    ...(existingSamplePayload
      ? [{ id: 'history' as const, label: 'Previous data', icon: Clock }]
      : []),
  ];

  return (
    <div className="space-y-3">
      {/* Tabs */}
      {tabs.length > 1 && (
        <div className="flex gap-1 rounded-lg bg-white/[0.03] p-0.5">
          {tabs.map(({ id, label, icon: TabIcon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors ${
                activeTab === id
                  ? 'bg-white/[0.08] text-white'
                  : 'text-neutral-500 hover:text-neutral-400'
              }`}
            >
              <TabIcon size={13} />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Paste JSON tab */}
      {activeTab === 'paste' && (
        <div className="space-y-2">
          <textarea
            value={rawJson}
            onChange={(e) => handleJsonChange(e.target.value)}
            placeholder={'{\n  "email": "jane@example.com",\n  "name": "Jane Smith"\n}'}
            className="h-32 w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-xs text-white placeholder:text-neutral-700 focus:border-white/20 focus:outline-none"
          />

          {parseError && (
            <div className="flex items-center gap-1.5 text-[11px] text-red-400">
              <Warning size={12} />
              {parseError}
            </div>
          )}

          {previewFields.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {previewFields.slice(0, 12).map((field) => (
                  <span
                    key={field}
                    className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                  >
                    {field}
                  </span>
                ))}
                {previewFields.length > 12 && (
                  <span className="px-1 text-[10px] text-neutral-600">
                    +{previewFields.length - 12} more
                  </span>
                )}
              </div>
              <button
                onClick={handleConfirmPaste}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/[0.08] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/[0.12]"
              >
                <Check size={14} />
                Use these {previewFields.length}{' '}
                {previewFields.length === 1 ? 'field' : 'fields'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Previous data tab */}
      {activeTab === 'history' && existingSamplePayload && (
        <div className="space-y-2">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <p className="mb-2 text-[10px] uppercase tracking-wider text-neutral-500">
              Previously captured data
            </p>
            <div className="flex flex-wrap gap-1">
              {Object.keys(flattenJson(existingSamplePayload).payload)
                .slice(0, 12)
                .map((field) => (
                  <span
                    key={field}
                    className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                  >
                    {field}
                  </span>
                ))}
            </div>
          </div>
          <button
            onClick={handleSelectExisting}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/[0.08] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/[0.12]"
          >
            <Check size={14} />
            Reuse this data
          </button>
        </div>
      )}
    </div>
  );
}
