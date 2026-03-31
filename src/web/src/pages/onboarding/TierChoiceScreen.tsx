/**
 * Onboarding: Tier Choice
 * Optional license key entry for cloud/connected mode.
 */

import { useState } from 'react';
import { CircleNotch } from '@phosphor-icons/react';

interface TierChoiceScreenProps {
  licenseKey: string;
  onChangeLicenseKey: (value: string) => void;
  onValidate: () => Promise<void>;
  onSkip: () => void;
  onBack: () => void;
  validating: boolean;
  error: string | null;
}

export function TierChoiceScreen({
  licenseKey,
  onChangeLicenseKey,
  onValidate,
  onSkip,
  onBack,
  validating,
  error,
}: TierChoiceScreenProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (licenseKey.trim()) {
      onValidate();
    }
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8">
        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>Step 2 of 9</span>
          <div className="flex-1 h-0.5 bg-white/10 rounded-full">
            <div className="h-full w-[22%] bg-white/30 rounded-full" />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Connect to the cloud</h1>
          <p className="text-neutral-400 text-sm">
            Enter your license key to unlock cloud features, or skip to use ohwow locally for free.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-neutral-400 block mb-1.5">License key</label>
            <input
              type="text"
              value={licenseKey}
              onChange={e => onChangeLicenseKey(e.target.value)}
              placeholder="ohwow_lic_..."
              disabled={validating}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 disabled:opacity-50"
              autoFocus
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={validating || !licenseKey.trim()}
            className="w-full bg-white text-black rounded-lg py-3 text-sm font-medium hover:bg-neutral-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {validating ? (
              <>
                <CircleNotch size={14} className="animate-spin" />
                Validating...
              </>
            ) : (
              'Validate key'
            )}
          </button>
        </form>

        <div className="text-center">
          <button
            onClick={onSkip}
            className="text-sm text-neutral-400 hover:text-white transition-colors"
          >
            Skip and continue locally (free forever)
          </button>
        </div>

        <div className="text-center">
          <button
            onClick={onBack}
            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            ← Back
          </button>
        </div>
      </div>
    </div>
  );
}
