/**
 * Onboarding: Integration Setup
 * Collects API tokens/keys for MCP servers required by selected agents.
 */

import { useState } from 'react';
import { PlugsConnected, Check, SkipForward } from '@phosphor-icons/react';

interface McpEnvVar {
  key: string;
  label: string;
}

interface McpIntegration {
  id: string;
  name: string;
  description: string;
  envVarsRequired: McpEnvVar[];
}

interface IntegrationSetupScreenProps {
  integrations: McpIntegration[];
  integrationValues: Record<string, Record<string, string>>;
  onSetValue: (serverId: string, envKey: string, value: string) => void;
  onSkipIntegration: (serverId: string) => void;
  skippedIds: Set<string>;
  onContinue: () => void;
  onBack: () => void;
}

export function IntegrationSetupScreen({
  integrations,
  integrationValues,
  onSetValue,
  onSkipIntegration,
  skippedIds,
  onContinue,
  onBack,
}: IntegrationSetupScreenProps) {
  if (integrations.length === 0) {
    // No integrations needed, auto-advance
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="w-14 h-14 rounded-xl bg-success/10 flex items-center justify-center mx-auto">
            <Check size={28} className="text-success" />
          </div>
          <h2 className="text-lg font-bold">No integrations needed</h2>
          <p className="text-sm text-neutral-400">Your selected agents work out of the box.</p>
          <button
            onClick={onContinue}
            className="w-full bg-white text-black rounded-lg py-3 text-sm font-medium hover:bg-neutral-200 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  const allDone = integrations.every(
    i => skippedIds.has(i.id) || i.envVarsRequired.every(env => !!integrationValues[i.id]?.[env.key])
  );

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-6">
        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>Step 8 of 9</span>
          <div className="flex-1 h-0.5 bg-white/10 rounded-full">
            <div className="h-full w-[89%] bg-white/30 rounded-full" />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Connect integrations</h1>
          <p className="text-neutral-400 text-sm">
            Some agents work best with connected services. You can skip any for now.
          </p>
        </div>

        <div className="space-y-4">
          {integrations.map(integration => {
            const isSkipped = skippedIds.has(integration.id);
            const values = integrationValues[integration.id] || {};
            const isComplete = integration.envVarsRequired.every(env => !!values[env.key]);

            return (
              <div
                key={integration.id}
                className={`border rounded-lg p-4 transition-colors ${
                  isComplete
                    ? 'border-success/30 bg-success/[0.03]'
                    : isSkipped
                    ? 'border-white/[0.06] bg-white/[0.01] opacity-50'
                    : 'border-white/[0.08] bg-white/[0.02]'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <PlugsConnected size={16} className={isComplete ? 'text-success' : 'text-neutral-400'} />
                    <span className="text-sm font-medium">{integration.name}</span>
                    {isComplete && (
                      <span className="text-[10px] bg-success/15 text-success px-1.5 py-0.5 rounded">connected</span>
                    )}
                    {isSkipped && (
                      <span className="text-[10px] bg-white/[0.06] text-neutral-500 px-1.5 py-0.5 rounded">skipped</span>
                    )}
                  </div>
                  {!isComplete && !isSkipped && (
                    <button
                      onClick={() => onSkipIntegration(integration.id)}
                      className="text-xs text-neutral-500 hover:text-white transition-colors flex items-center gap-1"
                    >
                      <SkipForward size={12} /> Skip
                    </button>
                  )}
                </div>

                <p className="text-xs text-neutral-500 mb-3">{integration.description}</p>

                {!isSkipped && (
                  <div className="space-y-2">
                    {integration.envVarsRequired.map(env => (
                      <div key={env.key}>
                        <label className="text-[10px] text-neutral-400 block mb-1">{env.label}</label>
                        <input
                          type="password"
                          value={values[env.key] || ''}
                          onChange={e => onSetValue(integration.id, env.key, e.target.value)}
                          placeholder={env.key}
                          className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-white/20"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onBack}
            className="flex-1 border border-white/10 text-neutral-400 rounded-lg py-3 text-sm hover:bg-white/5 transition-colors"
          >
            Back
          </button>
          <button
            onClick={onContinue}
            disabled={!allDone}
            className="flex-1 bg-white text-black rounded-lg py-3 text-sm font-medium hover:bg-neutral-200 transition-colors disabled:opacity-50"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
