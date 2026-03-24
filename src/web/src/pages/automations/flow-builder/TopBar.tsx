import { ArrowLeft, FloppyDisk, Play } from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';

interface TopBarProps {
  name: string;
  onNameChange: (name: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  onSave: () => void;
  onRun?: () => void;
  saving: boolean;
  isNew: boolean;
}

export function TopBar({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  onSave,
  onRun,
  saving,
  isNew,
}: TopBarProps) {
  const navigate = useNavigate();

  const handleBack = () => {
    navigate('/automations');
  };

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] px-4">
      <button
        onClick={handleBack}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-white/[0.05] hover:text-white"
        data-testid="flow-builder-back"
      >
        <ArrowLeft size={18} />
      </button>

      <div className="h-5 w-px bg-white/[0.06]" />

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Automation name"
          data-testid="flow-builder-name"
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-white placeholder-gray-600 focus:outline-none"
        />
        <input
          type="text"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Description (optional)"
          className="hidden min-w-0 flex-1 bg-transparent text-sm text-neutral-400 placeholder-gray-700 focus:outline-none md:block"
        />
      </div>

      <div className="flex items-center gap-2">
        {onRun && !isNew && (
          <button
            onClick={onRun}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:border-white/10 hover:text-white"
          >
            <Play size={12} weight="fill" />
            Run
          </button>
        )}
        <button
          onClick={onSave}
          disabled={saving}
          data-testid="flow-builder-save"
          className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black transition-all hover:bg-gray-200 active:scale-[0.98] disabled:opacity-50"
        >
          <FloppyDisk size={14} weight="bold" />
          {saving ? 'Saving...' : isNew ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}
