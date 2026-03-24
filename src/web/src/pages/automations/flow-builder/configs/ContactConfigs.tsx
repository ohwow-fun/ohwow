import type { AutomationAction } from '../../types';
import { buildFieldGroups } from '../utils/field-utils';
import { FieldPicker } from './FieldPicker';

interface ContactConfigsProps {
  stepType: 'save_contact' | 'update_contact' | 'log_contact_event';
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  previousSteps: AutomationAction[];
  sampleFields: string[];
  samplePayload?: Record<string, unknown> | null;
}

export function ContactConfigs({
  stepType,
  config,
  onChange,
  previousSteps,
  sampleFields,
  samplePayload,
}: ContactConfigsProps) {
  const fieldGroups = buildFieldGroups({ sampleFields, samplePayload, previousSteps });

  if (stepType === 'save_contact') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-neutral-500">Map incoming data to contact fields.</p>
        {['name', 'email', 'phone', 'company'].map((field) => (
          <div key={field}>
            <label className="text-xs text-neutral-400 block mb-1 capitalize">{field}</label>
            <FieldPicker
              value={(config[field] as string) || ''}
              onChange={(v) => onChange({ ...config, [field]: v })}
              placeholder={`trigger.${field}`}
              fieldGroups={fieldGroups}
            />
          </div>
        ))}
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Tags</label>
          <input
            type="text"
            value={(config.tags as string) || ''}
            onChange={(e) => onChange({ ...config, tags: e.target.value })}
            placeholder="tag1, tag2"
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
          />
          <p className="text-[10px] text-neutral-600 mt-1">Comma-separated tags</p>
        </div>
      </div>
    );
  }

  if (stepType === 'update_contact') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-neutral-500">Find a contact and update their fields.</p>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Find by email</label>
          <FieldPicker
            value={(config.lookup_email as string) || ''}
            onChange={(v) => onChange({ ...config, lookup_email: v })}
            placeholder="trigger.email"
            fieldGroups={fieldGroups}
          />
        </div>
        {['name', 'phone', 'company'].map((field) => (
          <div key={field}>
            <label className="text-xs text-neutral-400 block mb-1 capitalize">New {field}</label>
            <FieldPicker
              value={(config[field] as string) || ''}
              onChange={(v) => onChange({ ...config, [field]: v })}
              placeholder={`trigger.${field}`}
              fieldGroups={fieldGroups}
            />
          </div>
        ))}
      </div>
    );
  }

  // log_contact_event
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">Log an event to a contact&apos;s timeline.</p>
      <div>
        <label className="text-xs text-neutral-400 block mb-1">Contact email</label>
        <FieldPicker
          value={(config.contact_email as string) || ''}
          onChange={(v) => onChange({ ...config, contact_email: v })}
          placeholder="trigger.email"
          fieldGroups={fieldGroups}
        />
      </div>
      <div>
        <label className="text-xs text-neutral-400 block mb-1">Event type</label>
        <input
          type="text"
          value={(config.event_type as string) || ''}
          onChange={(e) => onChange({ ...config, event_type: e.target.value })}
          placeholder="form_submitted"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
        />
      </div>
      <div>
        <label className="text-xs text-neutral-400 block mb-1">Description</label>
        <input
          type="text"
          value={(config.description as string) || ''}
          onChange={(e) => onChange({ ...config, description: e.target.value })}
          placeholder="Filled out the contact form"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
        />
      </div>
    </div>
  );
}
