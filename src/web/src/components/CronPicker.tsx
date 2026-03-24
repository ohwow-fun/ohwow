import { useState } from 'react';

interface CronPickerProps {
  value: string;
  onChange: (cron: string) => void;
}

const PRESETS = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 3 hours', cron: '0 */3 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Daily at 6pm', cron: '0 18 * * *' },
  { label: 'Weekdays at 9am', cron: '0 9 * * 1-5' },
  { label: 'Weekly (Monday 9am)', cron: '0 9 * * 1' },
  { label: 'Monthly (1st at 9am)', cron: '0 9 1 * *' },
];

export function CronPicker({ value, onChange }: CronPickerProps) {
  const [mode, setMode] = useState<'preset' | 'custom'>(
    PRESETS.some(p => p.cron === value) ? 'preset' : 'custom'
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setMode('preset')}
          className={`px-2 py-1 rounded text-xs transition-colors ${
            mode === 'preset' ? 'bg-white/5 text-white' : 'text-neutral-400 hover:text-white'
          }`}
        >
          Presets
        </button>
        <button
          type="button"
          onClick={() => setMode('custom')}
          className={`px-2 py-1 rounded text-xs transition-colors ${
            mode === 'custom' ? 'bg-white/5 text-white' : 'text-neutral-400 hover:text-white'
          }`}
        >
          Custom
        </button>
      </div>

      {mode === 'preset' ? (
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map(preset => (
            <button
              key={preset.cron}
              type="button"
              onClick={() => onChange(preset.cron)}
              className={`text-left px-3 py-2 rounded text-xs transition-colors border ${
                value === preset.cron
                  ? 'border-white/20 bg-white/10 text-white'
                  : 'border-white/[0.08] hover:border-white/20 text-neutral-400 hover:text-white'
              }`}
            >
              <span className="block">{preset.label}</span>
              <span className="block font-mono text-[10px] text-neutral-400 mt-0.5">{preset.cron}</span>
            </button>
          ))}
        </div>
      ) : (
        <div>
          <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="* * * * *"
            className="w-full bg-white/[0.06] border border-white/[0.08] rounded px-3 py-2 text-sm text-white font-mono placeholder:text-neutral-400/50 focus:outline-none focus:border-white/20"
          />
          <p className="text-[10px] text-neutral-400 mt-1">
            Format: minute hour day month weekday
          </p>
        </div>
      )}
    </div>
  );
}
