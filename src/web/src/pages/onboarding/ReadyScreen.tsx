/**
 * Onboarding Screen 7: Ready
 * Summary with business name, model, agents, and launch button.
 */

import type { ModelInfo } from '../../hooks/useOnboarding';

interface ReadyScreenProps {
  selectedModel: ModelInfo | null;
  loading: boolean;
  error: string | null;
  onLaunch: () => void;
  businessName?: string;
  agentCount?: number;
  launchLabel?: string;
}

export function ReadyScreen({ selectedModel, loading, error, onLaunch, businessName, agentCount, launchLabel = 'Start Chatting' }: ReadyScreenProps) {
  return (
    <div data-testid="onboarding-ready" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <p className="text-xs text-neutral-400 uppercase tracking-wider">Step 7 of 7</p>
        </div>

        {/* Confirmation */}
        <div className="space-y-3">
          <div className="w-12 h-12 rounded-full bg-success/10 border border-success/20 flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <h2 className="text-2xl font-bold text-white">
            You&apos;re all set.
          </h2>
        </div>

        {/* Summary */}
        <div className="bg-white/5 border border-white/[0.08] rounded-lg px-4 py-3 text-left space-y-2">
          {businessName && (
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">Business</span>
              <span className="text-white font-medium">{businessName}</span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-neutral-400">Model</span>
            <span className="text-white">
              {selectedModel ? selectedModel.label : 'None (add later in Settings)'}
            </span>
          </div>
          {agentCount !== undefined && agentCount > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">Agents</span>
              <span className="text-white">
                {agentCount} agent{agentCount === 1 ? '' : 's'} ready to go
              </span>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="bg-critical/10 border border-critical/20 rounded-lg px-4 py-3 text-sm text-critical">
            {error}
          </div>
        )}

        {/* Launch */}
        <button
          data-testid="onboarding-launch-btn"
          onClick={onLaunch}
          disabled={loading}
          className="w-full bg-white text-black rounded-lg px-6 py-3.5 text-base font-medium hover:bg-neutral-200 transition-colors disabled:opacity-50"
        >
          {loading ? 'Saving...' : launchLabel}
        </button>
      </div>
    </div>
  );
}
