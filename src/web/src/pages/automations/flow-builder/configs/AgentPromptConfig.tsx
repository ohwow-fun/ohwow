import { useRef, useMemo, useState, useEffect } from 'react';
import { Warning } from '@phosphor-icons/react';
import type { AutomationAction } from '../../types';
import { buildFieldGroups, extractTemplateVars, findUnresolvedVars } from '../utils/field-utils';
import { InsertFieldButton } from './FieldPicker';
import { api } from '../../../../api/client';

interface Agent {
  id: string;
  name: string;
  role: string;
}

interface AgentPromptConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  previousSteps: AutomationAction[];
  sampleFields: string[];
  samplePayload?: Record<string, unknown> | null;
}

export function AgentPromptConfig({
  config,
  onChange,
  previousSteps,
  sampleFields,
  samplePayload,
}: AgentPromptConfigProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageUrlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ data: Agent[] }>('/api/agents')
      .then((res) => setAgents(res.data))
      .catch(() => {});
  }, []);

  const agentId = (config.agent_id as string) || '';
  const agentName = (config.agent_name as string) || '';
  const taskPrompt = (config.task_prompt as string) || '';
  const imageUrl = (config.image_url as string) || '';

  const fieldGroups = buildFieldGroups({
    sampleFields,
    samplePayload,
    previousSteps,
  });

  const allFieldPaths = useMemo(
    () => fieldGroups.flatMap((g) => g.fields.map((f) => f.path)),
    [fieldGroups],
  );

  const unresolvedImageVars = useMemo(() => {
    if (!imageUrl || sampleFields.length === 0) return [];
    const vars = extractTemplateVars(imageUrl);
    return findUnresolvedVars(vars, allFieldPaths);
  }, [imageUrl, sampleFields, allFieldPaths]);

  const handleAgentChange = (selectedId: string) => {
    const agent = agents.find((a) => a.id === selectedId);
    onChange({
      ...config,
      agent_id: selectedId,
      agent_name: agent?.name || '',
    });
  };

  return (
    <div className="space-y-3" data-testid="agent-prompt-config">
      <div>
        <label className="text-xs text-neutral-400 block mb-1">Agent</label>
        <select
          value={agentId}
          onChange={(e) => handleAgentChange(e.target.value)}
          data-testid="agent-prompt-agent-select"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white focus:border-white/20 focus:outline-none"
        >
          <option value="" className="bg-black">Select an agent...</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id} className="bg-black">
              {agent.name} ({agent.role})
            </option>
          ))}
        </select>
        {agentName && agentId && (
          <p className="text-[10px] text-neutral-600 mt-1">
            Selected: {agentName}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-neutral-400">
            Task Prompt
            <span className="text-neutral-600 ml-1">
              Use {'{{trigger.field}}'} or {'{{step_1.field}}'} for variables
            </span>
          </label>
          <InsertFieldButton
            fieldGroups={fieldGroups}
            textareaRef={textareaRef}
            onInsert={(newValue) => onChange({ ...config, task_prompt: newValue })}
          />
        </div>
        <textarea
          ref={textareaRef}
          value={taskPrompt}
          onChange={(e) => onChange({ ...config, task_prompt: e.target.value })}
          placeholder="Research the company {{trigger.company_name}} and create a summary."
          rows={4}
          data-testid="agent-prompt-textarea"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none resize-y"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-neutral-400">
            Image URL
            <span className="text-neutral-600 ml-1">(optional)</span>
          </label>
          <InsertFieldButton
            fieldGroups={fieldGroups}
            textareaRef={imageUrlRef}
            onInsert={(newValue) => onChange({ ...config, image_url: newValue })}
          />
        </div>
        <input
          ref={imageUrlRef}
          type="text"
          value={imageUrl}
          onChange={(e) => onChange({ ...config, image_url: e.target.value })}
          placeholder="{{trigger.photo_url}}"
          data-testid="agent-prompt-image-url"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
        />
        {unresolvedImageVars.length > 0 && (
          <div className="flex items-start gap-1.5 mt-1.5 p-1.5 bg-amber-500/10 border border-amber-500/20 rounded">
            <Warning size={12} className="text-amber-400 mt-0.5 flex-shrink-0" />
            <p className="text-[10px] text-amber-400">
              Unknown {unresolvedImageVars.length === 1 ? 'field' : 'fields'}:{' '}
              {unresolvedImageVars.map((v) => `{{${v}}}`).join(', ')}.
              {' '}This may not resolve at runtime.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
