/**
 * Unified Onboarding Wizard
 * 4-step flow: Splash → Tier Choice → First Moment → Ready.
 * Auto-creates one general-purpose agent named after the business on first run.
 * Specialised agents are created post-onboarding from the TEAM screen.
 * Model selection is deferred to Settings (TRIO-10).
 * Replaces both setup-wizard.tsx and agent-setup-wizard.tsx.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { RuntimeConfig } from '../../config.js';
import { updateConfigFile, tryLoadConfig, DEFAULT_CLOUD_URL, resolveActiveWorkspace, portForWorkspace } from '../../config.js';
import { OnboardingService } from '../../lib/onboarding-service.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { OllamaModelInfo } from '../../lib/ollama-models.js';
import { MODEL_CATALOG } from '../../lib/ollama-models.js';
import {
  saveWorkspaceData,
  createAgentsFromPresets,
  type AgentToCreate,
} from '../../lib/onboarding-logic.js';
import { validateLicenseKey, LicenseValidationError, type LicenseValidationResult, type LicenseErrorKind } from '../../control-plane/validate-license.js';
import { openPath } from '../../lib/platform-utils.js';

import type { ModelSource } from '../../config.js';
import { validateAnthropicApiKey } from '../../lib/anthropic-auth.js';
import { SplashStep } from './onboarding/SplashStep.js';
import { CloudAuthStep } from './onboarding/CloudAuthStep.js';
import { FirstMomentStep } from './onboarding/FirstMomentStep.js';
import type { AgentHealthInfo } from './onboarding/AgentSelectionStep.js';
import { ReadyStep } from './onboarding/ReadyStep.js';
import { TierChoiceStep } from './onboarding/TierChoiceStep.js';

export interface ExistingWorkspaceState {
  businessName: string;
  businessType: string;
  modelName: string | null;
  modelTag: string | null;
  agents: AgentHealthInfo[];
  totalTasks: number;
  totalCostCents: number;
  totalTokens: number;
  totalRequests: number;
}

interface OnboardingWizardProps {
  onComplete: (config: RuntimeConfig) => void;
  onSkip?: () => void;
  db?: DatabaseAdapter;
  configDir?: string;
  /** When set, runs in returning-user mode with skipped steps and readiness data */
  existingState?: ExistingWorkspaceState;
  /** Override cloud URL for testing (defaults to DEFAULT_CLOUD_URL) */
  cloudUrl?: string;
}

type Step = 'splash' | 'tier_choice' | 'cloud_auth' | 'first_moment' | 'ready';

const STEP_NUMBERS: Record<Step, number> = {
  splash: 1,
  tier_choice: 2,
  cloud_auth: 3,
  first_moment: 3,
  ready: 4,
};


const service = new OnboardingService();

