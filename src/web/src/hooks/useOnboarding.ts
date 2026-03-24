/**
 * useOnboarding Hook
 * Manages the 7-screen onboarding state machine and API calls.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export type OnboardingScreen =
  | 'splash'
  | 'model'
  | 'business_info'
  | 'founder_stage'
  | 'agent_discovery'
  | 'agent_selection'
  | 'ready';

interface DeviceInfo {
  arch: string;
  platform: string;
  totalMemoryGB: number;
  cpuModel: string;
  cpuCores: number;
  isAppleSilicon: boolean;
  hasNvidiaGpu: boolean;
  gpuName?: string;
}

export interface ModelInfo {
  tag: string;
  label: string;
  description: string;
  sizeGB: number;
  minRAM: number;
  features: string[];
  family: string;
  tier: string;
  recommended?: boolean;
}

export interface OnboardingStatus {
  isFirstRun: boolean;
  device: DeviceInfo;
  deviceSummary: string;
  memoryTier: string;
  recommendation: ModelInfo | null;
  alternatives: ModelInfo[];
  estimatedMinutes: number | null;
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
}

interface OnboardingProgress {
  phase: string;
  message: string;
  percent?: number;
  done?: boolean;
  error?: string;
}

interface AgentPreset {
  id: string;
  name: string;
  role: string;
  description: string;
  tools: string[];
  recommended?: boolean;
  department?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OnboardingState {
  screen: OnboardingScreen;
  status: OnboardingStatus | null;
  selectedModel: ModelInfo | null;
  loading: boolean;
  downloading: boolean;
  downloadPercent: number;
  downloadMessage: string;
  setupMessage: string;
  error: string | null;
  completed: boolean;
  // Business info
  businessName: string;
  businessType: string;
  businessDescription: string;
  // Founder stage
  founderPath: string;
  founderFocus: string;
  // Agent discovery
  modelAvailable: boolean;
  chatMessages: ChatMessage[];
  chatStreaming: boolean;
  // Agent selection
  presets: AgentPreset[];
  selectedAgentIds: Set<string>;
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>({
    screen: 'splash',
    status: null,
    selectedModel: null,
    loading: false,
    downloading: false,
    downloadPercent: 0,
    downloadMessage: '',
    setupMessage: '',
    error: null,
    completed: false,
    businessName: '',
    businessType: '',
    businessDescription: '',
    founderPath: '',
    founderFocus: '',
    modelAvailable: false,
    chatMessages: [],
    chatStreaming: false,
    presets: [],
    selectedAgentIds: new Set(),
  });

  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight SSE download on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  /** Fetch onboarding status (device info + recommendations). */
  const fetchStatus = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch('/api/onboarding/status');
      if (!res.ok) throw new Error('Could not detect hardware');
      const { data } = await res.json() as { data: OnboardingStatus };
      setState(s => ({
        ...s,
        status: data,
        selectedModel: data.recommendation,
        loading: false,
      }));
      return data;
    } catch (err) {
      setState(s => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Something went wrong',
      }));
      return null;
    }
  }, []);

  /** Move to the model screen. */
  const goToModel = useCallback(async () => {
    setState(s => ({ ...s, screen: 'model' }));
    if (!state.status) {
      await fetchStatus();
    }
  }, [state.status, fetchStatus]);

  /** Select a different model. */
  const selectModel = useCallback((model: ModelInfo) => {
    setState(s => ({ ...s, selectedModel: model }));
  }, []);

  /** Consume an SSE stream. */
  const consumeSSE = async (
    res: Response,
    onProgress: (progress: OnboardingProgress) => void,
    signal?: AbortSignal,
  ) => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;
            try {
              onProgress(JSON.parse(data) as OnboardingProgress);
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  /** Start download: ensures Ollama + downloads the selected model. */
  const startDownload = useCallback(async () => {
    const model = state.selectedModel;
    if (!model || abortRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setState(s => ({
      ...s,
      downloading: true,
      downloadPercent: 0,
      downloadMessage: '',
      setupMessage: 'Setting things up...',
      error: null,
    }));

    try {
      const ollamaRes = await fetch('/api/onboarding/ensure-ollama', {
        method: 'POST',
        signal: controller.signal,
      });
      if (!ollamaRes.ok || !ollamaRes.body) throw new Error('Could not set up Ollama');

      await consumeSSE(ollamaRes, (progress) => {
        setState(s => ({ ...s, setupMessage: progress.message }));
        if (progress.error) throw new Error(progress.error);
      }, controller.signal);

      setState(s => ({ ...s, setupMessage: '', downloadMessage: 'Starting download...' }));
      const downloadRes = await fetch('/api/onboarding/download-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: model.tag }),
        signal: controller.signal,
      });
      if (!downloadRes.ok || !downloadRes.body) throw new Error('Could not start download');

      await consumeSSE(downloadRes, (progress) => {
        setState(s => ({
          ...s,
          downloadMessage: progress.message,
          downloadPercent: progress.percent ?? s.downloadPercent,
        }));
        if (progress.error) throw new Error(progress.error);
      }, controller.signal);

      setState(s => ({
        ...s,
        downloading: false,
        downloadPercent: 100,
        downloadMessage: 'Download complete',
        modelAvailable: true,
        screen: 'business_info',
      }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setState(s => ({
        ...s,
        downloading: false,
        setupMessage: '',
        error: err instanceof Error ? err.message : 'Something went wrong',
      }));
    } finally {
      abortRef.current = null;
    }
  }, [state.selectedModel]);

  /** Skip download. */
  const skipDownload = useCallback(() => {
    setState(s => ({ ...s, screen: 'business_info', selectedModel: null, modelAvailable: false }));
  }, []);

  // ── Business Info ────────────────────────────────────────────────────

  const setBusinessName = useCallback((value: string) => {
    setState(s => ({ ...s, businessName: value }));
  }, []);

  const setBusinessType = useCallback((value: string) => {
    setState(s => ({ ...s, businessType: value }));
  }, []);

  const setBusinessDescription = useCallback((value: string) => {
    setState(s => ({ ...s, businessDescription: value }));
  }, []);

  const goToBusinessInfo = useCallback(() => {
    setState(s => ({ ...s, screen: 'business_info' }));
  }, []);

  // ── Founder Stage ────────────────────────────────────────────────────

  const setFounderPath = useCallback((value: string) => {
    setState(s => ({ ...s, founderPath: value }));
  }, []);

  const setFounderFocus = useCallback((value: string) => {
    setState(s => ({ ...s, founderFocus: value }));
  }, []);

  const goToFounderStage = useCallback(() => {
    setState(s => ({ ...s, screen: 'founder_stage' }));
  }, []);

  // ── Agent Discovery ──────────────────────────────────────────────────

  const sendChatMessageInternal = useCallback(async (history: ChatMessage[]) => {
    setState(s => ({ ...s, chatStreaming: true }));
    try {
      const res = await fetch('/api/onboarding/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          businessType: state.businessType || 'saas_startup',
          founderPath: state.founderPath || 'exploring',
          founderFocus: state.founderFocus || '',
        }),
      });

      if (!res.ok || !res.body) throw new Error('Chat unavailable');

      let fullContent = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data) as { type: string; content?: string };
              if (chunk.type === 'text' && chunk.content) {
                fullContent += chunk.content;
              }
            } catch {
              // Skip malformed
            }
          }
        }
      }

      if (fullContent) {
        setState(s => ({
          ...s,
          chatMessages: [...s.chatMessages, { role: 'assistant', content: fullContent }],
          chatStreaming: false,
        }));

        // Try to parse agent recommendations
        const agentBlockMatch = fullContent.match(/```agents\s*\n?([\s\S]*?)```/);
        if (agentBlockMatch) {
          try {
            const parsed = JSON.parse(agentBlockMatch[1].trim());
            if (Array.isArray(parsed)) {
              setState(s => ({
                ...s,
                selectedAgentIds: new Set(parsed.filter((id: unknown) => typeof id === 'string' && s.presets.some(p => p.id === id))),
              }));
            }
          } catch {
            // No valid recommendations
          }
        }
      } else {
        setState(s => ({ ...s, chatStreaming: false }));
      }
    } catch {
      setState(s => ({
        ...s,
        chatStreaming: false,
        chatMessages: [...s.chatMessages, {
          role: 'assistant',
          content: 'I ran into an issue connecting to the model. You can pick your agents manually on the next screen.',
        }],
      }));
    }
  }, [state.businessType, state.founderPath, state.founderFocus]);

  const goToAgentDiscovery = useCallback(async () => {
    // Fetch presets for the business type
    const bizType = state.businessType || 'saas_startup';
    try {
      const presetsRes = await fetch(`/api/onboarding/presets?businessType=${bizType}`);
      if (presetsRes.ok) {
        const { data } = await presetsRes.json() as { data: { presets: AgentPreset[]; recommended: AgentPreset[] } };
        setState(s => ({
          ...s,
          screen: 'agent_discovery',
          presets: data.presets,
          selectedAgentIds: new Set(data.recommended.map(a => a.id)),
        }));
      } else {
        setState(s => ({ ...s, screen: 'agent_discovery' }));
      }
    } catch {
      setState(s => ({ ...s, screen: 'agent_discovery' }));
    }

    // Check model availability
    try {
      const modelRes = await fetch('/api/onboarding/model-available');
      if (modelRes.ok) {
        const { data } = await modelRes.json() as { data: { available: boolean } };
        setState(s => ({ ...s, modelAvailable: data.available }));

        // Start AI chat if model is available and no messages yet
        if (data.available && state.chatMessages.length === 0) {
          sendChatMessageInternal([]);
        }
      }
    } catch {
      // Model not available
    }
  }, [state.businessType, state.chatMessages.length, sendChatMessageInternal]);

  const sendChatMessage = useCallback((message: string) => {
    const userMsg: ChatMessage = { role: 'user', content: message };
    setState(s => ({ ...s, chatMessages: [...s.chatMessages, userMsg] }));
    const newHistory = [...state.chatMessages, userMsg];
    sendChatMessageInternal(newHistory);
  }, [state.chatMessages, sendChatMessageInternal]);

  // ── Agent Selection ──────────────────────────────────────────────────

  const goToAgentSelection = useCallback(() => {
    setState(s => ({ ...s, screen: 'agent_selection' }));
  }, []);

  const toggleAgent = useCallback((id: string) => {
    setState(s => {
      const next = new Set(s.selectedAgentIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...s, selectedAgentIds: next };
    });
  }, []);

  // ── Ready / Complete ─────────────────────────────────────────────────

  const goToReady = useCallback(() => {
    setState(s => ({ ...s, screen: 'ready' }));
  }, []);

  /** Complete onboarding: save config, business data, and create agents. */
  const completeOnboarding = useCallback(async (): Promise<string | null> => {
    const model = state.selectedModel;
    const tag = model?.tag || 'qwen3:4b';

    // Build agents array from selected presets
    const agents = state.presets
      .filter(p => state.selectedAgentIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        description: p.description,
        systemPrompt: '', // Will be filled from preset data on server
        tools: p.tools,
        department: p.department,
      }));

    setState(s => ({ ...s, loading: true, error: null }));

    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelTag: tag,
          businessName: state.businessName,
          businessType: state.businessType,
          businessDescription: state.businessDescription,
          founderPath: state.founderPath,
          founderFocus: state.founderFocus,
          agents,
        }),
      });
      if (!res.ok) throw new Error('Could not save config');

      setState(s => ({ ...s, loading: false, completed: true }));
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      setState(s => ({ ...s, loading: false, error: msg }));
      return msg;
    }
  }, [state.selectedModel, state.businessName, state.businessType, state.businessDescription, state.founderPath, state.founderFocus, state.presets, state.selectedAgentIds]);

  return {
    ...state,
    fetchStatus,
    goToModel,
    selectModel,
    startDownload,
    skipDownload,
    // Business
    setBusinessName,
    setBusinessType,
    setBusinessDescription,
    goToBusinessInfo,
    // Founder
    setFounderPath,
    setFounderFocus,
    goToFounderStage,
    // Discovery
    goToAgentDiscovery,
    sendChatMessage,
    // Selection
    goToAgentSelection,
    toggleAgent,
    // Ready
    goToReady,
    completeOnboarding,
  };
}
