/**
 * Unified Onboarding Wizard
 * 8-step flow: Splash → Tier Choice → Model → Business Info → Founder Stage →
 * Agent Discovery → Agent Selection → Ready.
 * Connected path: Splash → Tier Choice → Model → Agent Selection → Ready
 * (business info + founder stage + agent discovery are skipped, data comes from cloud).
 * Replaces both setup-wizard.tsx and agent-setup-wizard.tsx.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { RuntimeConfig } from '../../config.js';
import { updateConfigFile, tryLoadConfig, DEFAULT_CLOUD_URL, resolveActiveWorkspace, portForWorkspace } from '../../config.js';
import { OnboardingService } from '../../lib/onboarding-service.js';
import type { OnboardingStatus } from '../../lib/onboarding-service.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { OllamaModelInfo } from '../../lib/ollama-models.js';
import { isModelInstalled, MODEL_CATALOG } from '../../lib/ollama-models.js';
import { loadModel, listRunningModels, listInstalledModels } from '../../lib/ollama-installer.js';
import { BUSINESS_TYPES, type AgentPreset } from '../data/agent-presets.js';
import {
  FOUNDER_PATHS,
  getPresetsForBusinessType,
  getStaticRecommendations,
  parseAgentRecommendations,
  buildAgentDiscoveryPrompt,
  presetToAgent,
  saveWorkspaceData,
  createAgentsFromPresets,
  collectRequiredMcpServers,
  configureMcpServersForAgents,
  type AgentToCreate,
} from '../../lib/onboarding-logic.js';
import { MCP_SERVER_CATALOG } from '../../mcp/catalog.js';
import { validateLicenseKey, LicenseValidationError, type LicenseValidationResult, type LicenseErrorKind } from '../../control-plane/validate-license.js';
import { openPath } from '../../lib/platform-utils.js';

import type { ModelSource } from '../../config.js';
import { validateAnthropicApiKey } from '../../lib/anthropic-auth.js';
import { SplashStep } from './onboarding/SplashStep.js';
import { ModelStep } from './onboarding/ModelStep.js';
import { CloudAuthStep } from './onboarding/CloudAuthStep.js';
import { BusinessInfoStep } from './onboarding/BusinessInfoStep.js';
import { FounderStageStep } from './onboarding/FounderStageStep.js';
import { AgentDiscoveryStep } from './onboarding/AgentDiscoveryStep.js';
import { AgentSelectionStep } from './onboarding/AgentSelectionStep.js';
import type { AgentHealthInfo } from './onboarding/AgentSelectionStep.js';
import { ReadyStep } from './onboarding/ReadyStep.js';
import { TierChoiceStep } from './onboarding/TierChoiceStep.js';
import { IntegrationSetupStep, type IntegrationInput } from './onboarding/IntegrationSetupStep.js';

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

type Step = 'splash' | 'tier_choice' | 'model' | 'cloud_auth' | 'downloading' | 'business_info' | 'founder_stage' | 'agent_discovery' | 'agent_selection' | 'integration_setup' | 'ready';

const STEP_NUMBERS: Record<Step, number> = {
  splash: 1,
  tier_choice: 2,
  model: 3,
  cloud_auth: 3,
  downloading: 3,
  business_info: 4,
  founder_stage: 5,
  agent_discovery: 6,
  agent_selection: 7,
  integration_setup: 8,
  ready: 9,
};

/** Step numbering for returning users (splash → model → complete) */
const RETURNING_STEP_NUMBERS: Partial<Record<Step, number>> = {
  splash: 1,
  model: 2,
  cloud_auth: 2,
  downloading: 2,
};

