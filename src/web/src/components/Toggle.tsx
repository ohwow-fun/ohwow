interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function Toggle({ checked, onChange, disabled = false, size = 'md' }: ToggleProps) {
  const dims = size === 'sm'
    ? { track: 'w-8 h-4', thumb: 'w-3 h-3', translate: 'translate-x-4' }
    : { track: 'w-10 h-5', thumb: 'w-4 h-4', translate: 'translate-x-5' };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative ${dims.track} rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-success/30' : 'bg-white/10'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 ${dims.thumb} rounded-full transition-transform ${
          checked ? `${dims.translate} bg-success` : 'translate-x-0 bg-neutral-400'
        }`}
      />
    </button>
  );
}