export function OnboardingWizard({ onComplete, onSkip, db, configDir, existingState, cloudUrl = DEFAULT_CLOUD_URL }: OnboardingWizardProps) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('splash');

  // Auto-complete when returning user lands on ready (only via download path)
  useEffect(() => {
    if (step === 'ready' && existingState) {
      completeReturningUser();
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select model from env on mount (model step removed; selection deferred to Settings)
  const [selectedModel] = useState<OllamaModelInfo | null>(() => {
    // If ANTHROPIC_API_KEY is set, prefer a cloud model entry from the catalog
    // (full selection deferred to Settings — TRIO-10).
    // For now we just pick the lightest catalog model as a sensible default.
    return MODEL_CATALOG.length > 0
      ? [...MODEL_CATALOG].sort((a, b) => a.sizeGB - b.sizeGB)[0]
      : null;
  });

  // First moment state (replaces BusinessInfo + FounderStage)
  const [businessName, setBusinessName] = useState('');
  const [firstTask, setFirstTask] = useState('');
  const [firstMomentField, setFirstMomentField] = useState<'businessName' | 'firstTask'>('businessName');

  // Kept for downstream compatibility (agent discovery, completeOnboarding, saveWorkspaceData)
  const businessType = 'saas_startup';
  const businessDescription = '';
  const founderPath = '';
  const founderFocus = '';

  // (Agent discovery/selection/integration steps removed in TRIO-04.
  //  Auto-agent creation happens in completeOnboarding().)
  // Connected local agents retained for returning-user display in ReadyStep
  const [connectedLocalAgents] = useState<AgentHealthInfo[] | null>(null);

  // Model source — read from config; can be updated in Settings (TRIO-10)
  const [modelSource] = useState<ModelSource>(() => {
    const configPath = configDir ? `${configDir}/config.json` : undefined;
    const existing = tryLoadConfig(configPath);
    return existing?.modelSource || 'local';
  });
  const [cloudAuthMode, setCloudAuthMode] = useState<'choose' | 'api_key' | 'oauth_waiting' | 'authenticated'>('choose');
  const [cloudAuthChoiceIdx, setCloudAuthChoiceIdx] = useState(0);
  const [anthropicKey, setAnthropicKey] = useState(() => {
    const configPath = configDir ? `${configDir}/config.json` : undefined;
    const existing = tryLoadConfig(configPath);
    return existing?.anthropicApiKey || '';
  });
  const openRouterKey = (() => {
    const configPath = configDir ? `${configDir}/config.json` : undefined;
    const existing = tryLoadConfig(configPath);
    return existing?.openRouterApiKey || '';
  })();
  const [cloudAuthValidating, setCloudAuthValidating] = useState(false);
  const [cloudAuthError, setCloudAuthError] = useState('');

  // Connected / tier choice state
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseValidating, setLicenseValidating] = useState(false);
  const [licenseError, setLicenseError] = useState('');
  const [licenseResult, setLicenseResult] = useState<LicenseValidationResult | null>(null);
  const [welcomeBack, setWelcomeBack] = useState<{ businessName: string } | null>(null);
  const [splashValidating, setSplashValidating] = useState(false);
  const [splashError, setSplashError] = useState('');
  const [splashErrorKind, setSplashErrorKind] = useState<LicenseErrorKind | ''>('');
  const isConnected = licenseResult !== null;

  // ── Effects ────────────────────────────────────────────────────────────

  // Auto-detect existing license key from config and validate it on splash
  useEffect(() => {
    if (step !== 'splash' || licenseResult || splashValidating) return;
    const configPath = configDir ? `${configDir}/config.json` : undefined;
    const existing = tryLoadConfig(configPath);
    if (!existing?.licenseKey) return;

    setLicenseKey(existing.licenseKey);
    setSplashValidating(true);
    validateLicenseKey(existing.licenseKey, cloudUrl)
      .then((result) => {
        setLicenseResult(result);
        setBusinessName(result.businessContext.businessName);
        setWelcomeBack({ businessName: result.businessContext.businessName });
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : 'Could not validate key';
        setSplashError(msg);
        setSplashErrorKind(err instanceof LicenseValidationError ? err.kind : 'unknown');
      })
      .finally(() => {
        setSplashValidating(false);
      });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Input Handling ─────────────────────────────────────────────────────

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'splash') { exit(); return; }
      if (existingState) {
        // Returning user: only splash step; tier_choice reached on validation failure
        if (step === 'tier_choice') { setSplashError(''); setSplashErrorKind(''); setStep('splash'); return; }
      } else if (isConnected) {
        // Connected user: splash → tier_choice → ready
        if (step === 'tier_choice') { setStep('splash'); return; }
        if (step === 'ready') { setStep('tier_choice'); return; }
      } else {
        // Free user: splash → tier_choice → first_moment → ready
        if (step === 'tier_choice') { setStep('splash'); return; }
        if (step === 'first_moment') { setStep('tier_choice'); return; }
        if (step === 'ready') { setStep('first_moment'); return; }
      }
    }

    // ── Splash ──
    if (step === 'splash') {
      if (splashError) {
        // Error state: offer recovery actions
        if (key.return && !splashValidating) {
          setStep('tier_choice');
          return;
        }
        if (input === 'l') {
          // Continue in local-only mode: clear license, preserve workspace data
          const configPath = configDir ? `${configDir}/config.json` : undefined;
          updateConfigFile({ tier: 'free', licenseKey: '' }, configPath);
          if (onSkip) { onSkip(); return; }
          const loaded = tryLoadConfig(configPath);
          if (loaded) onComplete(loaded);
          return;
        }
        if (input === 'd' && (splashErrorKind === 'expired' || splashErrorKind === 'device_conflict')) {
          openPath(`${cloudUrl}/dashboard`);
          return;
        }
        if (input === 'q') exit();
        return;
      }
      if (key.return && !splashValidating) {
        if (welcomeBack) {
          // Already validated: complete immediately, skip all onboarding steps
          completeReturningUser();
        } else {
          setStep('tier_choice');  // go to key entry
        }
        return;
      }
      if (input === 's' && onSkip) { onSkip(); return; }
      if (input === 'q') exit();
    }

    // ── Tier Choice ──
    if (step === 'tier_choice') {
      if (!licenseValidating) {
        if (key.return && licenseKey.trim()) {
          setLicenseValidating(true);
          setLicenseError('');
          validateLicenseKey(licenseKey.trim(), cloudUrl)
            .then((result) => {
              setLicenseResult(result);
              setBusinessName(result.businessContext.businessName);
              setLicenseValidating(false);
              // Go straight to ready for connected users (business data comes from cloud)
              setStep('ready');
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : 'Could not validate key';
              setLicenseError(msg);
              setLicenseValidating(false);
            });
        } else if (key.backspace || key.delete) {
          setLicenseKey(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setLicenseKey(prev => prev + input);
          setLicenseError('');
        }
      }
    }

    // ── Cloud Auth ──
    if (step === 'cloud_auth') {
      if (key.escape) {
        setCloudAuthMode('choose');
        setCloudAuthError('');
        setStep('tier_choice');
        return;
      }

      if (cloudAuthMode === 'choose') {
        if (input === 'j' || key.downArrow) setCloudAuthChoiceIdx(1);
        if (input === 'k' || key.upArrow) setCloudAuthChoiceIdx(0);
        if (key.return) {
          if (cloudAuthChoiceIdx === 0) {
            setCloudAuthMode('api_key');
          }
          // Index 1 = OAuth (coming soon, no-op)
        }
      } else if (cloudAuthMode === 'api_key' && !cloudAuthValidating) {
        if (key.return && anthropicKey.trim()) {
          setCloudAuthValidating(true);
          setCloudAuthError('');
          validateAnthropicApiKey(anthropicKey.trim())
            .then((valid) => {
              if (valid) {
                setCloudAuthMode('authenticated');
                // Auto-proceed after a brief pause
                setTimeout(() => {
                  if (existingState) {
                    completeReturningUser();
                  } else {
                    const nextAfterCloud = isConnected ? 'ready' : 'first_moment';
                    setStep(nextAfterCloud);
                  }
                }, 500);
              } else {
                setCloudAuthError('Invalid API key. Check and try again.');
              }
            })
            .catch(() => {
              setCloudAuthError('Could not validate key. Check your connection.');
            })
            .finally(() => setCloudAuthValidating(false));
        } else if (key.backspace || key.delete) {
          setAnthropicKey(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setAnthropicKey(prev => prev + input);
          setCloudAuthError('');
        }
      } else if (cloudAuthMode === 'authenticated') {
        if (key.return) {
          if (existingState) {
            completeReturningUser();
          } else {
            const nextAfterCloud = isConnected ? 'ready' : 'first_moment';
            setStep(nextAfterCloud);
          }
        }
      }
    }

    // ── First Moment ──
    if (step === 'first_moment') {
      if (firstMomentField === 'businessName') {
        if (key.return) {
          setFirstMomentField('firstTask');
        } else if (key.backspace || key.delete) {
          setBusinessName(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setBusinessName(prev => prev + input);
        }
      } else if (firstMomentField === 'firstTask') {
        if (key.return) {
          setStep('ready');
        } else if (key.backspace || key.delete) {
          setFirstTask(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setFirstTask(prev => prev + input);
        }
      }
    }

    // ── Ready ──
    if (step === 'ready' && key.return) {
      if (existingState) {
        completeReturningUser();
      } else if (isConnected) {
        completeConnectedOnboarding();
      } else {
        completeOnboarding();
      }
    }
  });

  // ── Completion ─────────────────────────────────────────────────────────

  const completeReturningUser = () => {
    const configPath = configDir ? `${configDir}/config.json` : undefined;
    // Merge model update into existing config (preserves licenseKey, tier, etc.)
    const configUpdates: Record<string, unknown> = {
      ollamaModel: existingState?.modelTag || selectedModel?.tag || 'qwen3:4b',
      onboardingComplete: true,
      modelSource,
    };
    if (modelSource === 'cloud' && anthropicKey) {
      configUpdates.anthropicApiKey = anthropicKey.trim();
    }
    updateConfigFile(configUpdates, configPath);
    const loaded = tryLoadConfig(configPath);
    if (!loaded) {
      // Fallback: config file is missing entirely, create a fresh one
      const fallback = service.saveFreeTierConfig(
        existingState?.modelTag || selectedModel?.tag || 'qwen3:4b',
        configPath,
      );
      onComplete(fallback);
      return;
    }
    onComplete(loaded);
  };

  const completeConnectedOnboarding = () => {
    if (!licenseResult) return;
    const modelTag = selectedModel?.tag || 'qwen3:4b';
    const configPath = configDir ? `${configDir}/config.json` : undefined;

    if (db) {
      (async () => {
        try {
          // Save cloud business data to local SQLite
          await saveWorkspaceData(db, 'local', {
            businessName: licenseResult.businessContext.businessName,
            businessType: licenseResult.businessContext.businessType,
            businessDescription: licenseResult.businessContext.businessDescription || '',
            founderPath: '',
            founderFocus: '',
          });

          // Create agents from cloud agent configs (skip if no cloud agents — local agents may already exist)
          if (licenseResult.agents.length > 0) {
            const cloudAgents: AgentToCreate[] = licenseResult.agents.map(a => ({
              id: a.id,
              name: a.name,
              role: a.role,
              description: a.description || '',
              systemPrompt: a.systemPrompt,
              tools: [],
            }));
            await createAgentsFromPresets(db, cloudAgents, 'local', modelTag);
          }

          // Save connected config
          updateConfigFile({
            licenseKey: licenseKey.trim(),
            onboardingComplete: true,
            agentSetupComplete: true,
            ollamaModel: modelTag,
            preferLocalModel: modelSource !== 'cloud',
            modelSource,
            ...(modelSource === 'cloud' && anthropicKey ? { anthropicApiKey: anthropicKey.trim() } : {}),
          }, configPath);

          const loaded = tryLoadConfig(configPath);
          if (loaded) {
            onComplete(loaded);
          } else {
            const config = service.saveFreeTierConfig(modelTag, configPath);
            onComplete(config);
          }
        } catch {
          // Fallback: save config only
          updateConfigFile({
            licenseKey: licenseKey.trim(),
            onboardingComplete: true,
            ollamaModel: modelTag,
          }, configPath);
          const loaded = tryLoadConfig(configPath);
          onComplete(loaded || service.saveFreeTierConfig(modelTag, configPath));
        }
      })();
    } else {
      // No DB: just save config
      updateConfigFile({
        licenseKey: licenseKey.trim(),
        onboardingComplete: true,
        agentSetupComplete: true,
        ollamaModel: modelTag,
      }, configPath);
      const loaded = tryLoadConfig(configPath);
      onComplete(loaded || service.saveFreeTierConfig(modelTag, configPath));
    }
  };

  const completeOnboarding = () => {
    // Auto-create one general-purpose agent named after the business.
    // Specialised agents are added post-onboarding from the TEAM screen.
    const agentName = businessName ? `${businessName} Agent` : 'My Agent';
    const autoAgent: AgentToCreate = {
      id: 'auto-agent-01',
      name: agentName,
      role: 'General',
      description: `General-purpose agent for ${businessName || 'your business'}`,
      systemPrompt: `You are ${agentName}, a general-purpose AI assistant. Your first task: ${firstTask || 'help the team be more productive'}.`,
      tools: [],
    };

    const modelTag = selectedModel?.tag || 'qwen3:4b';

    if (db) {
      // Save directly to SQLite (no API server dependency)
      (async () => {
        try {
          await saveWorkspaceData(db, 'local', {
            businessName,
            businessType,
            businessDescription,
            founderPath,
            founderFocus: firstTask,
          });
          await createAgentsFromPresets(db, [autoAgent], 'local', modelTag);

          // Update config file
          updateConfigFile({
            onboardingComplete: true,
            agentSetupComplete: true,
            ollamaModel: modelTag,
            preferLocalModel: modelSource !== 'cloud',
            modelSource,
            ...(modelSource === 'cloud' && anthropicKey ? { anthropicApiKey: anthropicKey.trim() } : {}),
          }, configDir ? `${configDir}/config.json` : undefined);

          const config = service.saveFreeTierConfig(modelTag, configDir ? `${configDir}/config.json` : undefined);
          onComplete(config);
        } catch {
          // Fallback: save config only
          const config = service.saveFreeTierConfig(modelTag, configDir ? `${configDir}/config.json` : undefined);
          onComplete(config);
        }
      })();
    } else {
      // Legacy path: call API server on the active workspace's port.
      const activePort = portForWorkspace(resolveActiveWorkspace().name);
      fetch(`http://127.0.0.1:${activePort}/api/onboarding/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelTag,
          businessName,
          businessType,
          businessDescription,
          founderPath,
          founderFocus: firstTask,
          agents: [autoAgent],
        }),
      }).then(async (res) => {
        if (!res.ok) throw new Error('API call failed');
        const { data } = await res.json() as { data: { config: RuntimeConfig } };
        onComplete(data.config);
      }).catch(() => {
        const config = service.saveFreeTierConfig(modelTag, configDir ? `${configDir}/config.json` : undefined);
        onComplete(config);
      });
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  const stepNum = STEP_NUMBERS[step];
  const totalSteps = 4;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Step indicator (hidden on splash) */}
      {step !== 'splash' && (
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {step === 'tier_choice' ? 'Setup' :
             step === 'cloud_auth' ? 'Cloud Auth' :
             step === 'first_moment' ? 'Your Business' :
             'Ready'}
          </Text>
          <Text color="gray"> | Step {stepNum} of {totalSteps}</Text>
        </Box>
      )}

      {/* Progress dots (hidden on splash) */}
      {step !== 'splash' && (
        <Box marginBottom={1}>
          {Array.from({ length: totalSteps }, (_, i) => i + 1).map(i => (
            <Text key={i} color={i < stepNum ? 'green' : i === stepNum ? 'cyan' : 'gray'}>
              {i < stepNum ? '●' : i === stepNum ? '◉' : '○'}{' '}
            </Text>
          ))}
        </Box>
      )}

      {/* Step content */}
      {step === 'splash' && (
        <SplashStep
          businessName={welcomeBack?.businessName ?? (splashValidating ? existingState?.businessName : undefined)}
          loading={splashValidating}
          error={splashError}
          errorKind={splashErrorKind || undefined}
        />
      )}

      {step === 'tier_choice' && (
        <TierChoiceStep
          licenseKey={licenseKey}
          validating={licenseValidating}
          error={licenseError}
        />
      )}

      {step === 'cloud_auth' && (
        <CloudAuthStep
          mode={cloudAuthMode}
          apiKeyInput={anthropicKey}
          validating={cloudAuthValidating}
          error={cloudAuthError}
          choiceIndex={cloudAuthChoiceIdx}
        />
      )}

      {step === 'first_moment' && (
        <FirstMomentStep
          businessName={businessName}
          firstTask={firstTask}
          activeField={firstMomentField}
        />
      )}

      {step === 'ready' && (
        <ReadyStep
          businessName={existingState?.businessName || businessName}
          selectedModel={selectedModel}
          agentCount={existingState?.agents.length || connectedLocalAgents?.length || 1}
          healthSummary={existingState ? {
            totalTasks: existingState.totalTasks,
            totalCostCents: existingState.totalCostCents,
            agentErrors: existingState.agents.filter(a => a.status === 'error').length,
            agentCount: existingState.agents.length,
            modelReady: !!existingState.modelName,
            modelName: existingState.modelName || undefined,
          } : undefined}
        />
      )}
    </Box>
  );
}