/** Step numbering for connected path (splash → tier choice → model → agents → ready) */
const CONNECTED_STEP_NUMBERS: Partial<Record<Step, number>> = {
  splash: 1,
  tier_choice: 2,
  model: 3,
  downloading: 3,
  agent_selection: 4,
  ready: 5,
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

  // Model state
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState<OllamaModelInfo | null>(null);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadMessage, setDownloadMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Business info state
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [businessDescription, setBusinessDescription] = useState('');
  const [businessField, setBusinessField] = useState<'name' | 'type' | 'description'>('name');
  const [businessTypeIndex, setBusinessTypeIndex] = useState(0);

  // Founder stage state
  const [founderPath, setFounderPath] = useState('');
  const [founderFocus, setFounderFocus] = useState('');
  const [founderField, setFounderField] = useState<'path' | 'focus'>('path');
  const [founderPathIndex, setFounderPathIndex] = useState(0);

  // Agent discovery state
  const [modelAvailable, setModelAvailable] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatStreaming, setChatStreaming] = useState(false);
  const [discoveredAgentIds, setDiscoveredAgentIds] = useState<string[]>([]);

  // Agent selection state
  const [allPresets, setAllPresets] = useState<AgentPreset[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [selectionCursor, setSelectionCursor] = useState(0);

  // Connected local agents (when cloud provides none but DB has agents)
  const [connectedLocalAgents, setConnectedLocalAgents] = useState<AgentHealthInfo[] | null>(null);
  // Connected empty state (no cloud agents, no local agents)
  const [connectedNoAgents, setConnectedNoAgents] = useState(false);

  // Integration setup state
  const [integrationInputs, setIntegrationInputs] = useState<IntegrationInput[]>([]);
  const [integrationIndex, setIntegrationIndex] = useState(0);
  const [integrationEnvIndex, setIntegrationEnvIndex] = useState(0);
  const [integrationValue, setIntegrationValue] = useState('');
  const [integrationSkipped, setIntegrationSkipped] = useState<Set<string>>(new Set());

  // Installed models matched to catalog entries
  const [installedCatalogModels, setInstalledCatalogModels] = useState<OllamaModelInfo[]>([]);

  // Readiness mode navigation + load state
  const [readinessIdx, setReadinessIdx] = useState(0);
  const [readinessLoading, setReadinessLoading] = useState<string | null>(null);
  const [readinessPulling, setReadinessPulling] = useState(false);

  // Cloud/local model source state
  const [modelSource, setModelSource] = useState<ModelSource>(() => {
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
  const configCloudProvider = (() => {
    const configPath = configDir ? `${configDir}/config.json` : undefined;
    const existing = tryLoadConfig(configPath);
    return existing?.cloudProvider || 'anthropic';
  })();
  const configCloudModel = (() => {
    const configPath = configDir ? `${configDir}/config.json` : undefined;
    const existing = tryLoadConfig(configPath);
    return existing?.cloudModel || existing?.openRouterModel || 'claude-haiku-4-5-20251001';
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
        setBusinessType(result.businessContext.businessType);
        setBusinessDescription(result.businessContext.businessDescription || '');
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

  // Auto-skip steps for connected users (business data comes from cloud)
  useEffect(() => {
    if (!isConnected || existingState) return;
    if (step === 'business_info' || step === 'founder_stage' || step === 'agent_discovery') {
      setStep('agent_selection');
    }
  }, [step, isConnected, existingState]);

  // Initialize device detection when moving to model step
  useEffect(() => {
    if (step !== 'model' || status) return;
    (async () => {
      try {
        const s = await service.initialize();
        setStatus(s);

        // Match installed models to catalog entries
        const installedCatalog = s.installedModels.length > 0
          ? MODEL_CATALOG.filter(m => isModelInstalled(m.tag, s.installedModels))
          : [];
        setInstalledCatalogModels(installedCatalog);

        if (installedCatalog.length > 0) {
          // Auto-select best installed model: prefer the recommendation if installed, else largest installed catalog model
          const recommendedInstalled = installedCatalog.find(m => m.tag === s.recommendation?.tag);
          const bestInstalled = recommendedInstalled || [...installedCatalog].sort((a, b) => b.sizeGB - a.sizeGB)[0];
          setSelectedModel(bestInstalled);
        } else {
          setSelectedModel(s.recommendation);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not detect hardware');
      }
    })();
  }, [step, status]);

  // Periodically refresh installed/running models while on the model step
  useEffect(() => {
    if (step !== 'model') return;
    const interval = setInterval(async () => {
      try {
        const installed = await listInstalledModels();
        const running = await listRunningModels();
        setStatus(prev => prev ? { ...prev, installedModels: installed, runningModels: running } : prev);
        const catalogMatches = installed.length > 0
          ? MODEL_CATALOG.filter(m => isModelInstalled(m.tag, installed))
          : [];
        setInstalledCatalogModels(catalogMatches);
      } catch { /* ignore refresh errors */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [step]);

  // Handle download step
  useEffect(() => {
    if (step !== 'downloading' || busy || !selectedModel) return;
    setBusy(true);
    setDownloadPercent(0);
    setDownloadMessage('Setting things up...');

    (async () => {
      try {
        for await (const progress of service.ensureOllama()) {
          setDownloadMessage(progress.message);
          if (progress.error) { setError(progress.error); setBusy(false); return; }
        }

        setDownloadMessage('Starting download...');
        for await (const progress of service.downloadModel(selectedModel.tag)) {
          setDownloadMessage(progress.message);
          if (progress.percent !== undefined) setDownloadPercent(progress.percent);
          if (progress.error) { setError(progress.error); setBusy(false); return; }
        }

        setDownloadPercent(100);
        setDownloadMessage('Download complete');
        setBusy(false);
        setModelAvailable(true);
        if (readinessPulling) {
          // Return to model step after pull completes in readiness mode
          setReadinessPulling(false);
          setShowAlternatives(false);
          setTimeout(() => setStep('model'), 500);
        } else {
          setTimeout(() => setStep(existingState ? 'ready' : isConnected ? 'agent_selection' : 'business_info'), 500);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Download failed');
        setBusy(false);
      }
    })();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // When entering agent discovery, check model availability and load presets
  useEffect(() => {
    if (step !== 'agent_discovery') return;
    const presets = getPresetsForBusinessType(businessType || 'saas_startup');
    setAllPresets(presets);

    // Check model availability
    if (selectedModel) {
      (async () => {
        try {
          const ollamaUrl = 'http://localhost:11434';
          const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            const data = await res.json() as { models: Array<{ name: string }> };
            const modelBase = selectedModel.tag.split(':')[0];
            const hasModel = data.models?.some((m: { name: string }) => m.name.startsWith(modelBase)) ?? false;
            setModelAvailable(hasModel);

            // If model available and no messages yet, start with a greeting
            if (hasModel && chatMessages.length === 0) {
              sendAIMessage([]);
            }
          }
        } catch {
          setModelAvailable(false);
        }
      })();
    }

    // Pre-check recommended agents for selection
    if (!modelAvailable) {
      const recommended = getStaticRecommendations(businessType || 'saas_startup');
      setSelectedAgentIds(new Set(recommended.map(a => a.id)));
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // When entering agent selection, set up presets
  useEffect(() => {
    if (step !== 'agent_selection') return;

    // Connected path: use cloud agents or fall back to local DB agents
    if (isConnected && licenseResult) {
      if (licenseResult.agents.length > 0) {
        // Cloud agents exist — convert to AgentPreset[] for display
        const cloudPresets: AgentPreset[] = licenseResult.agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          description: a.description || '',
          systemPrompt: a.systemPrompt,
          tools: a.config.web_search_enabled ? ['web_research'] : [],
          recommended: true,
        }));
        setAllPresets(cloudPresets);
        setSelectedAgentIds(new Set(cloudPresets.map(a => a.id)));
        setConnectedLocalAgents(null);
        setConnectedNoAgents(false);
      } else if (db) {
        // No cloud agents — check local DB for existing agents
        (async () => {
          try {
            // Resolve the workspace row id positionally. The seed is 'local'
            // until cloud consolidation rewrites it to the workspace UUID, so
            // hardcoding 'local' hides agents on cloud-connected workspaces.
            const wsResult = await db.from<{ id: string }>('agent_workforce_workspaces')
              .select('id')
              .limit(1)
              .maybeSingle();
            const wsId = wsResult.data?.id;
            if (!wsId) {
              setConnectedLocalAgents(null);
              setConnectedNoAgents(true);
              return;
            }
            const result = await db.from('agent_workforce_agents')
              .select('id, name, role, description, status, stats')
              .eq('workspace_id', wsId);
            const rows = (result.data || []) as Array<{
              id: string; name: string; role: string;
              description: string; status: string; stats: string;
            }>;
            if (rows.length > 0) {
              const healthInfo: AgentHealthInfo[] = rows.map(r => {
                let taskCount = 0;
                let costCents = 0;
                try {
                  const s = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats;
                  taskCount = s?.task_count || 0;
                  costCents = s?.total_cost_cents || 0;
                } catch { /* ignore */ }
                return {
                  name: r.name,
                  role: r.role,
                  status: (r.status === 'working' ? 'working' : r.status === 'error' ? 'error' : 'idle') as AgentHealthInfo['status'],
                  taskCount,
                  costCents,
                };
              });
              setConnectedLocalAgents(healthInfo);
              setConnectedNoAgents(false);
            } else {
              setConnectedLocalAgents(null);
              setConnectedNoAgents(true);
            }
          } catch {
            setConnectedLocalAgents(null);
            setConnectedNoAgents(true);
          }
        })();
      } else {
        setConnectedLocalAgents(null);
        setConnectedNoAgents(true);
      }
      setSelectionCursor(0);
      return;
    }

    // Free tier: existing logic unchanged
    const presets = getPresetsForBusinessType(businessType || 'saas_startup');
    setAllPresets(presets);

    // Pre-select based on discovery
    if (discoveredAgentIds.length > 0) {
      setSelectedAgentIds(new Set(discoveredAgentIds.filter(id => presets.some(p => p.id === id))));
    } else if (selectedAgentIds.size === 0) {
      const recommended = getStaticRecommendations(businessType || 'saas_startup');
      setSelectedAgentIds(new Set(recommended.map(a => a.id)));
    }
    setSelectionCursor(0);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── AI Chat ────────────────────────────────────────────────────────────

  const sendAIMessage = async (history: Array<{ role: 'user' | 'assistant'; content: string }>) => {
    setChatStreaming(true);
    try {
      const presets = getPresetsForBusinessType(businessType || 'saas_startup');
      const systemPrompt = buildAgentDiscoveryPrompt(
        businessType || 'saas_startup',
        founderPath || 'exploring',
        founderFocus || '',
        presets,
      );

      const ollamaUrl = 'http://localhost:11434';
      const ollamaModel = selectedModel?.tag || 'qwen3:4b';

      const ollamaMessages = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ];

      const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages: ollamaMessages,
          max_tokens: 1024,
          temperature: 0.7,
          stream: false,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) throw new Error('Model not responding');

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      const content = data.choices?.[0]?.message?.content || 'I can help you pick the right agents. What are your biggest priorities right now?';

      setChatMessages(prev => [...prev, { role: 'assistant', content }]);

      // Try to parse agent recommendations from the response
      const agentIds = parseAgentRecommendations(content);
      if (agentIds.length > 0) {
        setDiscoveredAgentIds(agentIds);
        setSelectedAgentIds(new Set(agentIds.filter(id => presets.some(p => p.id === id))));
      }
    } catch {
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: 'I ran into an issue connecting to the model. You can pick your agents manually on the next screen.',
      }]);
    } finally {
      setChatStreaming(false);
    }
  };

  // ── Input Handling ─────────────────────────────────────────────────────

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'splash') { exit(); return; }
      if (existingState) {
        // Returning user: only splash and model steps exist (tier_choice reached on validation failure)
        if (step === 'tier_choice') { setSplashError(''); setSplashErrorKind(''); setStep('splash'); return; }
        if (step === 'model') { setStep('splash'); return; }
      } else if (isConnected) {
        // Connected user: skip business/founder/discovery steps on back nav too
        if (step === 'tier_choice') { setStep('splash'); return; }
        if (step === 'model') { setStep('tier_choice'); return; }
        if (step === 'agent_selection') { setStep('model'); return; }
        if (step === 'ready') { setStep('agent_selection'); return; }
      } else {
        if (step === 'tier_choice') { setStep('splash'); return; }
        if (step === 'model') { setStep('tier_choice'); return; }
        if (step === 'business_info') { setStep('model'); return; }
        if (step === 'founder_stage') { setStep('business_info'); return; }
        if (step === 'agent_discovery') { setStep('founder_stage'); return; }
        if (step === 'agent_selection') { setStep('agent_discovery'); return; }
        if (step === 'integration_setup') { setStep('agent_selection'); return; }
        if (step === 'ready') {
          // Go back to integration_setup if we had integrations, else agent_selection
          if (integrationInputs.length > 0) { setStep('integration_setup'); return; }
          setStep('agent_selection'); return;
        }
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
          setStep('model');  // already validated, skip key entry
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
              setBusinessType(result.businessContext.businessType);
              setBusinessDescription(result.businessContext.businessDescription || '');
              setLicenseValidating(false);
              setStep('model');
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

    // ── Model ──
    if (step === 'model' && !busy) {
      // Cycle model source with 'c' key: local → cloud → claude-code → local
      if (input === 'c') {
        setModelSource(prev => prev === 'local' ? 'cloud' : prev === 'cloud' ? 'claude-code' : 'local');
        return;
      }

      if (existingState?.modelName) {
        // Readiness mode
        if (modelSource === 'claude-code') {
          // Claude Code readiness: Enter to continue (no auth needed)
          if (key.return) completeReturningUser();
        } else if (modelSource === 'cloud') {
          // Cloud readiness: Enter to continue (skip model list navigation)
          if (key.return) {
            if (anthropicKey || openRouterKey) {
              completeReturningUser();
            } else {
              setCloudAuthMode('choose');
              setStep('cloud_auth');
            }
          }
        } else {
          // Local readiness: navigate, load, or continue
          const catalogBases = new Set(installedCatalogModels.map(m => m.tag.split(':')[0]));
          const extras = (status?.installedModels || []).filter(t => !catalogBases.has(t.split(':')[0]));
          const totalModels = installedCatalogModels.length + extras.length;

          if (input === 'j' || key.downArrow) {
            setReadinessIdx(i => Math.min(i + 1, totalModels - 1));
          }
          if (input === 'k' || key.upArrow) {
            setReadinessIdx(i => Math.max(i - 1, 0));
          }
          if (input === 'l' && !readinessLoading && totalModels > 0) {
            const tag = readinessIdx < installedCatalogModels.length
              ? installedCatalogModels[readinessIdx].tag
              : extras[readinessIdx - installedCatalogModels.length];
            const tagBase = tag.split(':')[0];
            const tagVariant = tag.split(':')[1] || '';
            const alreadyRunning = (status?.runningModels || []).some(r => {
              const rBase = r.split(':')[0];
              const rVariant = r.split(':')[1] || '';
              return rBase === tagBase && (tagVariant === '' || rVariant === tagVariant);
            });
            if (!alreadyRunning && tag) {
              setReadinessLoading(tag);
              loadModel(tag)
                .then(() => listRunningModels())
                .then(running => {
                  if (status) {
                    setStatus({ ...status, runningModels: running });
                  }
                })
                .catch(() => { /* ignore load errors */ })
                .finally(() => setReadinessLoading(null));
            }
          }
          if (input === 'a' || input === 'p') setShowAlternatives(!showAlternatives);
          if (key.return && !showAlternatives) completeReturningUser();
        }
      } else {
        // New user model step
        if (modelSource === 'claude-code') {
          // Claude Code mode: Enter → proceed immediately (no auth needed)
          if (key.return) {
            const nextAfterModel = isConnected ? 'agent_selection' : 'business_info';
            setStep(nextAfterModel);
          }
        } else if (modelSource === 'cloud') {
          // Cloud mode: Enter → show auth if not authenticated, else proceed
          if (key.return) {
            if (anthropicKey || openRouterKey) {
              const nextAfterModel = isConnected ? 'agent_selection' : 'business_info';
              setStep(nextAfterModel);
            } else {
              setCloudAuthMode('choose');
              setStep('cloud_auth');
            }
          }
        } else {
          // Local mode: existing Ollama flow
          const nextAfterModel = isConnected ? 'agent_selection' : 'business_info';
          if (key.return && selectedModel) {
            if (status?.installedModels.length && isModelInstalled(selectedModel.tag, status.installedModels)) {
              setModelAvailable(true);
              setStep(nextAfterModel);
            } else {
              setStep('downloading');
            }
          }
          if (input === 'a') setShowAlternatives(!showAlternatives);
          if (input === 's') {
            setSelectedModel(null);
            setModelAvailable(false);
            setStep(nextAfterModel);
          }
        }
      }
    }

    // ── Cloud Auth ──
    if (step === 'cloud_auth') {
      if (key.escape) {

        setCloudAuthMode('choose');
        setCloudAuthError('');
        setStep('model');
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
                    const nextAfterModel = isConnected ? 'agent_selection' : 'business_info';
                    setStep(nextAfterModel);
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
            const nextAfterModel = isConnected ? 'agent_selection' : 'business_info';
            setStep(nextAfterModel);
          }
        }
      }
    }

    // ── Business Info ──
    if (step === 'business_info') {
      if (businessField === 'name') {
        if (key.return) {
          setBusinessField('type');
        } else if (key.backspace || key.delete) {
          setBusinessName(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setBusinessName(prev => prev + input);
        }
      } else if (businessField === 'type') {
        if (input === 'j' || key.downArrow) {
          setBusinessTypeIndex(i => Math.min(i + 1, BUSINESS_TYPES.length - 1));
        }
        if (input === 'k' || key.upArrow) {
          setBusinessTypeIndex(i => Math.max(i - 1, 0));
        }
        if (key.return) {
          setBusinessType(BUSINESS_TYPES[businessTypeIndex].id);
          setBusinessField('description');
        }
      } else if (businessField === 'description') {
        if (key.return) {
          setStep('founder_stage');
          setFounderField('path');
        } else if (key.backspace || key.delete) {
          setBusinessDescription(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setBusinessDescription(prev => prev + input);
        }
      }
    }

    // ── Founder Stage ──
    if (step === 'founder_stage') {
      if (founderField === 'path') {
        if (input === 'j' || key.downArrow) {
          setFounderPathIndex(i => Math.min(i + 1, FOUNDER_PATHS.length - 1));
        }
        if (input === 'k' || key.upArrow) {
          setFounderPathIndex(i => Math.max(i - 1, 0));
        }
        if (key.return) {
          setFounderPath(FOUNDER_PATHS[founderPathIndex].id);
          setFounderField('focus');
        }
      } else if (founderField === 'focus') {
        if (key.return) {
          setStep('agent_discovery');
        } else if (key.backspace || key.delete) {
          setFounderFocus(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setFounderFocus(prev => prev + input);
        }
      }
    }

    // ── Agent Discovery ──
    if (step === 'agent_discovery') {
      if (!modelAvailable) {
        // No model: just press enter to continue
        if (key.return) setStep('agent_selection');
      } else {
        if (key.tab) {
          // Skip chat and go to selection
          setStep('agent_selection');
        } else if (key.return && !chatStreaming) {
          if (chatMessages.length >= 4 || discoveredAgentIds.length > 0) {
            // Enough chat or already got recommendations
            setStep('agent_selection');
          } else if (chatInput.trim()) {
            // Send message
            const userMsg = { role: 'user' as const, content: chatInput.trim() };
            const newHistory = [...chatMessages, userMsg];
            setChatMessages(newHistory);
            setChatInput('');
            sendAIMessage(newHistory);
          }
        } else if (!chatStreaming && input && !key.ctrl && !key.meta && !key.tab) {
          if (key.backspace || key.delete) {
            setChatInput(prev => prev.slice(0, -1));
          } else {
            setChatInput(prev => prev + input);
          }
        }
      }
    }

    // ── Agent Selection ──
    if (step === 'agent_selection') {
      if (existingState) {
        // Readiness mode: Enter to continue
        if (key.return) setStep('ready');
      } else if (isConnected && (connectedLocalAgents !== null || connectedNoAgents)) {
        // Connected readonly/empty: Enter to continue
        if (key.return) setStep('ready');
      } else {
        if (input === 'j' || key.downArrow) {
          setSelectionCursor(i => Math.min(i + 1, allPresets.length - 1));
        }
        if (input === 'k' || key.upArrow) {
          setSelectionCursor(i => Math.max(i - 1, 0));
        }
        if (input === ' ') {
          const agentId = allPresets[selectionCursor]?.id;
          if (agentId) {
            setSelectedAgentIds(prev => {
              const next = new Set(prev);
              if (next.has(agentId)) next.delete(agentId);
              else next.add(agentId);
              return next;
            });
          }
        }
        if (key.return && selectedAgentIds.size > 0) {
          // Check if selected agents need MCP integrations
          const selected = allPresets.filter(p => selectedAgentIds.has(p.id));
          const requiredMcp = collectRequiredMcpServers(selected);
          if (requiredMcp.length > 0) {
            // Set up integration inputs
            const inputs: IntegrationInput[] = requiredMcp
              .map(id => MCP_SERVER_CATALOG.find(s => s.id === id))
              .filter((s): s is NonNullable<typeof s> => !!s)
              .map(server => ({ server, envValues: {} }));
            setIntegrationInputs(inputs);
            setIntegrationIndex(0);
            setIntegrationEnvIndex(0);
            setIntegrationValue('');
            setIntegrationSkipped(new Set());
            setStep('integration_setup');
          } else {
            setStep('ready');
          }
        }
      }
    }

    // ── Integration Setup ──
    if (step === 'integration_setup') {
      const current = integrationInputs[integrationIndex];
      if (!current) {
        if (key.return) setStep('ready');
        return;
      }

      const currentEnvVar = current.server.envVarsRequired[integrationEnvIndex];

      if (input === 's' && !integrationSkipped.has(current.server.id)) {
        // Skip this integration
        setIntegrationSkipped(prev => new Set([...prev, current.server.id]));
        if (integrationIndex < integrationInputs.length - 1) {
          setIntegrationIndex(i => i + 1);
          setIntegrationEnvIndex(0);
          setIntegrationValue('');
        } else {
          setStep('ready');
        }
        return;
      }

      if (key.return && integrationValue.trim() && currentEnvVar) {
        // Save this env value
        setIntegrationInputs(prev => {
          const next = [...prev];
          next[integrationIndex] = {
            ...next[integrationIndex],
            envValues: { ...next[integrationIndex].envValues, [currentEnvVar.key]: integrationValue.trim() },
          };
          return next;
        });
        setIntegrationValue('');

        // Move to next env var or next integration
        if (integrationEnvIndex < current.server.envVarsRequired.length - 1) {
          setIntegrationEnvIndex(i => i + 1);
        } else if (integrationIndex < integrationInputs.length - 1) {
          setIntegrationIndex(i => i + 1);
          setIntegrationEnvIndex(0);
        } else {
          setStep('ready');
        }
      } else if (key.return && !currentEnvVar) {
        // No more env vars for this integration
        if (integrationIndex < integrationInputs.length - 1) {
          setIntegrationIndex(i => i + 1);
          setIntegrationEnvIndex(0);
          setIntegrationValue('');
        } else {
          setStep('ready');
        }
      } else if (key.backspace || key.delete) {
        setIntegrationValue(prev => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setIntegrationValue(prev => prev + input);
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
    // Build the agents to create
    const selectedPresets = allPresets.filter(p => selectedAgentIds.has(p.id));
    const agents: AgentToCreate[] = selectedPresets
      .map(p => presetToAgent(p, p.department));

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
            founderFocus,
          });
          await createAgentsFromPresets(db, agents, 'local', modelTag, selectedPresets);

          // Configure MCP servers if integration tokens were provided
          if (integrationInputs.length > 0) {
            const configuredInputs = integrationInputs.filter(
              inp => !integrationSkipped.has(inp.server.id) && Object.keys(inp.envValues).length > 0,
            );
            if (configuredInputs.length > 0) {
              const allEnvValues: Record<string, string> = {};
              for (const inp of configuredInputs) {
                Object.assign(allEnvValues, inp.envValues);
              }
              await configureMcpServersForAgents(
                db,
                configuredInputs.map(inp => inp.server.id),
                allEnvValues,
              );
            }
          }

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
          founderFocus,
          agents,
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

  const stepNum = existingState
    ? RETURNING_STEP_NUMBERS[step] ?? STEP_NUMBERS[step]
    : isConnected
      ? CONNECTED_STEP_NUMBERS[step] ?? STEP_NUMBERS[step]
      : STEP_NUMBERS[step];
  const totalSteps = existingState ? 2 : isConnected ? 5 : 9;
  const recommendedAgents = allPresets.filter(p => discoveredAgentIds.includes(p.id));

  return (
    <Box flexDirection="column" padding={1}>
      {/* Step indicator (hidden on splash) */}
      {step !== 'splash' && (
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {step === 'tier_choice' ? 'Setup' :
             step === 'model' || step === 'downloading' || step === 'cloud_auth' ? (existingState ? 'Your orchestrator model' : 'Model Setup') :
             step === 'business_info' ? 'Business Info' :
             step === 'founder_stage' ? 'Your Journey' :
             step === 'agent_discovery' ? 'Agent Discovery' :
             step === 'agent_selection' ? (existingState ? 'Your Agents' : 'Choose Agents') :
             step === 'integration_setup' ? 'Integrations' :
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

      {(step === 'model' || step === 'downloading') && (
        <ModelStep
          status={status}
          selectedModel={selectedModel}
          showAlternatives={showAlternatives}
          downloadPercent={downloadPercent}
          downloadMessage={downloadMessage}
          downloading={step === 'downloading'}
          error={error}
          installedCatalogModels={installedCatalogModels}
          runningModels={status?.runningModels}
          allInstalledModels={status?.installedModels}
          onSelectAlternative={(item) => {
            const alternatives = status?.alternatives || [];
            const model = alternatives.find(m => m.tag === item.value);
            if (model) {
              setSelectedModel(model);
              setShowAlternatives(false);
              // In readiness mode, immediately start pulling if not installed
              if (existingState?.modelName && status && !isModelInstalled(model.tag, status.installedModels)) {
                setReadinessPulling(true);
                setStep('downloading');
              }
            }
          }}
          readinessMode={existingState?.modelName ? {
            modelName: existingState.modelName,
            stats: { requests: existingState.totalRequests, tokens: existingState.totalTokens },
          } : undefined}
          readinessSelectedIdx={readinessIdx}
          readinessLoading={readinessLoading}
          modelSource={modelSource}
          cloudAuthStatus={(anthropicKey || openRouterKey) ? 'authenticated' : 'none'}
          cloudModel={configCloudModel}
          cloudProvider={configCloudProvider}
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

      {step === 'business_info' && (
        <BusinessInfoStep
          businessName={businessName}
          businessType={businessType}
          businessDescription={businessDescription}
          activeField={businessField}
          typeIndex={businessTypeIndex}
          onChangeName={setBusinessName}
          onChangeDescription={setBusinessDescription}
        />
      )}

      {step === 'founder_stage' && (
        <FounderStageStep
          founderPath={founderPath}
          founderFocus={founderFocus}
          activeField={founderField}
          pathIndex={founderPathIndex}
        />
      )}

      {step === 'agent_discovery' && (
        <AgentDiscoveryStep
          modelAvailable={modelAvailable}
          chatMessages={chatMessages}
          chatInput={chatInput}
          chatStreaming={chatStreaming}
          recommendedAgents={recommendedAgents}
          presets={allPresets}
        />
      )}

      {step === 'agent_selection' && (
        <AgentSelectionStep
          presets={allPresets}
          selectedIds={selectedAgentIds}
          cursorIndex={selectionCursor}
          readonlyMode={!!existingState || (isConnected && connectedLocalAgents !== null)}
          agentHealth={existingState?.agents || (isConnected ? connectedLocalAgents ?? undefined : undefined)}
          emptyState={isConnected && connectedNoAgents}
        />
      )}

      {step === 'integration_setup' && (
        <IntegrationSetupStep
          integrations={integrationInputs}
          currentIndex={integrationIndex}
          currentEnvIndex={integrationEnvIndex}
          currentValue={integrationValue}
          skippedIds={integrationSkipped}
        />
      )}

      {step === 'ready' && (
        <ReadyStep
          businessName={existingState?.businessName || businessName}
          selectedModel={selectedModel}
          agentCount={existingState?.agents.length || connectedLocalAgents?.length || selectedAgentIds.size}
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
