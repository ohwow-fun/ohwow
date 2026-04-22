/**
 * Unified Onboarding Wizard
 * 7-step flow: Splash → Tier Choice → Business Info → Agent Discovery →
 * Agent Selection → Integration Setup → Ready.
 * Connected path: Splash → Tier Choice → Agent Selection → Ready
 * (business info + founder stage + agent discovery are skipped, data comes from cloud).
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
import { type AgentPreset } from '../data/agent-presets.js';
import {
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
import { CloudAuthStep } from './onboarding/CloudAuthStep.js';
import { FirstMomentStep } from './onboarding/FirstMomentStep.js';
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

type Step = 'splash' | 'tier_choice' | 'cloud_auth' | 'first_moment' | 'agent_discovery' | 'agent_selection' | 'integration_setup' | 'ready';

const STEP_NUMBERS: Record<Step, number> = {
  splash: 1,
  tier_choice: 2,
  cloud_auth: 3,
  first_moment: 3,
  agent_discovery: 4,
  agent_selection: 5,
  integration_setup: 6,
  ready: 7,
};

/** Step numbering for connected path (splash → tier choice → agents → ready) */
const CONNECTED_STEP_NUMBERS: Partial<Record<Step, number>> = {
  splash: 1,
  tier_choice: 2,
  agent_selection: 3,
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

  // Agent discovery state
  const [modelAvailable] = useState(false);
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

  // Auto-skip steps for connected users (business data comes from cloud)
  useEffect(() => {
    if (!isConnected || existingState) return;
    if (step === 'first_moment' || step === 'agent_discovery') {
      setStep('agent_selection');
    }
  }, [step, isConnected, existingState]);

  // When entering agent discovery, load presets and pre-select recommended agents
  useEffect(() => {
    if (step !== 'agent_discovery') return;
    const presets = getPresetsForBusinessType(businessType || 'saas_startup');
    setAllPresets(presets);

    // Model not yet configured — always use static recommendations
    const recommended = getStaticRecommendations(businessType || 'saas_startup');
    setSelectedAgentIds(new Set(recommended.map(a => a.id)));
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
        // Returning user: only splash step; tier_choice reached on validation failure
        if (step === 'tier_choice') { setSplashError(''); setSplashErrorKind(''); setStep('splash'); return; }
      } else if (isConnected) {
        // Connected user: splash → tier_choice → agent_selection → ready
        if (step === 'tier_choice') { setStep('splash'); return; }
        if (step === 'agent_selection') { setStep('tier_choice'); return; }
        if (step === 'ready') { setStep('agent_selection'); return; }
      } else {
        // Free user: splash → tier_choice → first_moment → agent_discovery → agent_selection → …
        if (step === 'tier_choice') { setStep('splash'); return; }
        if (step === 'first_moment') { setStep('tier_choice'); return; }
        if (step === 'agent_discovery') { setStep('first_moment'); return; }
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
              // Model step removed — go straight to agents (connected) or business info (free)
              setStep('agent_selection');
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
                    const nextAfterCloud = isConnected ? 'agent_selection' : 'first_moment';
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
            const nextAfterCloud = isConnected ? 'agent_selection' : 'first_moment';
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
          setStep('agent_discovery');
        } else if (key.backspace || key.delete) {
          setFirstTask(prev => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setFirstTask(prev => prev + input);
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
            founderFocus: firstTask,
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
          founderFocus: firstTask,
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

  const stepNum = isConnected
    ? CONNECTED_STEP_NUMBERS[step] ?? STEP_NUMBERS[step]
    : STEP_NUMBERS[step];
  const totalSteps = isConnected ? 4 : 7;
  const recommendedAgents = allPresets.filter(p => discoveredAgentIds.includes(p.id));

  return (
    <Box flexDirection="column" padding={1}>
      {/* Step indicator (hidden on splash) */}
      {step !== 'splash' && (
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {step === 'tier_choice' ? 'Setup' :
             step === 'cloud_auth' ? 'Cloud Auth' :
             step === 'first_moment' ? 'Your Business' :
             step === 'agent_discovery' ? 'Agent Discovery' :
             step === 'agent_selection' ? 'Choose Agents' :
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
