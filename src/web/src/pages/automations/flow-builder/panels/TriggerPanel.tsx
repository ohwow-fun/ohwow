import { useState } from 'react';
import { Globe, CalendarBlank, BellRinging, Hand, CheckCircle, CaretDown, X } from '@phosphor-icons/react';
import type { AutomationTriggerType } from '../../types';
import type { TriggerNodeData } from '../utils/flow-converters';
import { CronPicker } from '../../../../components/CronPicker';
import { SampleJsonInput } from '../configs/SampleJsonInput';

const COOLDOWN_PRESETS = [
  { label: 'No limit', seconds: 0 },
  { label: '30 seconds', seconds: 30 },
  { label: '1 minute', seconds: 60 },
  { label: '5 minutes', seconds: 300 },
  { label: '15 minutes', seconds: 900 },
  { label: '30 minutes', seconds: 1800 },
  { label: '1 hour', seconds: 3600 },
] as const;

function isPresetCooldown(seconds: number): boolean {
  return COOLDOWN_PRESETS.some((p) => p.seconds === seconds);
}

const TRIGGER_OPTIONS: {
  type: AutomationTriggerType;
  label: string;
  description: string;
  icon: typeof Globe;
}[] = [
  { type: 'webhook', label: 'Webhook', description: 'Triggered by incoming data', icon: Globe },
  { type: 'schedule', label: 'Schedule', description: 'Runs on a timer', icon: CalendarBlank },
  { type: 'event', label: 'Event', description: 'Listens for system events', icon: BellRinging },
  { type: 'manual', label: 'Manual', description: 'Run on demand', icon: Hand },
];

interface TriggerPanelProps {
  data: TriggerNodeData;
  onChange: (update: Partial<TriggerNodeData>) => void;
}

export function TriggerPanel({ data, onChange }: TriggerPanelProps) {
  const customCooldown = !isPresetCooldown(data.cooldownSeconds);
  const [sampleExpanded, setSampleExpanded] = useState(false);
  const hasSampleData = (data.sampleFields?.length ?? 0) > 0;

  return (
    <div className="space-y-5">
      {/* Trigger Type Picker */}
      <div>
        <label className="mb-2 block text-xs uppercase tracking-wider text-neutral-400">
          Trigger Type
        </label>
        <div className="grid grid-cols-2 gap-2">
          {TRIGGER_OPTIONS.map(({ type, label, description, icon: Icon }) => (
            <button
              key={type}
              onClick={() =>
                onChange({
                  triggerType: type,
                  triggerConfig: {},
                })
              }
              data-testid={`flow-trigger-type-${type}`}
              className={`flex flex-col items-start rounded-lg border p-3 text-left transition-all ${
                data.triggerType === type
                  ? 'border-white/20 bg-white/[0.05]'
                  : 'border-white/[0.06] bg-white/[0.02] hover:border-white/10'
              }`}
            >
              <Icon
                size={18}
                weight={data.triggerType === type ? 'fill' : 'regular'}
                className={data.triggerType === type ? 'text-white' : 'text-neutral-500'}
              />
              <span
                className={`mt-1.5 text-xs font-medium ${
                  data.triggerType === type ? 'text-white' : 'text-neutral-400'
                }`}
              >
                {label}
              </span>
              <span className="mt-0.5 text-[10px] text-neutral-600">{description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Webhook Config */}
      {data.triggerType === 'webhook' && (
        <div className="space-y-3">
          {/* Current sample data indicator */}
          {hasSampleData && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <CheckCircle size={14} className="text-emerald-400" weight="fill" />
                  <span className="text-xs font-medium text-emerald-400">
                    {data.sampleFields!.length}{' '}
                    {data.sampleFields!.length === 1 ? 'field' : 'fields'} loaded
                  </span>
                </div>
                <button
                  onClick={() =>
                    onChange({ sampleFields: [], samplePayload: null })
                  }
                  className="text-neutral-500 hover:text-neutral-400"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {data.sampleFields!.slice(0, 8).map((field) => (
                  <span
                    key={field}
                    className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                  >
                    {field}
                  </span>
                ))}
                {data.sampleFields!.length > 8 && (
                  <span className="px-1 text-[10px] text-neutral-600">
                    +{data.sampleFields!.length - 8} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Load sample data collapsible */}
          <div>
            <button
              onClick={() => setSampleExpanded(!sampleExpanded)}
              className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left text-xs text-neutral-400 transition-colors hover:border-white/10"
            >
              <span>{hasSampleData ? 'Change sample data' : 'Load sample data'}</span>
              <CaretDown
                size={12}
                className={`transition-transform ${sampleExpanded ? 'rotate-180' : ''}`}
              />
            </button>
            {sampleExpanded && (
              <div className="mt-2">
                <SampleJsonInput
                  existingSamplePayload={data.samplePayload}
                  onSampleParsed={(fields, payload) => {
                    onChange({ sampleFields: fields, samplePayload: payload });
                    setSampleExpanded(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schedule Config */}
      {data.triggerType === 'schedule' && (
        <div>
          <label className="mb-1 block text-xs text-neutral-400">Schedule</label>
          <CronPicker
            value={(data.triggerConfig.cron as string) || ''}
            onChange={(cron) =>
              onChange({
                triggerConfig: { ...data.triggerConfig, cron },
              })
            }
          />
        </div>
      )}

      {/* Event Config */}
      {data.triggerType === 'event' && (
        <div>
          <label className="mb-1 block text-xs text-neutral-400">System Event</label>
          <select
            value={(data.triggerConfig.event_name as string) || ''}
            onChange={(e) =>
              onChange({
                triggerConfig: { ...data.triggerConfig, event_name: e.target.value },
              })
            }
            className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-white/20 focus:outline-none"
          >
            <option value="" className="bg-black">Select event...</option>
            <option value="task_completed" className="bg-black">Task Completed</option>
            <option value="agent_error" className="bg-black">Agent Error</option>
            <option value="contact_created" className="bg-black">Contact Created</option>
          </select>
        </div>
      )}

      {/* Cooldown */}
      {(data.triggerType === 'webhook' || data.triggerType === 'event') && (
        <div>
          <label className="mb-1 block text-xs text-neutral-400">Run at most every</label>
          <div className="flex items-center gap-2">
            <select
              value={customCooldown ? -1 : data.cooldownSeconds}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (val === -1) {
                  onChange({ cooldownSeconds: data.cooldownSeconds || 120 });
                } else {
                  onChange({ cooldownSeconds: val });
                }
              }}
              className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-white/20 focus:outline-none"
            >
              {COOLDOWN_PRESETS.map((preset) => (
                <option key={preset.seconds} value={preset.seconds} className="bg-black">
                  {preset.label}
                </option>
              ))}
              <option value={-1} className="bg-black">Custom</option>
            </select>
            {customCooldown && (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={data.cooldownSeconds}
                  onChange={(e) =>
                    onChange({ cooldownSeconds: parseInt(e.target.value, 10) || 0 })
                  }
                  min={0}
                  className="w-20 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-white/20 focus:outline-none"
                />
                <span className="text-xs text-neutral-500">seconds</span>
              </div>
            )}
          </div>
          <p className="mt-1 text-[10px] text-neutral-600">
            Prevents this automation from running too often
          </p>
        </div>
      )}
    </div>
  );
}
