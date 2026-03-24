/**
 * Onboarding Screen 2: Your First Model
 * Device detection, hero recommendation, download with progress.
 */

import { useState } from 'react';
import type { OnboardingStatus, ModelInfo } from '../../hooks/useOnboarding';

interface ModelScreenProps {
  status: OnboardingStatus | null;
  selectedModel: ModelInfo | null;
  loading: boolean;
  downloading: boolean;
  downloadPercent: number;
  downloadMessage: string;
  setupMessage: string;
  error: string | null;
  estimatedMinutes: number | null;
  onSelectModel: (model: ModelInfo) => void;
  onDownload: () => void;
  onSkip: () => void;
}

export function ModelScreen({
  status,
  selectedModel,
  loading,
  downloading,
  downloadPercent,
  downloadMessage,
  setupMessage,
  error,
  onSelectModel,
  onDownload,
  onSkip,
}: ModelScreenProps) {
  const [showAlternatives, setShowAlternatives] = useState(false);

  if (loading || !status) {
    return (
      <div data-testid="onboarding-model-loading" className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="text-center space-y-4">
          <div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin mx-auto" />
          <p className="text-sm text-neutral-400">Detecting your hardware...</p>
        </div>
      </div>
    );
  }

  const estimatedMinutes = selectedModel
    ? Math.ceil((selectedModel.sizeGB * 1024) / 50 / 60 * 8)
    : null;

  return (
    <div data-testid="onboarding-model" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        {/* Title */}
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold text-white">
            Let&apos;s download your first AI model
          </h2>
        </div>

        {/* Device card */}
        <div data-testid="onboarding-device-summary" className="bg-white/5 border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-neutral-400">
          {status.deviceSummary}
        </div>

        {/* Hero recommendation */}
        {selectedModel && !downloading && (
          <div data-testid="onboarding-model-hero" className="bg-white/5 border border-white/10 rounded-lg p-5 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-white">
                    {selectedModel.label}
                  </h3>
                  {selectedModel.recommended && (
                    <span className="text-[10px] uppercase tracking-wider bg-white/10 text-white px-2 py-0.5 rounded-full border border-white/10">
                      Best for your machine
                    </span>
                  )}
                </div>
                <p className="text-sm text-neutral-400 mt-1">
                  {selectedModel.description}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs text-neutral-400">
              <span>{selectedModel.sizeGB} GB download</span>
              {estimatedMinutes && <span>~{estimatedMinutes} min</span>}
              <span>{selectedModel.features.join(', ')}</span>
            </div>
          </div>
        )}

        {/* Download progress */}
        {downloading && (
          <div data-testid="onboarding-download-progress" className="bg-white/5 border border-white/[0.08] rounded-lg p-5 space-y-4">
            {setupMessage && (
              <p className="text-sm text-neutral-400">{setupMessage}</p>
            )}
            {!setupMessage && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white">{selectedModel?.label}</span>
                  <span className="text-neutral-400">{downloadPercent}%</span>
                </div>
                <div className="w-full bg-white/[0.06] rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-white h-full rounded-full transition-all duration-300"
                    style={{ width: `${downloadPercent}%` }}
                  />
                </div>
                <p className="text-xs text-neutral-400 truncate">{downloadMessage}</p>
              </>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-critical/10 border border-critical/20 rounded-lg px-4 py-3 text-sm text-critical">
            {error}
          </div>
        )}

        {/* Actions */}
        {!downloading && (
          <div className="space-y-3">
            <button
              data-testid="onboarding-download-btn"
              onClick={onDownload}
              disabled={!selectedModel}
              className="w-full bg-white text-black rounded-lg px-6 py-3.5 text-base font-medium hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Download
            </button>

            {/* Alternatives toggle */}
            {status.alternatives.length > 0 && (
              <div>
                <button
                  data-testid="onboarding-alternatives-toggle"
                  onClick={() => setShowAlternatives(!showAlternatives)}
                  className="text-sm text-neutral-400 hover:text-white transition-colors"
                >
                  {showAlternatives ? 'Hide other options' : 'See other options'}
                </button>

                {showAlternatives && (
                  <div className="mt-3 space-y-2">
                    {status.alternatives.map((model) => (
                      <button
                        key={model.tag}
                        onClick={() => onSelectModel(model)}
                        className={`w-full text-left bg-white/5 border rounded-lg px-4 py-3 text-sm transition-colors ${
                          selectedModel?.tag === model.tag
                            ? 'border-white/10 text-white'
                            : 'border-white/[0.08] text-neutral-400 hover:border-white/[0.08] hover:text-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{model.label}</span>
                          <span className="text-xs">{model.sizeGB} GB</span>
                        </div>
                        <p className="text-xs text-neutral-400 mt-0.5">{model.description}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Skip */}
            <div className="text-center">
              <button
                data-testid="onboarding-skip-btn"
                onClick={onSkip}
                className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
