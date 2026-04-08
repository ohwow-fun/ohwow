/**
 * useOrchestrator Hook
 * Manages chat state and streaming via the daemon's SSE /api/chat endpoint.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { CODE_TOOL_NAMES } from '../components/tool-result-view.js';
import { logger } from '../../lib/logger.js';

export interface AutomationProposalTUI {
  name: string;
  description: string;
  reasoning: string;
  trigger: { type: string; config: Record<string, unknown> };
  steps: {
    id: string;
    step_type: string;
    label: string;
    agent_id?: string;
    agent_name?: string;
    prompt?: string;
    warning?: string;
  }[];
  variables: { name: string; description: string; default_value?: string }[];
  missingIntegrations: string[];
}

export type TurnStep =
  | { kind: 'text'; content: string }
  | { kind: 'status'; message: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; status: 'running' | 'done' | 'error'; error?: string; result?: string }
  | { kind: 'automation_proposal'; proposal: AutomationProposalTUI }
  | { kind: 'screenshot'; path: string }
  | { kind: 'media_generated'; path: string };

export type PlanTask = {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
};

function summarizeResult(data: unknown, toolName?: string): string {
  const maxLines = CODE_TOOL_NAMES.has(toolName ?? '') ? 30 : 10;
  const maxChars = CODE_TOOL_NAMES.has(toolName ?? '') ? 3000 : 400;

  if (typeof data === 'string') {
    const lines = data.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)`;
    }
    return data.length > maxChars ? data.slice(0, maxChars) + '…' : data;
  }
  const json = JSON.stringify(data, null, 2);
  return json.length > maxChars ? json.slice(0, maxChars) + '…' : json;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;       // joined text steps (for search / compact display)
  steps?: TurnStep[];    // full interleaved sequence
}

export interface ElicitationRequest {
  requestId: string;
  serverName: string;
  message: string;
  schema: Record<string, unknown>;
}

export interface CostConfirmationRequest {
  requestId: string;
  toolName: string;
  estimatedCredits: number;
  description: string;
}

export interface OrchestratorState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingSteps: TurnStep[];
  error: string | null;
  sessionId: string;
  sessionTitle: string;
  switchTabSignal: string | null;
  currentModel: string;
  permissionRequest: { requestId: string; path: string; toolName: string } | null;
  costConfirmation: CostConfirmationRequest | null;
  elicitationRequest: ElicitationRequest | null;
  planTasks: PlanTask[];
  streamingElapsedMs: number;
  lastTokens: { input: number; output: number };
  sendMessage: (text: string) => void;
  sendWelcome: (internalPrompt: string) => void;
  stopStreaming: () => void;
  newSession: () => void;
  clearSwitchTab: () => void;
  setModel: (model: string, source?: 'local' | 'cloud' | 'claude-code' | 'auto') => void;
  resolvePermission: (requestId: string, granted: boolean) => void;
  resolveCostApproval: (requestId: string, approved: boolean) => void;
  resolveElicitation: (requestId: string, accepted: boolean, fields?: Record<string, unknown>) => void;
  addSystemMessage: (text: string) => void;
  loadSession: (id: string) => void;
  renameSession: (title: string) => void;
}

export function useOrchestrator(
  daemonPort: number,
  sessionToken: string,
  orchestratorModel?: string,
): OrchestratorState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingSteps, setStreamingSteps] = useState<TurnStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [sessionTitle, setSessionTitle] = useState('');
  const [switchTabSignal, setSwitchTabSignal] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState(orchestratorModel || 'ollama');
  const [modelSource, setModelSource] = useState<'local' | 'cloud' | 'claude-code' | 'auto'>('local');
  const [permissionRequest, setPermissionRequest] = useState<{ requestId: string; path: string; toolName: string } | null>(null);
  const [costConfirmation, setCostConfirmation] = useState<CostConfirmationRequest | null>(null);
  const [elicitationRequest, setElicitationRequest] = useState<ElicitationRequest | null>(null);
  const [planTasks, setPlanTasks] = useState<PlanTask[]>([]);
  const [streamingElapsedMs, setStreamingElapsedMs] = useState(0);
  const [lastTokens, setLastTokens] = useState<{ input: number; output: number }>({ input: 0, output: 0 });

  const abortRef = useRef<AbortController | null>(null);
  const tokenRef = useRef(sessionToken);
  const streamingStartRef = useRef<number | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep tokenRef current (handles daemon restarts that issue new tokens)
  useEffect(() => {
    tokenRef.current = sessionToken;
  }, [sessionToken]);

  // Sync currentModel when orchestratorModel prop changes (e.g. after Model Manager update)
  useEffect(() => {
    if (orchestratorModel && orchestratorModel !== currentModel) {
      setCurrentModel(orchestratorModel);
    }
  }, [orchestratorModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const startElapsedTimer = useCallback(() => {
    streamingStartRef.current = Date.now();
    setStreamingElapsedMs(0);
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    elapsedIntervalRef.current = setInterval(() => {
      if (streamingStartRef.current != null) {
        setStreamingElapsedMs(Date.now() - streamingStartRef.current);
      }
    }, 1000);
  }, []);

  const stopElapsedTimer = useCallback(() => {
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
    streamingStartRef.current = null;
    setStreamingElapsedMs(0);
  }, []);

  const sendInternal = useCallback(async (text: string, options?: { hideUserMessage?: boolean }) => {
    if (isStreaming) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    // Add user message (unless hidden for welcome flow)
    if (!options?.hideUserMessage) {
      setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    }
    setIsStreaming(true);
    setStreamingSteps([]);
    setError(null);
    setPlanTasks([]);
    startElapsedTimer();

    const steps: TurnStep[] = [];

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(`http://localhost:${daemonPort}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          model: currentModel,
          modelSource,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text();
        let msg = "Couldn't reach the daemon. Try restarting.";
        try {
          const parsed = JSON.parse(body) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch { /* use default */ }
        throw new Error(msg);
      }

      if (!resp.body) {
        throw new Error("Couldn't read response stream.");
      }

      // Parse SSE stream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as {
              type: string;
              content?: string;
              message?: string;
              name?: string;
              input?: Record<string, unknown>;
              result?: { success: boolean; data?: unknown; error?: string };
              tab?: string;
              error?: string;
              requestId?: string;
              path?: string;
              toolName?: string;
              estimatedCredits?: number;
              description?: string;
              serverName?: string;
              schema?: Record<string, unknown>;
              tasks?: PlanTask[];
              inputTokens?: number;
              outputTokens?: number;
            };

            switch (event.type) {
              case 'status': {
                steps.push({ kind: 'status', message: event.message || '' });
                setStreamingSteps([...steps]);
                break;
              }

              case 'text': {
                const chunk = event.content || '';
                const last = steps.at(-1);
                if (last?.kind === 'text') {
                  last.content += chunk;
                } else {
                  steps.push({ kind: 'text', content: chunk });
                }
                setStreamingSteps([...steps]);
                break;
              }

              case 'tool_start': {
                steps.push({
                  kind: 'tool',
                  name: event.name || 'unknown',
                  input: event.input ?? {},
                  status: 'running',
                });
                setStreamingSteps([...steps]);
                break;
              }

              case 'tool_done': {
                // Find last running tool step with matching name
                for (let i = steps.length - 1; i >= 0; i--) {
                  const s = steps[i];
                  if (s.kind === 'tool' && s.name === event.name && s.status === 'running') {
                    s.status = event.result?.success ? 'done' : 'error';
                    s.error = event.result?.success ? undefined : event.result?.error;
                    s.result = event.result?.success && event.result?.data != null
                      ? summarizeResult(event.result.data, event.name)
                      : undefined;
                    break;
                  }
                }
                // Detect automation proposal from propose_automation tool result
                const resultData = event.result?.data as Record<string, unknown> | undefined;
                if (event.name === 'propose_automation' && event.result?.success && resultData?._automationProposal) {
                  const ap = resultData._automationProposal as AutomationProposalTUI;
                  steps.push({ kind: 'automation_proposal', proposal: ap });
                }
                setStreamingSteps([...steps]);
                break;
              }

              case 'screenshot': {
                if (event.path) {
                  steps.push({ kind: 'screenshot', path: event.path });
                  setStreamingSteps([...steps]);
                }
                break;
              }

              case 'media_generated': {
                if (event.path) {
                  steps.push({ kind: 'media_generated', path: event.path });
                  setStreamingSteps([...steps]);
                }
                break;
              }

              case 'plan_update':
                if (event.tasks) setPlanTasks(event.tasks);
                break;

              case 'switch_tab':
                if (event.tab) setSwitchTabSignal(event.tab);
                break;

              case 'permission_request':
                if (event.requestId && event.path) {
                  setPermissionRequest({ requestId: event.requestId, path: event.path, toolName: event.toolName || '' });
                }
                break;

              case 'cost_confirmation':
                if (event.requestId) {
                  setCostConfirmation({
                    requestId: event.requestId,
                    toolName: event.toolName || '',
                    estimatedCredits: event.estimatedCredits || 0,
                    description: event.description || '',
                  });
                }
                break;

              case 'mcp_elicitation':
                if (event.requestId) {
                  setElicitationRequest({
                    requestId: event.requestId,
                    serverName: event.serverName || 'Unknown server',
                    message: event.message || '',
                    schema: event.schema || {},
                  });
                }
                break;

              case 'error':
                throw new Error(event.error || 'Stream error');

              case 'done':
                if (event.inputTokens != null || event.outputTokens != null) {
                  setLastTokens({ input: event.inputTokens ?? 0, output: event.outputTokens ?? 0 });
                }
                break;
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              // Malformed SSE JSON line — expected for partial chunks, safe to skip
              continue;
            }
            if (parseErr instanceof Error) {
              // Re-thrown stream errors (type: 'error') or unexpected failures
              logger.debug({ err: parseErr.message }, 'stream event error');
              throw parseErr;
            }
          }
        }
      }

      // Derive full content by joining all text-step contents
      const fullContent = steps
        .filter((s): s is TurnStep & { kind: 'text' } => s.kind === 'text')
        .map((s) => s.content)
        .join('');

      // Add assistant message (exclude transient status steps from saved history)
      const persistedSteps = steps.filter(s => s.kind !== 'status');
      if (fullContent || persistedSteps.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: fullContent,
            steps: persistedSteps.length > 0 ? persistedSteps : undefined,
          },
        ]);
      }

      // Set session title from first user message if not already set
      if (!sessionTitle) {
        const title = options?.hideUserMessage
          ? 'Welcome'
          : (trimmed.slice(0, 60).replace(/\s+\S*$/, '') || trimmed.slice(0, 60));
        setSessionTitle(title);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Save partial response if any content was accumulated
        const partialContent = steps
          .filter((s): s is TurnStep & { kind: 'text' } => s.kind === 'text')
          .map((s) => s.content)
          .join('');
        if (partialContent || steps.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: partialContent,
              steps: steps.length > 0 ? [...steps] : undefined,
            },
          ]);
        }
        return;
      }
      const msg = err instanceof Error ? err.message : "Couldn't reach the daemon. Try restarting.";
      setError(msg);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${msg}` },
      ]);
    } finally {
      setIsStreaming(false);
      setStreamingSteps([]);
      stopElapsedTimer();
      abortRef.current = null;
    }
  }, [isStreaming, sessionId, sessionTitle, currentModel, modelSource, daemonPort, startElapsedTimer, stopElapsedTimer]);

  const sendMessage = useCallback((text: string) => {
    sendInternal(text);
  }, [sendInternal]);

  const sendWelcome = useCallback((internalPrompt: string) => {
    sendInternal(internalPrompt, { hideUserMessage: true });
  }, [sendInternal]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const setModel = useCallback((model: string, source?: 'local' | 'cloud' | 'claude-code' | 'auto') => {
    setCurrentModel(model);
    if (source) setModelSource(source);
    // Start a new session with the new model
    setMessages([]);
    setSessionId(crypto.randomUUID());
    setSessionTitle('');
    setError(null);
    setPlanTasks([]);
  }, []);

  const newSession = useCallback(() => {
    // Cancel any in-flight request
    abortRef.current?.abort();
    setMessages([]);
    setSessionId(crypto.randomUUID());
    setSessionTitle('');
    setError(null);
    setPlanTasks([]);
  }, []);

  const addSystemMessage = useCallback((text: string) => {
    setMessages(prev => [...prev, { role: 'assistant', content: text }]);
  }, []);

  const clearSwitchTab = useCallback(() => {
    setSwitchTabSignal(null);
  }, []);

  const loadSession = useCallback(async (id: string) => {
    try {
      abortRef.current?.abort();
      const resp = await fetch(`http://localhost:${daemonPort}/api/orchestrator/sessions/${id}`, {
        headers: { Authorization: `Bearer ${tokenRef.current}` },
      });
      if (!resp.ok) return;
      const session = await resp.json() as {
        title?: string;
        messages: unknown;
      };
      const rawMessages = typeof session.messages === 'string'
        ? JSON.parse(session.messages as string)
        : session.messages;
      const raw = Array.isArray(rawMessages) ? rawMessages : [];

      setSessionId(id as `${string}-${string}-${string}-${string}-${string}`);
      setSessionTitle(session.title || '');
      setError(null);
      setPlanTasks([]);

      // Restore messages as simple user/assistant pairs
      const restored: ChatMessage[] = raw.map((m: { role: string; content: unknown }) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === 'text' && b.text)
                .map((b) => b.text)
                .join('')
            : String(m.content || ''),
      }));
      setMessages(restored);
    } catch {
      // silent
    }
  }, [daemonPort]);

  const renameSession = useCallback(async (title: string) => {
    if (!sessionId || !title.trim()) return;
    setSessionTitle(title.trim());
    try {
      await fetch(`http://localhost:${daemonPort}/api/orchestrator/sessions/${sessionId}/rename`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ title: title.trim() }),
      });
    } catch {
      // silent
    }
  }, [sessionId, daemonPort]);

  const resolvePermission = useCallback(async (requestId: string, granted: boolean) => {
    setPermissionRequest(null);
    try {
      await fetch(`http://localhost:${daemonPort}/api/permission-response`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ requestId, granted }),
      });
    } catch {
      // Daemon will time out the pending permission if unreachable
    }
  }, [daemonPort]);

  const resolveCostApproval = useCallback(async (requestId: string, approved: boolean) => {
    setCostConfirmation(null);
    try {
      await fetch(`http://localhost:${daemonPort}/api/cost-approval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ requestId, approved }),
      });
    } catch {
      // Daemon will time out the pending approval if unreachable
    }
  }, [daemonPort]);

  const resolveElicitation = useCallback(async (requestId: string, accepted: boolean, fields?: Record<string, unknown>) => {
    setElicitationRequest(null);
    try {
      await fetch(`http://localhost:${daemonPort}/api/elicitation-response`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ requestId, accepted, fields }),
      });
    } catch {
      // Engine will auto-decline after timeout
    }
  }, [daemonPort]);

  // Auto-resume: fetch last session and set title (don't load messages to keep chat clean)
  const autoResumeRef = useRef(false);
  useEffect(() => {
    if (autoResumeRef.current) return;
    autoResumeRef.current = true;

    (async () => {
      try {
        const resp = await fetch(`http://localhost:${daemonPort}/api/orchestrator/sessions?limit=1`, {
          headers: { Authorization: `Bearer ${tokenRef.current}` },
        });
        if (!resp.ok) return;
        const data = await resp.json() as { sessions?: Array<{ id: string; title: string; updated_at: string }> };
        const recent = data.sessions?.[0];
        if (!recent) return;

        // Only resume if updated within the last 4 hours
        const age = Date.now() - new Date(recent.updated_at).getTime();
        if (age > 4 * 60 * 60 * 1000) return;

        setSessionId(recent.id as `${string}-${string}-${string}-${string}-${string}`);
        setSessionTitle(recent.title);
        setMessages([{ role: 'assistant', content: `Continuing: ${recent.title}` }]);
      } catch {
        // silent
      }
    })();
  }, [daemonPort]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    };
  }, []);

  return {
    messages,
    isStreaming,
    streamingSteps,
    error,
    sessionId,
    sessionTitle,
    switchTabSignal,
    currentModel,
    permissionRequest,
    costConfirmation,
    elicitationRequest,
    planTasks,
    streamingElapsedMs,
    lastTokens,
    sendMessage,
    sendWelcome,
    stopStreaming,
    newSession,
    clearSwitchTab,
    setModel,
    resolvePermission,
    resolveCostApproval,
    resolveElicitation,
    addSystemMessage,
    loadSession,
    renameSession,
  };
}
