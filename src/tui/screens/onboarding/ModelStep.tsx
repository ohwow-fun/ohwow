/**
 * Onboarding Step 2: Model Setup
 * Device detection + model download (reuses existing OnboardingService logic).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { KeyHints } from '../../components/key-hints.js';
import { ModelSelectionTable } from '../../components/model-selection-table.js';
import type { OnboardingStatus } from '../../../lib/onboarding-service.js';
import type { OllamaModelInfo } from '../../../lib/ollama-models.js';
import { isModelInstalled, estimateDownloadMinutes } from '../../../lib/ollama-models.js';
import type { ModelSource } from '../../../config.js';

interface ModelReadinessInfo {
  modelName: string;
  stats: { requests: number; tokens: number };
}

type CloudAuthStatus = 'none' | 'validating' | 'authenticated';

interface ModelStepProps {
  status: OnboardingStatus | null;
  selectedModel: OllamaModelInfo | null;
  showAlternatives: boolean;
  downloadPercent: number;
  downloadMessage: string;
  downloading: boolean;
  error: string;
  /** Installed models that match catalog entries */
  installedCatalogModels?: OllamaModelInfo[];
  onSelectAlternative: (item: { value: string }) => void;
  /** When set, renders a compact readiness view instead of setup flow */
  readinessMode?: ModelReadinessInfo | null;
  /** Models currently loaded in VRAM */
  runningModels?: string[];
  /** All installed models (including non-catalog ones) */
  allInstalledModels?: string[];
  /** Currently selected model index in readiness mode */
  readinessSelectedIdx?: number;
  /** Model tag currently being loaded (null if idle) */
  readinessLoading?: string | null;
  /** Current model source selection */
  modelSource?: ModelSource;
  /** Cloud authentication status */
  cloudAuthStatus?: CloudAuthStatus;
  /** Cloud model ID */
  cloudModel?: string;
}

/** Check if a model tag matches a running model (full tag match, bare tag matches any variant). */
function isModelRunning(modelTag: string, runningModels: string[]): boolean {
  const base = modelTag.split(':')[0];
  const variant = modelTag.split(':')[1] || '';
  return runningModels.some(r => {
    const rBase = r.split(':')[0];
    const rVariant = r.split(':')[1] || '';
    return rBase === base && (variant === '' || rVariant === variant);
  });
}

