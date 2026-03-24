/**
 * Onboarding Screen 6: Agent Selection
 * Agent cards with checkboxes, descriptions, and tool badges.
 */

interface AgentPreset {
  id: string;
  name: string;
  role: string;
  description: string;
  tools: string[];
  recommended?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  web_research: 'Web Research',
  deep_research: 'Deep Research',
  ocr: 'OCR',
  local_crm: 'CRM',
};

interface AgentSelectionScreenProps {
  presets: AgentPreset[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

export function AgentSelectionScreen({
  presets,
  selectedIds,
  onToggle,
  onContinue,
  onBack,
}: AgentSelectionScreenProps) {
  return (
    <div data-testid="onboarding-agent-selection" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center space-y-2">
          <p className="text-xs text-neutral-400 uppercase tracking-wider">Step 6 of 7</p>
          <h2 className="text-2xl font-bold text-white">Choose your agents</h2>
          <p className="text-sm text-neutral-400">
            {selectedIds.size > 0
              ? `${selectedIds.size} agent${selectedIds.size === 1 ? '' : 's'} selected`
              : 'Select the agents you want to create'}
          </p>
        </div>

        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {presets.map(agent => {
            const isSelected = selectedIds.has(agent.id);
            return (
              <button
                key={agent.id}
                data-testid={`onboarding-agent-${agent.id}`}
                onClick={() => onToggle(agent.id)}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                  isSelected
                    ? 'border-white/20 bg-white/10'
                    : 'border-white/[0.08] bg-white/5 hover:border-white/20'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Checkbox */}
                  <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                    isSelected ? 'bg-white border-white' : 'border-neutral-400/30'
                  }`}>
                    {isSelected && (
                      <svg className="w-2.5 h-2.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-white">{agent.name}</span>
                      {agent.recommended && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white border border-white/10">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-400 mt-0.5">{agent.role}</p>
                    <p className="text-xs text-neutral-400/70 mt-1">{agent.description}</p>

                    {/* Tool badges */}
                    {agent.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {agent.tools.map(tool => (
                          <span
                            key={tool}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/[0.08] text-neutral-400"
                          >
                            {TOOL_LABELS[tool] || tool}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onBack}
            className="px-4 py-2.5 text-sm text-neutral-400 hover:text-white transition-colors"
          >
            Back
          </button>
          <button
            data-testid="onboarding-selection-continue"
            onClick={onContinue}
            disabled={selectedIds.size === 0}
            className="flex-1 bg-white text-black rounded-lg px-6 py-2.5 text-sm font-medium hover:bg-neutral-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create {selectedIds.size} agent{selectedIds.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
