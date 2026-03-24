import { useState, useRef, useEffect } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { FieldGroup } from '../utils/field-utils';

interface FieldPickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  fieldGroups: FieldGroup[];
  /** 'path' replaces input value, 'template' inserts {{path}} at cursor */
  mode?: 'path' | 'template';
  className?: string;
}

export function FieldPicker({
  value,
  onChange,
  placeholder,
  fieldGroups,
  mode = 'path',
  className,
}: FieldPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (path: string) => {
    if (mode === 'template') {
      onChange(`{{${path}}}`);
    } else {
      onChange(path);
    }
    setOpen(false);
  };

  const hasFields = fieldGroups.some((g) => g.fields.length > 0);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={className || 'w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none'}
          onFocus={() => hasFields && setOpen(true)}
        />
        {hasFields && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="absolute right-0 top-0 bottom-0 px-2 text-neutral-500 hover:text-neutral-300 transition-colors"
            tabIndex={-1}
          >
            <CaretDown size={12} />
          </button>
        )}
      </div>

      {open && hasFields && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-60 overflow-y-auto border border-white/10 rounded-lg bg-[#1a1a1a] shadow-xl">
          {fieldGroups.map((group) => {
            if (group.fields.length === 0) return null;
            return (
              <div key={group.prefix}>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500 font-medium bg-white/[0.02] sticky top-0">
                  {group.label}
                </div>
                {group.fields.map((field) => (
                  <button
                    key={field.path}
                    type="button"
                    onClick={() => handleSelect(field.path)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/[0.06] transition-colors text-left"
                  >
                    <span className="font-mono text-neutral-300">{field.name}</span>
                    {field.value && (
                      <span className="text-neutral-600 truncate">{field.value}</span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Button that inserts a field reference into a textarea at cursor position.
 */
export function InsertFieldButton({
  fieldGroups,
  textareaRef,
  onInsert,
}: {
  fieldGroups: FieldGroup[];
  textareaRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  onInsert: (newValue: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (path: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const currentValue = textarea.value;
    const insertion = `{{${path}}}`;
    const newValue = currentValue.substring(0, start) + insertion + currentValue.substring(end);
    onInsert(newValue);
    setOpen(false);
    // Restore cursor after insertion
    requestAnimationFrame(() => {
      textarea.focus();
      const newPos = start + insertion.length;
      textarea.setSelectionRange(newPos, newPos);
    });
  };

  const hasFields = fieldGroups.some((g) => g.fields.length > 0);
  if (!hasFields) return null;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors"
      >
        + Insert field
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-64 max-h-52 overflow-y-auto border border-white/10 rounded-lg bg-[#1a1a1a] shadow-xl">
          {fieldGroups.map((group) => {
            if (group.fields.length === 0) return null;
            return (
              <div key={group.prefix}>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500 font-medium bg-white/[0.02] sticky top-0">
                  {group.label}
                </div>
                {group.fields.map((field) => (
                  <button
                    key={field.path}
                    type="button"
                    onClick={() => handleSelect(field.path)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/[0.06] transition-colors text-left"
                  >
                    <span className="font-mono text-neutral-300">{field.name}</span>
                    {field.value && (
                      <span className="text-neutral-600 truncate">{field.value}</span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