export function ModelStep({
  status,
  selectedModel,
  showAlternatives,
  downloadPercent,
  downloadMessage,
  downloading,
  error,
  installedCatalogModels = [],
  onSelectAlternative,
  readinessMode,
  runningModels = [],
  allInstalledModels = [],
  readinessSelectedIdx = 0,
  readinessLoading = null,
  modelSource = 'local',
  cloudAuthStatus = 'none',
  cloudModel = 'claude-haiku-4-5-20251001',
}: ModelStepProps) {
  // Download view takes priority over all other modes
  if (downloading) {
    return (
      <Box flexDirection="column">
        <Text bold>Downloading {selectedModel?.label || 'model'}</Text>
        {selectedModel && (
          <Text color="gray">{selectedModel.tag} ({selectedModel.sizeGB} GB)</Text>
        )}
        <Box marginTop={1}>
          <Text color="cyan">{renderProgressBar(downloadPercent)}</Text>
        </Box>
        <Text color="gray">{downloadMessage}</Text>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Readiness mode: full installed model list for returning users
  if (readinessMode) {
    const configuredTag = readinessMode.modelName;
    // Build a unified list: catalog matches first, then any raw tags not in catalog
    const catalogTags = new Set(installedCatalogModels.map(m => m.tag.split(':')[0]));
    const extraTags = allInstalledModels.filter(tag => !catalogTags.has(tag.split(':')[0]));
    let rowIdx = 0;

    const sourceLabel = modelSource === 'cloud'
      ? `Cloud: ${formatCloudModelName(cloudModel)}`
      : `Local: ${configuredTag}`;

    return (
      <Box flexDirection="column">
        <Text bold>Your orchestrator model</Text>
        <Box>
          <Text color={modelSource === 'cloud' ? 'magenta' : 'green'}>{sourceLabel}</Text>
          {modelSource === 'cloud' && cloudAuthStatus === 'authenticated' && (
            <Text color="green"> (connected)</Text>
          )}
        </Box>

        {modelSource === 'cloud' ? (
          <Box flexDirection="column" marginTop={1}>
            <Box borderStyle="round" borderColor="magenta" paddingX={2} paddingY={1} flexDirection="column">
              <Text bold color="white">{formatCloudModelName(cloudModel)}</Text>
              <Text color="gray">Anthropic Claude cloud model</Text>
              <Text color={cloudAuthStatus === 'authenticated' ? 'green' : 'yellow'}>
                {cloudAuthStatus === 'authenticated' ? '● Connected' : '○ Not connected'}
              </Text>
            </Box>
          </Box>
        ) : installedCatalogModels.length === 0 && extraTags.length === 0 ? (
          <Box marginTop={1}>
            <Text color="gray">No models installed yet.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {installedCatalogModels.map(m => {
              const idx = rowIdx++;
              const selected = idx === readinessSelectedIdx;
              const running = isModelRunning(m.tag, runningModels);
              const loading = readinessLoading !== null && m.tag.split(':')[0] === readinessLoading.split(':')[0];
              const isActive = m.tag.split(':')[0] === configuredTag.split(':')[0];
              return (
                <Box key={m.tag}>
                  <Text color={selected ? 'cyan' : 'gray'}>{selected ? '▸ ' : '  '}</Text>
                  <Text color={isActive ? 'white' : 'gray'} bold={isActive}>
                    {isActive ? '◉ ' : '○ '}
                    {m.label}
                  </Text>
                  <Text color={loading ? 'yellow' : running ? 'green' : 'gray'}>
                    {loading ? '  ⟳ loading...' : running ? '  ● running' : '  ○ on disk'}
                  </Text>
                  {isActive && (
                    <Text color="cyan"> (active)</Text>
                  )}
                </Box>
              );
            })}
            {extraTags.map(tag => {
              const idx = rowIdx++;
              const selected = idx === readinessSelectedIdx;
              const running = isModelRunning(tag, runningModels);
              const loading = readinessLoading !== null && tag.split(':')[0] === readinessLoading.split(':')[0];
              const isActive = tag.split(':')[0] === configuredTag.split(':')[0];
              return (
                <Box key={tag}>
                  <Text color={selected ? 'cyan' : 'gray'}>{selected ? '▸ ' : '  '}</Text>
                  <Text color={isActive ? 'white' : 'gray'} bold={isActive}>
                    {isActive ? '◉ ' : '○ '}
                    {tag}
                  </Text>
                  <Text color={loading ? 'yellow' : running ? 'green' : 'gray'}>
                    {loading ? '  ⟳ loading...' : running ? '  ● running' : '  ○ on disk'}
                  </Text>
                  {isActive && (
                    <Text color="cyan"> (active)</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {showAlternatives && status && status.alternatives.length > 0 && modelSource !== 'cloud' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">Pull a new model:</Text>
            <ModelSelectionTable
              models={status.alternatives}
              installedModels={status.installedModels}
              onSelect={(model) => onSelectAlternative({ value: model.tag })}
            />
          </Box>
        )}

        <Box marginTop={1}>
          <Text color="gray">
            {readinessMode.stats.requests} {readinessMode.stats.requests === 1 ? 'request' : 'requests'}   {formatTokensCompact(readinessMode.stats.tokens)} tokens
          </Text>
        </Box>
        <Box marginTop={1}>
          <KeyHints
            hints={[
              ...(modelSource !== 'cloud' ? [
                { key: 'j/k', label: 'Navigate' },
                { key: 'l', label: 'Load model' },
                { key: 'p', label: showAlternatives ? 'Hide options' : 'Pull new model' },
              ] : []),
              { key: 'c', label: modelSource === 'cloud' ? 'Local model' : 'Cloud model' },
              { key: 'Enter', label: showAlternatives ? 'Pull selected' : 'Continue' },
            ]}
          />
        </Box>
      </Box>
    );
  }

  if (!status) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Detecting your hardware...</Text>
      </Box>
    );
  }

  // Cloud mode: show cloud model info instead of Ollama selection
  if (modelSource === 'cloud') {
    return (
      <Box flexDirection="column">
        <Text bold>Your AI Model</Text>
        <Box marginTop={1}>
          <Text color="gray">{status.deviceSummary}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={cloudAuthStatus === 'authenticated' ? 'green' : 'magenta'} paddingX={2} paddingY={1}>
          <Box>
            <Text bold color="white">{formatCloudModelName(cloudModel)}</Text>
            {cloudAuthStatus === 'authenticated' ? (
              <Text color="green"> ✓ Connected</Text>
            ) : (
              <Text color="yellow"> ○ Not connected</Text>
            )}
          </Box>
          <Text color="gray">Anthropic Claude cloud model. No local download needed.</Text>
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <KeyHints
            hints={[
              { key: 'Enter', label: cloudAuthStatus === 'authenticated' ? 'Continue' : 'Connect' },
              { key: 'c', label: 'Local model' },
              { key: 'Esc', label: 'Back' },
            ]}
          />
        </Box>
      </Box>
    );
  }

  const hasInstalledModels = installedCatalogModels.length > 0 || allInstalledModels.length > 0;
  const selectedIsInstalled = selectedModel != null && isModelInstalled(selectedModel.tag, status.installedModels);
  // Other installed models the user could switch to (excluding currently selected)
  const otherInstalledModels = installedCatalogModels.filter(m => m.tag !== selectedModel?.tag);
  // Non-catalog installed models (not matched to any catalog entry)
  const catalogTags = new Set(installedCatalogModels.map(m => m.tag.split(':')[0]));
  const nonCatalogModels = allInstalledModels.filter(tag => !catalogTags.has(tag.split(':')[0]));

  return (
    <Box flexDirection="column">
      <Text bold>{hasInstalledModels ? 'Your AI Model' : 'Your First Model'}</Text>

      <Box marginTop={1}>
        <Text color="gray">{status.deviceSummary}</Text>
      </Box>

      {selectedModel && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={selectedIsInstalled ? 'green' : 'cyan'} paddingX={2} paddingY={1}>
          <Box>
            <Text bold color="white">{selectedModel.label}</Text>
            {selectedIsInstalled ? (
              <Text color="green"> ✓ Ready to use{isModelRunning(selectedModel.tag, runningModels) ? <Text color="green"> ● running</Text> : ''}</Text>
            ) : (
              <>
                {selectedModel.recommended && (
                  <Text color="cyan"> ★ Best for your machine</Text>
                )}
              </>
            )}
          </Box>
          <Text color="gray">{selectedModel.description}</Text>
          <Box marginTop={1}>
            {selectedIsInstalled ? (
              <Text color="gray">
                {selectedModel.sizeGB} GB · {selectedModel.features.join(', ')}
                {selectedModel.vision ? <Text color="cyan"> [vision]</Text> : ''}
              </Text>
            ) : (
              <Text color="gray">
                {selectedModel.sizeGB} GB download
                {' · '}~{estimateDownloadMinutes(selectedModel.sizeGB)} min
                {' · '}{selectedModel.features.join(', ')}
                {selectedModel.vision ? <Text color="cyan"> [vision]</Text> : ''}
              </Text>
            )}
          </Box>
        </Box>
      )}

      {/* Show other installed models the user can switch to */}
      {(otherInstalledModels.length > 0 || nonCatalogModels.length > 0) && !showAlternatives && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Also installed:</Text>
          {otherInstalledModels.map(m => (
            <Box key={m.tag}>
              <Text color="gray">  ✓ {m.label} ({m.sizeGB} GB)</Text>
              <Text color={isModelRunning(m.tag, runningModels) ? 'green' : 'gray'}> {isModelRunning(m.tag, runningModels) ? '● running' : '○ on disk'}</Text>
            </Box>
          ))}
          {nonCatalogModels.map(tag => (
            <Box key={tag}>
              <Text color="gray">  ✓ {tag}</Text>
              <Text color={isModelRunning(tag, runningModels) ? 'green' : 'gray'}> {isModelRunning(tag, runningModels) ? '● running' : '○ on disk'}</Text>
            </Box>
          ))}
          <Text color="gray" dimColor>  Press [a] to switch models</Text>
        </Box>
      )}

      {/* Show recommended upgrade if the recommendation isn't installed */}
      {hasInstalledModels && status.recommendation && !isModelInstalled(status.recommendation.tag, status.installedModels) && !showAlternatives && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">★ Recommended upgrade: {status.recommendation.label} ({status.recommendation.sizeGB} GB)</Text>
          <Text color="gray" dimColor>  Press [a] to see all options and download</Text>
        </Box>
      )}

      {showAlternatives && status.alternatives.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Other options:</Text>
          <ModelSelectionTable
            models={status.alternatives}
            installedModels={status.installedModels}
            onSelect={(model) => onSelectAlternative({ value: model.tag })}
          />
        </Box>
      )}

      {/* Vision availability note */}
      {selectedModel && !selectedModel.vision && !showAlternatives && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>For image analysis, pick a model with [vision] or add an Anthropic API key</Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Enter', label: selectedIsInstalled ? 'Use this model' : 'Download' },
            { key: 'a', label: showAlternatives ? 'Hide options' : 'Other options' },
            { key: 'c', label: 'Cloud model' },
            { key: 's', label: 'Skip' },
            { key: 'Esc', label: 'Back' },
          ]}
        />
      </Box>
    </Box>
  );
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function renderProgressBar(percent: number): string {
  const width = 30;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
}

const CLOUD_MODEL_LABELS: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
};

function formatCloudModelName(modelId: string): string {
  return CLOUD_MODEL_LABELS[modelId] || modelId;
}
