/**
 * Local Model Wizard Screen
 * Guided setup for running AI locally with Ollama.
 * Detects hardware, recommends a Qwen model, installs Ollama if needed, pulls model.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { readFileSync, writeFileSync } from 'fs';
import { KeyHints } from '../components/key-hints.js';
import { ModelSelectionTable } from '../components/model-selection-table.js';
import { detectDevice, formatDeviceSummary } from '../../lib/device-info.js';
import type { DeviceInfo } from '../../lib/device-info.js';
import {
  recommendModels,
  bestModel,
  isModelInstalled,
} from '../../lib/ollama-models.js';
import type { OllamaModelInfo } from '../../lib/ollama-models.js';
import {
  isOllamaInstalled,
  isOllamaRunning,
  startOllama,
  installOllama,
  pullModel,
  listInstalledModels,
} from '../../lib/ollama-installer.js';
import { DEFAULT_CONFIG_PATH } from '../../config.js';

type WizardStep = 'detect' | 'recommend' | 'install_ollama' | 'start_ollama' | 'pull_model' | 'configure' | 'done';

const ALL_STEPS: WizardStep[] = ['detect', 'recommend', 'install_ollama', 'start_ollama', 'pull_model', 'configure', 'done'];

interface LocalModelWizardProps {
  configPath?: string;
  ollamaUrl?: string;
  onComplete: (model: string) => void;
  onCancel: () => void;
}

export function LocalModelWizard({ configPath, ollamaUrl = 'http://localhost:11434', onComplete, onCancel }: LocalModelWizardProps) {
  const [step, setStep] = useState<WizardStep>('detect');
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<OllamaModelInfo | null>(null);
  const [ollamaPresent, setOllamaPresent] = useState(false);
  const [ollamaReady, setOllamaReady] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [pullPercent, setPullPercent] = useState(0);
  const [pullStatus, setPullStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [installedModels, setInstalledModels] = useState<string[]>([]);

  // Visible steps (filter out skipped ones for progress display)
  const visibleSteps = ALL_STEPS.filter(s => {
    if (s === 'install_ollama' && ollamaPresent) return false;
    if (s === 'start_ollama' && ollamaReady) return false;
    return true;
  });

  const addLog = (line: string) => setLogLines(prev => [...prev.slice(-15), line]);

  // --- Step: detect ---
  useEffect(() => {
    if (step !== 'detect') return;
    const info = detectDevice();
    setDeviceInfo(info);
    const recommended = recommendModels(info);
    setModels(recommended);
    const best = bestModel(info);
    setSelectedModel(best);

    // Auto-check Ollama
    (async () => {
      const installed = await isOllamaInstalled();
      setOllamaPresent(installed);
      if (installed) {
        const running = await isOllamaRunning(ollamaUrl);
        setOllamaReady(running);
        if (running) {
          const models = await listInstalledModels(ollamaUrl);
          setInstalledModels(models);
        }
      }
    })();
  }, [step, ollamaUrl]);

  // --- Step: install_ollama ---
  useEffect(() => {
    if (step !== 'install_ollama' || busy) return;
    if (ollamaPresent) {
      // Skip to next step
      setStep('start_ollama');
      return;
    }

    setBusy(true);
    setLogLines([]);

    (async () => {
      try {
        for await (const line of installOllama(deviceInfo?.platform || 'unknown')) {
          addLog(line);
        }
        setOllamaPresent(true);
        addLog('Ollama installed successfully!');
        // Auto-advance after a brief pause
        setTimeout(() => setStep('start_ollama'), 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Install failed');
      } finally {
        setBusy(false);
      }
    })();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Step: start_ollama ---
  useEffect(() => {
    if (step !== 'start_ollama' || busy) return;

    setBusy(true);
    setLogLines([]);
    addLog('Checking if Ollama is running...');

    (async () => {
      try {
        const running = await isOllamaRunning(ollamaUrl);
        if (running) {
          addLog('Ollama is already running!');
          setOllamaReady(true);
          setTimeout(() => setStep('pull_model'), 500);
          return;
        }

        addLog('Starting Ollama server...');
        await startOllama();
        addLog('Ollama server is running!');
        setOllamaReady(true);
        setTimeout(() => setStep('pull_model'), 500);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start Ollama');
      } finally {
        setBusy(false);
      }
    })();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Step: pull_model ---
  useEffect(() => {
    if (step !== 'pull_model' || busy || !selectedModel) return;

    setBusy(true);
    setLogLines([]);
    setPullPercent(0);
    setPullStatus('Starting download...');

    (async () => {
      try {
        // Check if model is already pulled
        const installed = await listInstalledModels(ollamaUrl);
        if (installed.some(m => m.startsWith(selectedModel.tag.split(':')[0]) && m.includes(selectedModel.tag.split(':')[1] || ''))) {
          setPullStatus('Model already downloaded!');
          setPullPercent(100);
          setTimeout(() => setStep('configure'), 500);
          return;
        }

        for await (const progress of pullModel(selectedModel.tag)) {
          setPullStatus(progress.status);
          if (progress.percent !== undefined) {
            setPullPercent(progress.percent);
          }
        }
        setTimeout(() => setStep('configure'), 500);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Pull failed');
      } finally {
        setBusy(false);
      }
    })();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Step: configure ---
  useEffect(() => {
    if (step !== 'configure' || !selectedModel) return;

    // Update config file
    try {
      const cfgPath = configPath || DEFAULT_CONFIG_PATH;
      const raw = readFileSync(cfgPath, 'utf-8');
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      cfg.ollamaModel = selectedModel.tag;
      cfg.preferLocalModel = true;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      setTimeout(() => setStep('done'), 300);
    } catch (err) {
      setError(`Couldn't save config: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }, [step, selectedModel, configPath]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (step === 'detect' && key.return) {
      if (models.length > 0) {
        setStep('recommend');
      } else {
        setError('No compatible models found for your hardware');
      }
      return;
    }

    if (step === 'done' && key.return) {
      onComplete(selectedModel?.tag || 'qwen3:4b');
      return;
    }
  });

  const handleModelSelect = (item: { value: string }) => {
    const model = models.find(m => m.tag === item.value);
    if (model) {
      setSelectedModel(model);
      // Skip download entirely if model is already installed
      if (ollamaPresent && ollamaReady && isModelInstalled(model.tag, installedModels)) {
        setStep('configure');
      } else if (ollamaPresent && ollamaReady) {
        setStep('pull_model');
      } else if (ollamaPresent) {
        setStep('start_ollama');
      } else {
        setStep('install_ollama');
      }
    }
  };

  // Progress bar renderer
  const renderProgressBar = (percent: number) => {
    const width = 30;
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">Local AI Setup</Text>
        <Text color="gray"> | Step {visibleSteps.indexOf(step) + 1} of {visibleSteps.length}</Text>
      </Box>

      {/* Progress dots */}
      <Box marginBottom={1}>
        {visibleSteps.map((s, i) => {
          const currentIdx = visibleSteps.indexOf(step);
          return (
            <Text key={s} color={i < currentIdx ? 'green' : i === currentIdx ? 'cyan' : 'gray'}>
              {i < currentIdx ? '●' : i === currentIdx ? '◉' : '○'}{' '}
            </Text>
          );
        })}
      </Box>

      {/* Step content */}
      {step === 'detect' && deviceInfo && (
        <Box flexDirection="column">
          <Text bold>Hardware Detection</Text>
          <Box flexDirection="column" marginTop={1}>
            {formatDeviceSummary(deviceInfo).map((line, i) => (
              <Text key={i} color="gray">  {line}</Text>
            ))}
          </Box>
          {models.length > 0 && (
            <Box marginTop={1}>
              <Text color="green">
                Found {models.length} compatible model{models.length === 1 ? '' : 's'}. Best pick: <Text bold>{selectedModel?.label}</Text>
              </Text>
            </Box>
          )}
          {models.length === 0 && (
            <Box marginTop={1}>
              <Text color="red">
                Not enough RAM for local models. You need at least 4 GB.
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to choose a model, <Text bold color="white">Esc</Text> to cancel.</Text>
          </Box>
        </Box>
      )}

      {step === 'recommend' && (
        <Box flexDirection="column">
          <Text bold>Choose a Model</Text>
          <Text color="gray">Pick the model to download. Larger models are smarter but use more RAM.</Text>
          <Text color="gray" dimColor>Models with [vision] can analyze images and documents. Models with [audio] can transcribe and understand speech.</Text>
          <Box flexDirection="column" marginTop={1}>
            <ModelSelectionTable
              models={models}
              installedModels={installedModels}
              onSelect={(model) => handleModelSelect({ value: model.tag })}
            />
          </Box>
        </Box>
      )}

      {step === 'install_ollama' && (
        <Box flexDirection="column">
          <Text bold>Installing Ollama</Text>
          <Box flexDirection="column" marginTop={1}>
            {logLines.map((line, i) => (
              <Text key={i} color="gray">{line}</Text>
            ))}
            {busy && <Text color="yellow">Installing...</Text>}
          </Box>
        </Box>
      )}

      {step === 'start_ollama' && (
        <Box flexDirection="column">
          <Text bold>Starting Ollama</Text>
          <Box flexDirection="column" marginTop={1}>
            {logLines.map((line, i) => (
              <Text key={i} color="gray">{line}</Text>
            ))}
            {busy && <Text color="yellow">Starting server...</Text>}
          </Box>
        </Box>
      )}

      {step === 'pull_model' && selectedModel && (
        <Box flexDirection="column">
          <Text bold>Downloading {selectedModel.label}</Text>
          <Text color="gray">{selectedModel.tag} ({selectedModel.sizeGB} GB)</Text>
          <Box marginTop={1}>
            <Text color="cyan">{renderProgressBar(pullPercent)}</Text>
          </Box>
          <Text color="gray">{pullStatus}</Text>
        </Box>
      )}

      {step === 'configure' && (
        <Box flexDirection="column">
          <Text bold color="yellow">Saving configuration...</Text>
        </Box>
      )}

      {step === 'done' && selectedModel && (
        <Box flexDirection="column">
          <Text bold color="green">Local AI is ready!</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">  Model:     <Text color="white">{selectedModel.label}</Text> ({selectedModel.tag})</Text>
            <Text color="gray">  Size:      <Text color="white">{selectedModel.sizeGB} GB</Text></Text>
            <Text color="gray">  Features:  <Text color="white">{selectedModel.features.join(', ')}</Text></Text>
            <Text color="gray">  Preferred: <Text color="green">Yes</Text> (local model will be used for routine tasks)</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to finish.</Text>
          </Box>
        </Box>
      )}

      {/* Error display */}
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {/* Key hints */}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Esc', label: 'Cancel' },
            ...(step === 'detect' ? [{ key: 'Enter', label: 'Continue' }] : []),
            ...(step === 'done' ? [{ key: 'Enter', label: 'Finish' }] : []),
          ]}
        />
      </Box>
    </Box>
  );
}
