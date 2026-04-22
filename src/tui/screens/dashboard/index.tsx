/**
 * Dashboard Screen
 * Chat-centric root layout. Chat is the home screen with a grid menu below.
 * Selecting a grid item or using slash commands opens a full-screen view.
 * ESC always returns to chat.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { useTerminalSize } from '../../hooks/use-terminal-size.js';
import type { RuntimeConfig } from '../../../config.js';
import { updateConfigFile, resolveActiveWorkspace } from '../../../config.js';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';
import type Database from 'better-sqlite3';
import { Screen, Section, getGridScreens } from '../../types.js';
import { useRuntime } from '../../hooks/use-runtime.js';
import { useNavigation } from '../../hooks/use-navigation.js';
import { Header } from '../../components/header.js';
import { StatusBar } from '../../components/key-hints.js';
import type { KeyHint } from '../../components/key-hints.js';
import { GRID_COLS } from '../../components/grid-menu.js';
import { getFilteredCommands } from '../../components/slash-command-menu.js';
import type { SlashCommand } from '../../components/slash-command-menu.js';
import { ShortcutPalette, getFilteredPaletteCommands } from '../../components/shortcut-palette.js';
import { ResourcesTab } from '../settings/resources-tab.js';
import { VERSION } from '../../../version.js';
import { stopDaemon, waitForDaemonStop, startDaemonBackground, waitForDaemon, getDaemonSessionToken, isDaemonRunning } from '../../../daemon/lifecycle.js';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { MetricBox } from '../../components/metric-box.js';
import { useAgents } from '../../hooks/use-agents.js';
import { useTasks } from '../../hooks/use-tasks.js';
import { useHealth } from '../../hooks/use-health.js';
import { AgentsList } from '../agents-list.js';
import { TasksList } from '../tasks-list.js';
import { ContactsList } from '../contacts-list.js';
import { ContactDetail } from '../contact-detail.js';
import { useContacts } from '../../hooks/use-contacts.js';
import { ApprovalsList } from '../approvals.js';
import { ActivityLog } from '../activity-log.js';
import { PeopleList } from '../people.js';
import { Settings } from '../settings.js';
import { AgentDetail } from '../agent-detail.js';
import { TaskDetail } from '../task-detail.js';
import { TaskDispatch } from '../task-dispatch.js';
import { useOrchestrator } from '../../hooks/use-orchestrator.js';
import type { ElicitationRequest } from '../../hooks/use-orchestrator.js';
import { useEvent } from '../../hooks/use-event-bus.js';
import { InputField } from '../../components/input-field.js';
import { ChannelRegistry } from '../../../integrations/channel-registry.js';
import { A2AConnectionsList } from '../a2a-connections.js';
import { A2ASetupWizard } from '../a2a-setup-wizard.js';
import { WhatsAppScreen } from '../whatsapp.js';
import { LocalModelWizard } from '../local-model-wizard.js';
import { AgentCreateWizard } from '../agent-create-wizard.js';
import { NotificationsScreen } from '../notifications.js';
import { AutomationsTab } from '../automations-tab.js';
import { AutomationDetail } from '../automation-detail.js';
import { AutomationCreateWizard } from '../automation-create-wizard.js';
import { SessionPicker } from '../session-picker.js';
import { TunnelSetupWizard } from '../tunnel-setup-wizard.js';
import { LicenseKeyWizard } from '../license-key-wizard.js';
import { GhlWebhook } from '../ghl-webhook.js';
import { ModelManager } from '../model-manager.js';
import { PeersScreen } from '../peers.js';
import { McpServers } from '../mcp-servers.js';
import { McpServerWizard } from '../mcp-server-wizard.js';
import { MediaGallery } from '../media-gallery.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DispatchOverlay } from '../../components/dispatch-overlay.js';
import type { OllamaModelSummary } from '../../../lib/ollama-monitor-types.js';
import { useOllamaModels } from '../../hooks/use-ollama-models.js';
import { useWorkspacePointerWatch } from '../../hooks/use-workspace-pointer-watch.js';
import { C } from '../../theme.js';
import { useAnimationTick } from '../../hooks/use-animation-frame.js';

import { SectionNav } from '../../components/section-nav.js';
import type { TeamSubTab, WorkSubTab } from '../../components/section-nav.js';
import { useBanner } from '../../hooks/use-completion-banner.js';
import { CompletionBanner } from '../../components/completion-banner.js';
import { GridMenuPanel } from './grid-menu.js';
import { ChatPanel } from './chat-panel.js';
import { ModelPicker } from './model-picker.js';
import { WorkspacePicker } from './workspace-picker.js';
import {
  writeWorkspacePointer,
  workspaceLayoutFor,
  portForWorkspace,
  allocateWorkspacePort,
  readWorkspaceConfig,
  writeWorkspaceConfig,
} from '../../../config.js';
import { spawn } from 'child_process';

type FocusZone = 'chat' | 'grid' | 'screen';

interface DashboardProps {
  config: RuntimeConfig;
  db: DatabaseAdapter;
  rawDb: Database.Database;
  needsOnboarding?: boolean;
  justOnboarded?: boolean;
  onStartOnboarding?: () => void;
  onConfigChange?: (config: RuntimeConfig) => void;
}

export function Dashboard({ config, db, rawDb, justOnboarded, onConfigChange }: DashboardProps) {
  const { exit } = useApp();
  // The TUI process is bound to whichever workspace was active at boot.
  // Read it once — it can't change mid-process, switching requires re-launch.
  const workspaceName = useMemo(() => resolveActiveWorkspace().name, []);
  const terminalCols = useTerminalSize();
  const dialogWidth = Math.min(56, terminalCols - 6);
  const runtime = useRuntime({ config, db, rawDb });
  const nav = useNavigation();
  const agents = useAgents(runtime.db, runtime.workspaceId);
  const tasks = useTasks(runtime.db, runtime.workspaceId);
  const contacts = useContacts(runtime.db, runtime.workspaceId);
  const health = useHealth(runtime.db, runtime.cloudConnected);
  const emptyChannels = useMemo(() => new ChannelRegistry(), []);
  const activeModel = config.modelSource === 'cloud'
    ? (config.cloudModel || 'claude-haiku-4-5-20251001')
    : (runtime.orchestratorModel || (config.anthropicApiKey ? 'claude-haiku-4-5' : (runtime.ollamaModel || 'ollama')));
  const orchestrator = useOrchestrator(
    runtime.initializing ? null : config.port,
    runtime.sessionToken,
    activeModel,
  );
  const ollamaModels = useOllamaModels(config.port);

  // When another session writes to ~/.ohwow/current-workspace, nudge the user.
  // We don't auto-relaunch — they might be typing, and /workspace is one key away.
  useWorkspacePointerWatch(workspaceName, useCallback((newName: string) => {
    orchestrator.addSystemMessage(
      `Workspace switched to "${newName}" in another session. ` +
      `You're still focused on "${workspaceName}". Type /workspace to switch.`,
    );
  }, [workspaceName, orchestrator]));

  // 4-section nav state
  const [activeSection, setActiveSection] = useState<Section>(Section.Today);

  // Sub-tab state for Team and Work sections
  const [teamSubTab, setTeamSubTab] = useState<TeamSubTab>('agents');
  const [workSubTab, setWorkSubTab] = useState<WorkSubTab>('tasks');

  // Focus zone state
  const [focusZone, setFocusZone] = useState<FocusZone>('chat');
  const [gridIndex, setGridIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [showPlan, setShowPlan] = useState(true);
  const [slashIdx, setSlashIdx] = useState(0);

  // Model picker state
  const [showModelPicker, setShowModelPicker] = useState(false);

  // Workspace picker state — opens via the /workspace slash command. On
  // selecting a different workspace, we write the pointer file, ensure that
  // workspace's daemon is running, then re-launch the TUI as a child process
  // (handing the terminal off) and exit ourselves.
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

  // Shortcut palette state
  const [showPalette, setShowPalette] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [paletteIdx, setPaletteIdx] = useState(0);

  // Elicitation dialog state
  const wsElicitation = useEvent('mcp:elicitation');
  const [elicitationValues, setElicitationValues] = useState<Record<string, string>>({});
  const [elicitationFieldIdx, setElicitationFieldIdx] = useState(0);

  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showDispatch, setShowDispatch] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [subTabFocused, setSubTabFocused] = useState(true);
  const [voiceProviders, setVoiceProviders] = useState<{
    stt: Array<{ name: string; label: string; available: boolean }>;
    tts: Array<{ name: string; label: string; available: boolean }>;
    anyAvailable: boolean;
    voiceboxAvailable: boolean;
  } | null>(null);
  const [voiceboxStarting, setVoiceboxStarting] = useState(false);
  const [voiceboxError, setVoiceboxError] = useState<string | null>(null);
  const [licenseRestartNeeded, setLicenseRestartNeeded] = useState(false);
  const [mcpAgentId, setMcpAgentId] = useState<string | null>(null);
  const [waNotification, setWaNotification] = useState<string | null>(null);
  const [creditWarning, setCreditWarning] = useState<string | null>(null);

  // Completion banner for task lifecycle events
  const { banner } = useBanner();

  // Subscribe to credit exhaustion events
  const creditExhaustedEvent = useEvent('credits:exhausted');
  useEffect(() => {
    if (!creditExhaustedEvent) return;
    setCreditWarning('Cloud credits exhausted. Tasks are running on your local model.');
    const timer = setTimeout(() => setCreditWarning(null), 10000);
    return () => clearTimeout(timer);
  }, [creditExhaustedEvent]);

  // Subscribe to incoming WhatsApp messages for transient notifications
  const waMessageEvent = useEvent('whatsapp:message');
  useEffect(() => {
    if (!waMessageEvent) return;
    const sender = waMessageEvent.from || 'Unknown';
    const preview = typeof waMessageEvent.text === 'string' && waMessageEvent.text.length > 60
      ? waMessageEvent.text.slice(0, 57) + '...'
      : waMessageEvent.text || '';
    setWaNotification(`WhatsApp from ${sender}: ${preview}`);
    const timer = setTimeout(() => setWaNotification(null), 5000);
    return () => clearTimeout(timer);
  }, [waMessageEvent]);

  // Proactive greeting: auto-send a contextual briefing when the TUI opens with a fresh session
  const [welcomeLoading, setWelcomeLoading] = useState(false);
  const welcomeFiredRef = useRef(false);
  useEffect(() => {
    if (welcomeFiredRef.current) return;
    if (orchestrator.isStreaming || orchestrator.messages.length > 0) return;
    // Wait until daemon is connected and agents have loaded
    if (!runtime.daemonConnectedAt) return;
    if (agents.list.length === 0) return;

    welcomeFiredRef.current = true;

    const agentCount = agents.list.length;
    const agentNames = agents.list.slice(0, 3).map(a => a.name).join(', ');

    // Contextual greeting based on workspace maturity
    const prompt = agentCount > 3
      ? `Give me a quick briefing. What's the current state of my workspace? Any tasks needing approval, active agents, or things that need my attention? Be concise.`
      : `I just finished setting up my workspace with ${agentCount} agent${agentCount !== 1 ? 's' : ''} (${agentNames}). What should I do first?`;

    orchestrator.sendWelcome(prompt);
  }, [runtime.daemonConnectedAt, orchestrator.isStreaming, orchestrator.messages.length, agents.list]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive agent info for contextual empty state
  const chatAgents = useMemo(() =>
    agents.list.map(a => ({ name: a.name, role: a.role })),
    [agents.list],
  );

  const isConnected = config.tier !== 'free';
  const gridScreens = getGridScreens(config.tier);

  // Merge SSE + WebSocket elicitation sources
  const activeElicitation: ElicitationRequest | null = orchestrator.elicitationRequest
    || (wsElicitation ? { requestId: wsElicitation.requestId, serverName: wsElicitation.serverName, message: wsElicitation.message, schema: wsElicitation.schema } : null);

  const elicitationFields = useMemo(() => {
    if (!activeElicitation?.schema) return [];
    const properties = (activeElicitation.schema as { properties?: Record<string, { type?: string; description?: string }> }).properties;
    if (!properties) return [];
    return Object.entries(properties).map(([name, prop]) => ({
      name,
      label: prop.description || name,
      type: prop.type || 'string',
    }));
  }, [activeElicitation?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset form state when a new elicitation arrives
  const prevElicitationId = useRef<string | null>(null);
  useEffect(() => {
    if (activeElicitation && activeElicitation.requestId !== prevElicitationId.current) {
      prevElicitationId.current = activeElicitation.requestId;
      setElicitationValues({});
      setElicitationFieldIdx(0);
    } else if (!activeElicitation) {
      prevElicitationId.current = null;
    }
  }, [activeElicitation?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isHome = nav.screen === Screen.Chat;

  // Slash commands
  const slashCommands: SlashCommand[] = useMemo(() => {
    return [
      { command: '/dashboard', label: 'Open Dashboard', action: () => openScreen(Screen.Dashboard) },
      { command: '/agents', label: 'Open Agents', action: () => openScreen(Screen.Agents) },
      { command: '/tasks', label: 'Open Tasks', action: () => openScreen(Screen.Tasks) },
      { command: '/contacts', label: 'Open Contacts', action: () => openScreen(Screen.Contacts) },
      { command: '/people', label: 'Open People', action: () => openScreen(Screen.People) },
      { command: '/activity', label: 'Open Activity', action: () => openScreen(Screen.Activity) },
      { command: '/automations', label: 'Open Automations', action: () => openScreen(Screen.Automations) },
      { command: '/approvals', label: 'Open Approvals', action: () => openScreen(Screen.Approvals) },
      { command: '/settings', label: 'Open Settings', action: () => openScreen(Screen.Settings) },
      { command: '/media', label: 'Open Media Gallery', action: () => openScreen(Screen.MediaGallery) },
      { command: '/model', label: 'Switch model', action: () => setShowModelPicker(true) },
      { command: '/workspace', label: 'Switch workspace', action: () => setShowWorkspacePicker(true) },
      { command: '/sessions', label: 'Browse past conversations', action: () => openScreen(Screen.Sessions) },
      { command: '/rename', label: 'Rename current session', action: () => { setRenaming(true); setRenameValue(orchestrator.sessionTitle); } },
      { command: '/new', label: 'New chat session', action: () => orchestrator.newSession() },
      { command: '/clear', label: 'Clear chat', action: () => orchestrator.newSession() },
      { command: '/device', label: 'Device stats (CPU, GPU, memory)', action: () => openScreen(Screen.Device) },
      { command: '/restart', label: 'Restart daemon', action: () => { restartDaemon(); } },
      { command: '/stop', label: 'Stop runtime and exit', action: () => { stopRuntime(); } },
      { command: '/help', label: 'List all commands', action: () => {} },
    ];
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showSlash = isHome && focusZone === 'chat' && inputValue.startsWith('/');
  const filteredSlash = showSlash ? getFilteredCommands(inputValue, slashCommands) : [];
  const filteredPaletteCommands = useMemo(() =>
    getFilteredPaletteCommands(paletteFilter, slashCommands),
    [paletteFilter, slashCommands]
  );

  const voiceLoadedRef = useRef(false);


  function openScreen(screen: Screen) {
    setFocusZone('screen');
    nav.goToTab(screen);
  }

  function goHome() {
    setFocusZone('chat');
    nav.goToTab(Screen.Chat);
  }

  const restartDaemon = useCallback(async () => {
    const dataDir = dirname(config.dbPath);
    orchestrator.addSystemMessage('Stopping daemon...');

    await stopDaemon(dataDir);
    const stopped = await waitForDaemonStop(dataDir, 5000);
    if (!stopped) {
      orchestrator.addSystemMessage('Couldn\'t stop the daemon. It may need to be killed manually.');
      return;
    }
    orchestrator.addSystemMessage('Daemon stopped. Starting new instance...');

    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(thisDir, 'index.js'),
      join(thisDir, '..', '..', '..', 'index.js'),
      join(thisDir, '..', '..', '..', 'index.ts'),
    ];
    const entryPath = candidates.find(p => existsSync(p));
    if (!entryPath) {
      orchestrator.addSystemMessage('Couldn\'t find daemon entry point.');
      return;
    }

    startDaemonBackground(entryPath, config.port, dataDir);
    const ready = await waitForDaemon(config.port, 15000);
    if (!ready) {
      orchestrator.addSystemMessage('Daemon didn\'t come back up. Try restarting ohwow.');
      return;
    }

    // Refresh runtime state (header PID, uptime, connection indicators)
    await runtime.refreshStatus();

    // Fetch detailed status to report in chat
    try {
      const newToken = await getDaemonSessionToken(dataDir);
      const token = newToken || runtime.sessionToken;
      const resp = await fetch(`http://localhost:${config.port}/api/daemon/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const s = await resp.json() as { pid?: number; port?: number; ollamaConnected?: boolean; ollamaModel?: string; cloudConnected?: boolean; tunnelUrl?: string };
        const lines = [
          `Daemon restarted (PID ${s.pid}, port ${s.port})`,
          `  Ollama: ${s.ollamaConnected ? `connected (${s.ollamaModel})` : 'not available'}`,
          s.cloudConnected ? '  Cloud: connected' : null,
          s.tunnelUrl ? `  Tunnel: ${s.tunnelUrl}` : null,
        ].filter(Boolean);
        orchestrator.addSystemMessage(lines.join('\n'));
      } else {
        orchestrator.addSystemMessage('Daemon restarted.');
      }
    } catch {
      orchestrator.addSystemMessage('Daemon restarted.');
    }
  }, [config.dbPath, config.port, orchestrator, runtime]);

  const switchWorkspace = useCallback(async (newName: string) => {
    if (newName === workspaceName) {
      orchestrator.addSystemMessage(`Already on workspace "${newName}".`);
      setShowWorkspacePicker(false);
      return;
    }

    setShowWorkspacePicker(false);
    orchestrator.addSystemMessage(`Switching focus to workspace "${newName}"...`);

    // 1. Write pointer file so future TUI/MCP launches default to this workspace.
    try {
      writeWorkspacePointer(newName);
    } catch (err) {
      orchestrator.addSystemMessage(`Couldn't update workspace pointer: ${err instanceof Error ? err.message : err}`);
      return;
    }

    // 2. Ensure target workspace's daemon is running. Allocate + persist
    //    a port if this is the workspace's first start.
    const targetLayout = workspaceLayoutFor(newName);
    let targetPort = portForWorkspace(newName);
    if (targetPort === null) {
      try {
        targetPort = allocateWorkspacePort();
        const cfg = readWorkspaceConfig(newName);
        writeWorkspaceConfig(newName, cfg
          ? { ...cfg, port: targetPort }
          : { schemaVersion: 1, mode: 'local-only', port: targetPort });
      } catch (err) {
        orchestrator.addSystemMessage(`Couldn't allocate port: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    const status = await isDaemonRunning(targetLayout.dataDir, targetPort);
    if (!status.running) {
      orchestrator.addSystemMessage(`Starting daemon for "${newName}" on :${targetPort}...`);
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const candidates = [
        join(thisDir, 'index.js'),
        join(thisDir, '..', '..', '..', 'index.js'),
        join(thisDir, '..', '..', '..', 'index.ts'),
      ];
      const entryPath = candidates.find(p => existsSync(p));
      if (!entryPath) {
        orchestrator.addSystemMessage("Couldn't find daemon entry point — switch aborted.");
        return;
      }
      // The lifecycle's startDaemonBackground reads OHWOW_WORKSPACE from the
      // parent env, so set it before spawning the child.
      const previousWsEnv = process.env.OHWOW_WORKSPACE;
      process.env.OHWOW_WORKSPACE = newName;
      try {
        startDaemonBackground(entryPath, targetPort, targetLayout.dataDir);
      } finally {
        // Restore so this still-living TUI keeps its identity until exit.
        if (previousWsEnv === undefined) delete process.env.OHWOW_WORKSPACE;
        else process.env.OHWOW_WORKSPACE = previousWsEnv;
      }
      const ready = await waitForDaemon(targetPort, 15000);
      if (!ready) {
        orchestrator.addSystemMessage(`Daemon for "${newName}" didn't come up in time — switch aborted.`);
        return;
      }
    }

    // 3. Re-launch the TUI as a detached child pointing at the new
    //    workspace, then exit ourselves. The child takes over the terminal
    //    on exit() — same trick the existing daemon spawner uses.
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const entryCandidates = [
      join(thisDir, '..', '..', '..', 'index.js'),
      join(thisDir, '..', '..', '..', '..', 'bin', 'ohwow.js'),
    ];
    const entryPath = entryCandidates.find(p => existsSync(p));
    if (!entryPath) {
      orchestrator.addSystemMessage(
        `Switched focus to "${newName}". Run \`ohwow\` to enter the new workspace's TUI.`,
      );
      setTimeout(() => exit(), 500);
      return;
    }

    orchestrator.addSystemMessage(`Handing off TUI to "${newName}"...`);
    // Give Ink a moment to flush the message before we tear the screen down.
    setTimeout(() => {
      const child = spawn(process.execPath, [entryPath], {
        stdio: 'inherit',
        detached: true,
        env: { ...process.env, OHWOW_WORKSPACE: newName },
      });
      child.unref();
      exit();
    }, 300);
  }, [workspaceName, orchestrator, exit]);

  const stopRuntime = useCallback(async () => {
    const dataDir = dirname(config.dbPath);
    orchestrator.addSystemMessage('Shutting down...');

    await stopDaemon(dataDir);
    const stopped = await waitForDaemonStop(dataDir, 5000);
    if (!stopped) {
      orchestrator.addSystemMessage('Couldn\'t stop the daemon. It may need to be killed manually.');
      return;
    }

    exit();
  }, [config.dbPath, orchestrator, exit]);

  const fetchVoiceProviders = useCallback(async () => {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.port}/api/voice/providers`, {
        signal: AbortSignal.timeout(5000),
      });
      const json = await resp.json() as { data?: typeof voiceProviders };
      if (json?.data) {
        setVoiceProviders(json.data);
        voiceLoadedRef.current = true;
      }
    } catch {
      // Voice providers not available yet
    }
  }, [config.port]);

  useEffect(() => {
    let cancelled = false;
    let pollInterval: NodeJS.Timeout | undefined;
    const initialTimer = setTimeout(async () => {
      if (cancelled) return;
      await fetchVoiceProviders();
      if (!cancelled && !voiceLoadedRef.current) {
        pollInterval = setInterval(async () => {
          if (cancelled || voiceLoadedRef.current) {
            if (pollInterval) clearInterval(pollInterval);
            return;
          }
          await fetchVoiceProviders();
        }, 10000);
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [fetchVoiceProviders]);

  // Handle switchTab signal from orchestrator
  if (orchestrator.switchTabSignal) {
    const tabMap: Record<string, Screen> = {
      dashboard: Screen.Dashboard,
      agents: Screen.Agents,
      tasks: Screen.Tasks,
      contacts: Screen.Contacts,
      approvals: Screen.Approvals,
      activity: Screen.Activity,
      settings: Screen.Settings,
      chat: Screen.Chat,
      automations: Screen.Automations,
      'a2a-connections': Screen.A2AConnections,
      peers: Screen.Peers,
      whatsapp: Screen.WhatsApp,
    };
    const target = tabMap[orchestrator.switchTabSignal];
    if (target) {
      if (target === Screen.Chat) {
        goHome();
      } else {
        openScreen(target);
      }
    }
    orchestrator.clearSwitchTab();
  }

  // Main keyboard handler
  useInput((input, key) => {
    if (showQuitConfirm) return;

    // Permission dialog intercepts all input
    if (orchestrator.permissionRequest) {
      if (input === 'y' || input === 'Y') {
        orchestrator.resolvePermission(orchestrator.permissionRequest.requestId, true);
      } else if (input === 'n' || input === 'N' || key.escape) {
        orchestrator.resolvePermission(orchestrator.permissionRequest.requestId, false);
      }
      return;
    }

    // Cost confirmation dialog intercepts all input
    if (orchestrator.costConfirmation) {
      if (input === 'y' || input === 'Y') {
        orchestrator.resolveCostApproval(orchestrator.costConfirmation.requestId, true);
      } else if (input === 'n' || input === 'N' || key.escape) {
        orchestrator.resolveCostApproval(orchestrator.costConfirmation.requestId, false);
      } else if (input === 'a' || input === 'A') {
        updateConfigFile({ skipMediaCostConfirmation: true });
        fetch(`http://127.0.0.1:${config.port}/api/set-cost-confirmation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skip: true }),
        }).catch(() => {});
        orchestrator.resolveCostApproval(orchestrator.costConfirmation.requestId, true);
      }
      return;
    }

    // Elicitation dialog intercepts all input
    if (activeElicitation) {
      if (elicitationFields.length === 0) {
        // Simple accept/decline (no fields)
        if (input === 'y' || input === 'Y') {
          orchestrator.resolveElicitation(activeElicitation.requestId, true);
        } else if (input === 'n' || input === 'N' || key.escape) {
          orchestrator.resolveElicitation(activeElicitation.requestId, false);
        }
      } else {
        // Multi-field form — Tab/j/k navigate, Enter submits, Esc declines
        if (key.escape) {
          orchestrator.resolveElicitation(activeElicitation.requestId, false);
        } else if (key.tab) {
          setElicitationFieldIdx(i => (i + 1) % elicitationFields.length);
        } else if (key.return) {
          const fields: Record<string, unknown> = {};
          for (const f of elicitationFields) {
            fields[f.name] = elicitationValues[f.name] || '';
          }
          orchestrator.resolveElicitation(activeElicitation.requestId, true, fields);
        }
        // TextInput handles actual character input for the focused field
      }
      return;
    }

    // Dispatch overlay intercepts all input when open
    if (showDispatch) return;

    // Model picker handles its own input via its useInput hook
    if (showModelPicker) return;
    if (showWorkspacePicker) return;

    // Shortcut palette intercepts all input when open
    if (showPalette) {
      if (key.escape) { setShowPalette(false); setPaletteFilter(''); return; }
      if (key.upArrow) { setPaletteIdx(i => Math.max(i - 1, 0)); return; }
      if (key.downArrow) { setPaletteIdx(i => Math.min(i + 1, filteredPaletteCommands.length - 1)); return; }
      if (key.return && filteredPaletteCommands.length > 0) {
        const cmd = filteredPaletteCommands[paletteIdx];
        if (cmd) {
          cmd.action();
          setShowPalette(false);
          setPaletteFilter('');
          setPaletteIdx(0);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setPaletteFilter(f => f.slice(0, -1));
        setPaletteIdx(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setPaletteFilter(f => f + input);
        setPaletteIdx(0);
        return;
      }
      return;
    }

    // ==================
    // SECTION nav: 1-4 keys switch sections from anywhere
    // (skipped when typing in chat input or slash command open)
    // ==================
    if (!orchestrator.isStreaming && !inputValue && !showSlash) {
      if (input === '1') { setActiveSection(Section.Today); goHome(); return; }
      if (input === '2') {
        setActiveSection(Section.Team);
        // Route to the current teamSubTab's screen
        if (teamSubTab === 'contacts') { openScreen(Screen.Contacts); }
        else if (teamSubTab === 'people') { openScreen(Screen.People); }
        else { openScreen(Screen.Agents); }
        return;
      }
      if (input === '3') {
        setActiveSection(Section.Work);
        // Route to the current workSubTab's screen
        if (workSubTab === 'activity') { openScreen(Screen.Activity); }
        else if (workSubTab === 'automations') { openScreen(Screen.Automations); }
        else { openScreen(Screen.Tasks); }
        return;
      }
      if (input === '4') { setActiveSection(Section.Settings); openScreen(Screen.Settings); return; }

      // Global 'd' — floating dispatch overlay (TRIO-10)
      if (input === 'd') {
        setShowDispatch(true);
        return;
      }
    }

    // ==================
    // CHAT focus zone
    // ==================
    if (isHome && focusZone === 'chat') {
      // Slash command navigation
      if (showSlash) {
        if (key.upArrow) {
          setSlashIdx(i => Math.max(i - 1, 0));
          return;
        }
        if (key.downArrow) {
          setSlashIdx(i => Math.min(i + 1, filteredSlash.length - 1));
          return;
        }
        if (key.return && filteredSlash.length > 0) {
          const cmd = filteredSlash[slashIdx];
          if (cmd) {
            cmd.action();
            setInputValue('');
            setSlashIdx(0);
          }
          return;
        }
        if (key.escape) {
          setInputValue('');
          setSlashIdx(0);
          return;
        }
        // Let text input handle other keys
        return;
      }

      // ESC during rename: cancel rename
      if (key.escape && renaming) {
        setRenaming(false);
        setRenameValue('');
        return;
      }

      // ESC: stop streaming or quit confirm
      if (key.escape) {
        if (orchestrator.isStreaming) {
          orchestrator.stopStreaming();
        } else {
          setShowQuitConfirm(true);
        }
        return;
      }

      // Down arrow → grid
      if (key.downArrow && !orchestrator.isStreaming) {
        setFocusZone('grid');
        return;
      }

      // Ctrl+N new session
      if (key.ctrl && input === 'n' && !orchestrator.isStreaming) {
        orchestrator.newSession();
        return;
      }

      // Ctrl+O model picker
      if (key.ctrl && input === 'o' && !orchestrator.isStreaming) {
        setShowModelPicker(true);
        return;
      }

      // Ctrl+T toggle plan
      if (key.ctrl && input === 't') {
        setShowPlan(prev => !prev);
        return;
      }

      // '?' shortcut for command palette (when not streaming and input is empty)
      if (input === '?' && !orchestrator.isStreaming && !inputValue) {
        setShowPalette(true);
        setPaletteFilter('');
        setPaletteIdx(0);
        return;
      }

      return;
    }

    // ==================
    // GRID focus zone
    // ==================
    if (isHome && focusZone === 'grid') {
      const cols = GRID_COLS;
      const total = gridScreens.length;

      if (key.escape || key.upArrow && gridIndex < cols) {
        setFocusZone('chat');
        return;
      }

      if (key.upArrow) { setGridIndex(i => Math.max(i - cols, 0)); return; }
      if (key.downArrow) { setGridIndex(i => Math.min(i + cols, total - 1)); return; }
      if (key.leftArrow) { setGridIndex(i => Math.max(i - 1, 0)); return; }
      if (key.rightArrow) { setGridIndex(i => Math.min(i + 1, total - 1)); return; }

      // Number keys for quick select
      const num = parseInt(input, 10);
      if (num >= 1 && num <= total) {
        setGridIndex(num - 1);
        openScreen(gridScreens[num - 1]);
        return;
      }

      if (key.return) {
        openScreen(gridScreens[gridIndex]);
        return;
      }

      return;
    }

    // ==================
    // SCREEN focus zone
    // ==================
    if (focusZone === 'screen') {
      // ESC from detail views goes back
      if (key.escape && nav.isDetail) {
        nav.goBack();
        // If goBack brought us to Chat, switch to chat zone
        // (navigation hook now returns to Chat when stack empties)
        return;
      }

      // ESC from top-level screens goes home
      if (key.escape && !nav.isDetail) {
        goHome();
        return;
      }

      // Sub-tab navigation for screens that have sub-tabs
      const hasSubTabs = nav.screen === Screen.Settings || nav.screen === Screen.Automations;
      if (hasSubTabs && key.upArrow && subTabFocused) {
        setSubTabFocused(false);
        return;
      }
      if (hasSubTabs && key.downArrow && !subTabFocused) {
        setSubTabFocused(true);
        return;
      }

      // ==================
      // TEAM section sub-tabs (key 2 screens)
      // ==================
      const isTeamScreen = activeSection === Section.Team && !nav.isDetail;
      if (isTeamScreen) {
        if (input === 'a' && nav.screen !== Screen.Agents) {
          setTeamSubTab('agents');
          nav.goToTab(Screen.Agents);
          return;
        }
        if (input === 'c' && nav.screen !== Screen.Contacts) {
          setTeamSubTab('contacts');
          nav.goToTab(Screen.Contacts);
          return;
        }
        if (input === 'p' && nav.screen !== Screen.People) {
          setTeamSubTab('people');
          nav.goToTab(Screen.People);
          return;
        }
      }

      // ==================
      // WORK section sub-tabs (key 3 screens)
      // ==================
      const isWorkScreen = activeSection === Section.Work && !nav.isDetail;
      if (isWorkScreen) {
        if (input === 't' && nav.screen !== Screen.Tasks) {
          setWorkSubTab('tasks');
          nav.goToTab(Screen.Tasks);
          return;
        }
        if (input === 'v' && nav.screen !== Screen.Activity) {
          setWorkSubTab('activity');
          nav.goToTab(Screen.Activity);
          return;
        }
        if (input === 'x' && nav.screen !== Screen.Automations) {
          setWorkSubTab('automations');
          nav.goToTab(Screen.Automations);
          return;
        }
      }

      // Quit
      if (input === 'q') {
        setShowQuitConfirm(true);
        return;
      }

      // '?' opens command palette from screen zone too
      if (input === '?') {
        setShowPalette(true);
        setPaletteFilter('');
        setPaletteIdx(0);
        return;
      }

      // New task shortcut
      if (input === 'n' && nav.screen === Screen.Tasks) {
        nav.goTo(Screen.TaskDispatch);
        return;
      }

      // New agent shortcut — use 'n' on Agents screen (consistent with tasks 'n' for new)
      if (input === 'n' && !nav.isDetail && nav.screen === Screen.Agents) {
        nav.goTo(Screen.AgentCreate);
        return;
      }

      // Local model setup
      if (input === 'o' && !nav.isDetail) {
        nav.goTo(Screen.LocalModelSetup);
        return;
      }

      // Model manager
      if (input === 'm' && !nav.isDetail) {
        nav.goTo(Screen.ModelManager);
        return;
      }

      // Settings sub-screens
      if (nav.screen === Screen.Settings) {
        if (input === 'c') { setMcpAgentId(null); nav.goTo(Screen.McpServers); return; }
        if (input === 'v') {
          setVoiceboxStarting(true);
          setVoiceboxError(null);
          fetch(`http://127.0.0.1:${config.port}/api/voice/start`, {
            method: 'POST',
            signal: AbortSignal.timeout(10000),
          })
            .then(async () => {
              await new Promise(r => setTimeout(r, 1000));
              await fetchVoiceProviders();
            })
            .catch((err: Error) => {
              setVoiceboxError(err.message || 'Voicebox startup failed');
            })
            .finally(() => setVoiceboxStarting(false));
          return;
        }
        if (input === 'l' && !isConnected) { nav.goTo(Screen.LicenseKeySetup); return; }
        if (input === 'u') { nav.goTo(Screen.TunnelSetup); return; }
        if (input === 'g') { nav.goTo(Screen.GhlWebhook); return; }
        if (input === 'r') { nav.goTo(Screen.Peers); return; }
        if (input === 'a') { nav.goTo(Screen.A2AConnections); return; }
        if (input === 'p') { nav.goTo(Screen.WhatsApp); return; }
        if (input === 'i') { nav.goTo(Screen.Notifications); return; }
      }
    }
  });

  // When nav changes away from Chat, ensure we're in screen zone
  useEffect(() => {
    if (nav.screen !== Screen.Chat && focusZone !== 'screen') {
      setFocusZone('screen');
    }
    if (nav.screen === Screen.Chat && focusZone === 'screen') {
      setFocusZone('chat');
    }
  }, [nav.screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync active section (and sub-tabs) when screen changes via slash commands or orchestrator signals
  useEffect(() => {
    if (nav.screen === Screen.Chat) {
      setActiveSection(Section.Today);
    } else if (nav.screen === Screen.Agents || nav.screen === Screen.Contacts || nav.screen === Screen.People || nav.screen === Screen.A2AConnections || nav.screen === Screen.A2ASetup) {
      setActiveSection(Section.Team);
      if (nav.screen === Screen.Contacts) setTeamSubTab('contacts');
      else if (nav.screen === Screen.People) setTeamSubTab('people');
      else if (nav.screen === Screen.Agents) setTeamSubTab('agents');
    } else if (nav.screen === Screen.Tasks || nav.screen === Screen.Activity || nav.screen === Screen.Approvals || nav.screen === Screen.Sessions || nav.screen === Screen.Automations || nav.screen === Screen.AutomationDetail || nav.screen === Screen.AutomationCreate || nav.screen === Screen.TaskDispatch || nav.screen === Screen.AgentCreate) {
      setActiveSection(Section.Work);
      if (nav.screen === Screen.Activity) setWorkSubTab('activity');
      else if (nav.screen === Screen.Automations || nav.screen === Screen.AutomationDetail || nav.screen === Screen.AutomationCreate) setWorkSubTab('automations');
      else if (nav.screen === Screen.Tasks || nav.screen === Screen.TaskDispatch) setWorkSubTab('tasks');
    } else if (nav.screen === Screen.Settings || nav.screen === Screen.LocalModelSetup || nav.screen === Screen.TunnelSetup || nav.screen === Screen.LicenseKeySetup || nav.screen === Screen.GhlWebhook || nav.screen === Screen.ModelManager || nav.screen === Screen.McpServers || nav.screen === Screen.McpServerSetup || nav.screen === Screen.WhatsApp || nav.screen === Screen.WhatsAppSetup || nav.screen === Screen.Notifications || nav.screen === Screen.Peers || nav.screen === Screen.Device) {
      setActiveSection(Section.Settings);
    }
  }, [nav.screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleQuitConfirm = (confirmed: boolean) => {
    setShowQuitConfirm(false);
    if (confirmed) {
      runtime.shutdown();
      exit();
    }
  };

  // Render a full-screen view (non-chat)
  const renderScreen = () => {
    switch (nav.screen) {
      case Screen.Dashboard:
        return (
          <DashboardOverview
            health={health}
            agents={agents.list}
            tasks={tasks.list}
            onAgentSelect={(id) => nav.goTo(Screen.AgentDetail, id)}
            onTaskSelect={(id) => nav.goTo(Screen.TaskDetail, id)}
            port={config.port}
            ollamaConnected={runtime.ollamaConnected}
            modelReady={runtime.modelReady}
            sessionToken={runtime.sessionToken}
            models={ollamaModels}
          />
        );
      case Screen.Agents: {
        const model = runtime.orchestratorModel || (config.anthropicApiKey ? 'claude-haiku-4-5' : (runtime.ollamaModel || 'ollama'));
        const orchestratorAgent = {
          id: 'orchestrator',
          name: 'Orchestrator',
          role: model,
          status: 'idle',
          stats: {} as Record<string, unknown>,
        };
        return (
          <AgentsList
            agents={[orchestratorAgent, ...agents.list]}
            onSelect={(id) => {
              if (id === 'orchestrator') return;
              nav.goTo(Screen.AgentDetail, id);
            }}
          />
        );
      }
      case Screen.Tasks:
        return (
          <TasksList
            tasks={tasks.list}
            agents={agents.list}
            onSelect={(id) => nav.goTo(Screen.TaskDetail, id)}
          />
        );
      case Screen.Contacts:
        return (
          <ContactsList
            contacts={contacts.list}
            onSelect={(id) => nav.goTo(Screen.ContactDetail, id)}
          />
        );
      case Screen.ContactDetail:
        return (
          <ContactDetail
            contactId={nav.detailId!}
            db={runtime.db}
            workspaceId={runtime.workspaceId}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.People:
        return (
          <PeopleList
            db={runtime.db}
            workspaceId={runtime.workspaceId}
          />
        );
      case Screen.Approvals:

        return (
          <ApprovalsList
            db={runtime.db}
            controlPlane={null}
            onSelect={(id) => nav.goTo(Screen.TaskDetail, id)}
          />
        );
      case Screen.Activity:
        return <ActivityLog db={runtime.db} />;
      case Screen.Settings:
        return (
          <Settings
            config={config}
            health={health}
            cloudConnected={runtime.cloudConnected}
            whatsappStatus={{ status: runtime.whatsappStatus, phoneNumber: null }}
            ollamaConnected={runtime.ollamaConnected}
            ollamaModel={runtime.ollamaModel}
            modelReady={runtime.modelReady}
            tunnelUrl={runtime.tunnelUrl}
            cloudWebhookBaseUrl={runtime.cloudWebhookBaseUrl}
            voiceProviders={voiceProviders}
            voiceboxStarting={voiceboxStarting}
            voiceboxError={voiceboxError}
            subTabFocused={subTabFocused}
            onMcpServers={() => { setMcpAgentId(null); nav.goTo(Screen.McpServers); }}
            onConfigChange={onConfigChange}
          />
        );
      case Screen.WhatsApp:

        return (
          <WhatsAppScreen
            apiFetch={async (path, options) => {
              const res = await fetch(`http://localhost:${config.port}${path}`, {
                ...options,
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${runtime.sessionToken}`,
                  ...(options?.headers ?? {}),
                },
              });
              if (!res.ok) {
                const body = await res.json().catch(() => ({ error: res.statusText }));
                throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
              }
              return res.json() as Promise<never>;
            }}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.Peers:
        return (
          <PeersScreen
            db={runtime.db}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.A2AConnections:

        return (
          <A2AConnectionsList
            db={runtime.db}
            workspaceId={runtime.workspaceId}
            onSetup={() => nav.goTo(Screen.A2ASetup)}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.A2ASetup:

        return (
          <A2ASetupWizard
            db={runtime.db}
            workspaceId={runtime.workspaceId}
            onComplete={() => nav.goBack()}
            onCancel={() => nav.goBack()}
          />
        );
      case Screen.AgentDetail:
        return (
          <AgentDetail
            agentId={nav.detailId!}
            db={runtime.db}
            onBack={() => nav.goBack()}
            onMcpServers={() => {
              setMcpAgentId(nav.detailId!);
              nav.goTo(Screen.McpServers, nav.detailId!);
            }}
          />
        );
      case Screen.TaskDetail:
        return (
          <TaskDetail
            taskId={nav.detailId!}
            db={runtime.db}
            workspaceId={runtime.workspaceId}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.TaskDispatch:
        return (
          <TaskDispatch
            agents={agents.list}
            db={runtime.db}
            engine={null}
            tier={config.tier}
            modelReady={runtime.modelReady}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.Notifications:

        return (
          <NotificationsScreen
            db={runtime.db!}
            channels={emptyChannels}
            controlPlane={null}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.Automations:

        return (
          <AutomationsTab
            db={runtime.db}
            engine={null}
            workspaceId={runtime.workspaceId}
            onSelectTrigger={(id) => nav.goTo(Screen.AutomationDetail, id)}
            onCreateTrigger={() => nav.goTo(Screen.AutomationCreate)}
            subTabFocused={subTabFocused}
          />
        );
      case Screen.AutomationDetail:

        return (
          <AutomationDetail
            triggerId={nav.detailId!}
            db={runtime.db}
            onBack={() => nav.goBack()}
            onEdit={(id) => nav.goTo(Screen.AutomationCreate, id)}
          />
        );
      case Screen.AutomationCreate:

        return (
          <AutomationCreateWizard
            db={runtime.db}
            editTriggerId={nav.detailId}
            ollamaModel={runtime.ollamaModel}
            hasAnthropicApiKey={!!config.anthropicApiKey}
            onComplete={() => nav.goBack()}
            onCancel={() => nav.goBack()}
          />
        );
      case Screen.AgentCreate:
        return (
          <AgentCreateWizard
            db={runtime.db}
            workspaceId={runtime.workspaceId}
            onComplete={() => nav.goBack()}
            onCancel={() => nav.goBack()}
          />
        );
      case Screen.LocalModelSetup:
        return (
          <LocalModelWizard
            ollamaUrl={config.ollamaUrl}
            onComplete={async () => { nav.goBack(); }}
            onCancel={() => nav.goBack()}
          />
        );
      case Screen.TunnelSetup:
        return (
          <TunnelSetupWizard
            port={config.port}
            tunnelUrl={runtime.tunnelUrl}
            cloudWebhookBaseUrl={runtime.cloudWebhookBaseUrl}
            onStartTunnel={async () => {}}
            onStopTunnel={() => {}}
            onComplete={() => nav.goBack()}
            onCancel={() => nav.goBack()}
          />
        );
      case Screen.LicenseKeySetup:
        return (
          <LicenseKeyWizard
            onComplete={(key) => {
              config.licenseKey = key;
              config.tier = 'connected';
              if (runtime.db) {
                runtime.db.from('runtime_settings')
                  .select('key')
                  .eq('key', 'license_key')
                  .maybeSingle()
                  .then(({ data: existing }) => {
                    if (existing) {
                      runtime.db!.from('runtime_settings')
                        .update({ value: key, updated_at: new Date().toISOString() })
                        .eq('key', 'license_key')
                        .then(() => {});
                    } else {
                      runtime.db!.from('runtime_settings')
                        .insert({ key: 'license_key', value: key })
                        .then(() => {});
                    }
                  });
              }
              setLicenseRestartNeeded(true);
              nav.goBack();
            }}
            onCancel={() => nav.goBack()}
          />
        );
      case Screen.ModelManager:
        return (
          <ModelManager
            port={config.port}
            sessionToken={runtime.sessionToken}
            onBack={() => nav.goBack()}
            modelSource={config.modelSource}
            anthropicApiKey={config.anthropicApiKey}
            cloudModel={config.cloudModel}
          />
        );
      case Screen.GhlWebhook:
        return (
          <GhlWebhook
            db={runtime.db}
            port={config.port}
            tunnelUrl={runtime.tunnelUrl}
            cloudWebhookBaseUrl={runtime.cloudWebhookBaseUrl}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.McpServers:
        return (
          <McpServers
            agentId={mcpAgentId}
            db={runtime.db}
            onSetup={() => nav.goTo(Screen.McpServerSetup)}
            onBack={() => nav.goBack()}
          />
        );
      case Screen.McpServerSetup:
        return (
          <McpServerWizard
            agentId={mcpAgentId}
            db={runtime.db}
            onComplete={() => nav.goBack()}
            onCancel={() => nav.goBack()}
          />
        );
      case Screen.MediaGallery:
        return (
          <MediaGallery
            onBack={() => nav.goBack()}
          />
        );
      case Screen.Sessions:
        return (
          <SessionPicker
            daemonPort={config.port}
            sessionToken={runtime.sessionToken}
            onSelect={(id) => {
              orchestrator.loadSession(id);
              goHome();
            }}
            onBack={() => goHome()}
          />
        );
      case Screen.Device:
        return <ResourcesTab port={config.port} />;
      default:
        return <Text color="red">Unknown screen</Text>;
    }
  };

  // Derive section label for the persistent status bar
  const getSectionLabel = (): string => {
    switch (activeSection) {
      case Section.Today: return 'TODAY';
      case Section.Team: return 'TEAM';
      case Section.Work: return 'WORK';
      case Section.Settings: return 'SETTINGS';
      default: return 'TODAY';
    }
  };

  // Derive optional subsection label (only shown in non-home screens)
  const getSubsectionLabel = (): string | undefined => {
    if (!isHome) {
      if (activeSection === Section.Team) {
        if (teamSubTab === 'contacts') return 'Contacts';
        if (teamSubTab === 'people') return 'People';
        return 'Agents';
      }
      if (activeSection === Section.Work) {
        if (workSubTab === 'activity') return 'Activity';
        if (workSubTab === 'automations') return 'Automations';
        return 'Tasks';
      }
    }
    return undefined;
  };

  // Context-specific extra hints appended to the universal status bar
  const getExtraHints = (): KeyHint[] => {
    if (isHome && focusZone === 'chat') {
      const hints: KeyHint[] = [];
      if (orchestrator.isStreaming) hints.push({ key: 'Esc', label: 'stop stream' });
      hints.push({ key: 'Ctrl+N', label: 'new chat' });
      hints.push({ key: 'Ctrl+O', label: 'model' });
      return hints;
    }

    if (isHome && focusZone === 'grid') {
      return [
        { key: 'Arrows', label: 'navigate' },
        { key: '1-' + gridScreens.length, label: 'quick open' },
      ];
    }

    // Screen zone context extras
    const hints: KeyHint[] = [];

    if (nav.screen === Screen.Tasks) {
      hints.push({ key: 'n', label: 'new task' });
      hints.push({ key: 'v', label: 'activity' });
      hints.push({ key: 'x', label: 'automations' });
    }

    if (nav.screen === Screen.Agents) {
      hints.push({ key: 'n', label: 'new agent' });
      hints.push({ key: 'c', label: 'contacts' });
      hints.push({ key: 'p', label: 'people' });
    }

    if (nav.screen === Screen.Contacts) {
      hints.push({ key: 'a', label: 'agents' });
      hints.push({ key: 'p', label: 'people' });
    }

    if (nav.screen === Screen.People) {
      hints.push({ key: 'a', label: 'agents' });
      hints.push({ key: 'c', label: 'contacts' });
    }

    if (nav.screen === Screen.Activity) {
      hints.push({ key: 't', label: 'tasks' });
      hints.push({ key: 'x', label: 'automations' });
    }

    if (nav.screen === Screen.Automations) {
      hints.push({ key: 't', label: 'tasks' });
      hints.push({ key: 'v', label: 'activity' });
    }

    if (nav.screen === Screen.Approvals) {
      hints.push({ key: 'a', label: 'approve' });
      hints.push({ key: 'r', label: 'reject' });
    }

    if (nav.screen === Screen.Settings) {
      hints.push({ key: 'm', label: 'models' });
      hints.push({ key: 'v', label: 'voicebox' });
      hints.push({ key: 'u', label: 'tunnel' });
      if (!isConnected) hints.push({ key: 'l', label: 'cloud' });
    }

    if (nav.screen === Screen.Dashboard) {
      hints.push({ key: 'm', label: 'models' });
      hints.push({ key: 'o', label: 'local AI' });
    }

    hints.push({ key: 'q', label: 'quit' });
    return hints;
  };

  // Model picker callbacks
  const handleModelSelect = useCallback((model: string, source: 'cloud' | 'local' | 'claude-code', cloudProv?: 'anthropic' | 'openrouter') => {
    if (source === 'claude-code') {
      updateConfigFile({ modelSource: 'claude-code' });
      onConfigChange?.({ ...config, modelSource: 'claude-code' });
    } else if (source === 'cloud') {
      const provider = cloudProv || 'anthropic';
      updateConfigFile({ modelSource: 'cloud', cloudModel: model, cloudProvider: provider });
      onConfigChange?.({ ...config, modelSource: 'cloud', cloudModel: model, cloudProvider: provider });
    } else {
      updateConfigFile({ modelSource: 'local' });
      onConfigChange?.({ ...config, modelSource: 'local' });
    }
    // Notify daemon so ModelRouter switches source at runtime
    fetch(`http://127.0.0.1:${config.port}/api/models/orchestrator`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.sessionToken}` },
      body: JSON.stringify({ model, modelSource: source, cloudProvider: cloudProv }),
    }).catch(() => {});
    orchestrator.setModel(model, source);
    setShowModelPicker(false);
  }, [config, onConfigChange, orchestrator, runtime.sessionToken]);

  const handleApiKeySet = useCallback((key: string) => {
    updateConfigFile({ anthropicApiKey: key });
    onConfigChange?.({ ...config, anthropicApiKey: key });
    // Notify running daemon
    fetch(`http://127.0.0.1:${config.port}/api/set-api-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(runtime.sessionToken ? { Authorization: `Bearer ${runtime.sessionToken}` } : {}),
      },
      body: JSON.stringify({ apiKey: key }),
    }).catch(() => {});
  }, [config, onConfigChange, runtime.sessionToken]);

  // Workspace picker overlay (triggered by /workspace slash command)
  if (showWorkspacePicker) {
    return (
      <Box flexDirection="column" width="100%">
        <Header
          version={VERSION}
          cloudConnected={runtime.cloudConnected}
          tier={config.tier}
          whatsappStatus={runtime.whatsappStatus}
          daemonPid={runtime.daemonPid}
          daemonUptime={runtime.daemonUptime}
          daemonPort={config.port}
          daemonConnectedAt={runtime.daemonConnectedAt}
          initializing={runtime.initializing}
          workspaceName={workspaceName}
        />
        <WorkspacePicker
          onSelect={switchWorkspace}
          onClose={() => setShowWorkspacePicker(false)}
          isActive={showWorkspacePicker}
        />
      </Box>
    );
  }

  // Cost confirmation dialog overlay
  if (orchestrator.costConfirmation) {
    const { toolName, estimatedCredits, description } = orchestrator.costConfirmation;
    return (
      <Box flexDirection="column" width="100%">
        <Header
          version={VERSION}
          cloudConnected={runtime.cloudConnected}
          tier={config.tier}
          whatsappStatus={runtime.whatsappStatus}
          daemonPid={runtime.daemonPid}
          daemonUptime={runtime.daemonUptime}
          daemonPort={config.port}
          daemonConnectedAt={runtime.daemonConnectedAt}
          initializing={runtime.initializing}
          workspaceName={workspaceName}
        />
        <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor={C.amber}
            paddingX={3}
            paddingY={1}
            width={dialogWidth}
          >
            <Text bold color={C.amber}>Media Generation Cost</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>Tool: <Text color={C.cyan}>{toolName}</Text></Text>
              <Text>Cost: <Text color={C.amber} bold>{estimatedCredits} credits</Text></Text>
              <Text dimColor>{description}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="green" bold>[y] Approve  </Text>
              <Text color="red" bold>[n] Cancel  </Text>
              <Text color="gray" bold>[a] Always approve</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  // Permission dialog overlay
  if (orchestrator.permissionRequest) {
    const { path: requestedPath } = orchestrator.permissionRequest;
    return (
      <Box flexDirection="column" width="100%">
        <Header
          version={VERSION}
          cloudConnected={runtime.cloudConnected}
          tier={config.tier}
          whatsappStatus={runtime.whatsappStatus}
          daemonPid={runtime.daemonPid}
          daemonUptime={runtime.daemonUptime}
          daemonPort={config.port}
          daemonConnectedAt={runtime.daemonConnectedAt}
          initializing={runtime.initializing}
          workspaceName={workspaceName}
        />
        <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor={C.amber}
            paddingX={3}
            paddingY={1}
            width={dialogWidth}
          >
            <Text bold color={C.amber}>Permission Required</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>The AI wants to access:</Text>
              <Text color={C.cyan}>{requestedPath}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="green" bold>[y] Allow    </Text>
              <Text color="red" bold>[n] Deny</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  // Elicitation dialog overlay
  if (activeElicitation) {
    const hasFields = elicitationFields.length > 0;
    return (
      <Box flexDirection="column" width="100%">
        <Header
          version={VERSION}
          cloudConnected={runtime.cloudConnected}
          tier={config.tier}
          whatsappStatus={runtime.whatsappStatus}
          daemonPid={runtime.daemonPid}
          daemonUptime={runtime.daemonUptime}
          daemonPort={config.port}
          daemonConnectedAt={runtime.daemonConnectedAt}
          initializing={runtime.initializing}
          workspaceName={workspaceName}
        />
        <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor={C.cyan}
            paddingX={3}
            paddingY={1}
            width={dialogWidth}
          >
            <Text bold color={C.cyan}>Input Needed</Text>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>{activeElicitation.serverName} is asking for more info:</Text>
              {activeElicitation.message ? <Text>{activeElicitation.message}</Text> : null}
            </Box>
            {hasFields ? (
              <Box marginTop={1} flexDirection="column">
                {elicitationFields.map((field, i) => {
                  const isFocused = i === elicitationFieldIdx;
                  if (isFocused) {
                    return (
                      <Box key={field.name} flexDirection="column">
                        <InputField
                          label={field.label}
                          value={elicitationValues[field.name] || ''}
                          onChange={(val) => setElicitationValues(prev => ({ ...prev, [field.name]: val }))}
                          placeholder={field.type === 'number' ? '0' : ''}
                        />
                      </Box>
                    );
                  }
                  return (
                    <Box key={field.name}>
                      <Text dimColor>{field.label}: </Text>
                      <Text>{elicitationValues[field.name] || ''}</Text>
                    </Box>
                  );
                })}
                <Box marginTop={1}>
                  <Text dimColor>Tab to switch fields</Text>
                </Box>
              </Box>
            ) : null}
            <Box marginTop={1}>
              {hasFields ? (
                <>
                  <Text color="green" bold>[Enter] Send    </Text>
                  <Text color="red" bold>[Esc] Skip</Text>
                </>
              ) : (
                <>
                  <Text color="green" bold>[y] Continue    </Text>
                  <Text color="red" bold>[n] Skip</Text>
                </>
              )}
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <Header
        version={VERSION}
        cloudConnected={runtime.cloudConnected}
        tier={config.tier}
        whatsappStatus={runtime.whatsappStatus}
        daemonPid={runtime.daemonPid}
        daemonUptime={runtime.daemonUptime}
        daemonPort={config.port}
        daemonConnectedAt={runtime.daemonConnectedAt}
        workspaceName={workspaceName}
      />
      {runtime.error && (
        <Box paddingX={1} marginTop={1}>
          <Text color="red" bold>Error: </Text>
          <Text color="red">{runtime.error}</Text>
        </Box>
      )}
      {licenseRestartNeeded && (
        <Box paddingX={1} marginTop={1}>
          <Text color="yellow" bold>Restart ohwow to activate your license key.</Text>
        </Box>
      )}
      {creditWarning && (
        <Box paddingX={1}>
          <Text color="yellow">{'\u26A0 '}{creditWarning}</Text>
        </Box>
      )}
      {waNotification && (
        <Box paddingX={1}>
          <Text color="green">{'\uD83D\uDCAC '}{waNotification}</Text>
        </Box>
      )}

      {isHome ? (
        /* Today state board — 3-zone layout */
        <>
          <TodayBoard agents={agents.list} db={runtime.db} justOnboarded={justOnboarded} />
          {banner && <CompletionBanner banner={banner} />}
          <StatusBar
            section={getSectionLabel()}
            extraHints={getExtraHints()}
          />
          <SectionNav activeSection={activeSection} />
        </>
      ) : (
        /* Full-screen view */
        <>
          <Box flexDirection="column" flexGrow={1} paddingX={1} marginTop={1}>
            {renderScreen()}
          </Box>
          {banner && <CompletionBanner banner={banner} />}
          <StatusBar
            section={getSectionLabel()}
            subsection={getSubsectionLabel()}
            extraHints={getExtraHints()}
          />
          <SectionNav
            activeSection={activeSection}
            teamSubTab={activeSection === Section.Team ? teamSubTab : undefined}
            workSubTab={activeSection === Section.Work ? workSubTab : undefined}
          />
        </>
      )}
      {showQuitConfirm && (
        <ConfirmDialog
          message="Quit the runtime?"
          onConfirm={() => handleQuitConfirm(true)}
          onCancel={() => handleQuitConfirm(false)}
        />
      )}
      {showDispatch && (
        <DispatchOverlay
          agents={agents.list}
          db={runtime.db}
          workspaceId={runtime.workspaceId}
          onClose={() => setShowDispatch(false)}
        />
      )}
    </Box>
  );
}

// ============================================================================
// DASHBOARD OVERVIEW (the metrics/summary view)
// ============================================================================

interface DashboardOverviewProps {
  health: ReturnType<typeof useHealth>;
  agents: Array<{ id: string; name: string; role: string; status: string; stats: Record<string, unknown> }>;
  tasks: Array<{ id: string; title: string; status: string; created_at: string; agent_id: string; tokens_used: number | null; cost_cents: number | null }>;
  onAgentSelect: (id: string) => void;
  onTaskSelect: (id: string) => void;
  port: number;
  ollamaConnected?: boolean;
  modelReady?: boolean;
  sessionToken: string;
  models?: OllamaModelSummary[];
}

function DashboardOverview({ health, agents, tasks, port, ollamaConnected, modelReady, sessionToken, models }: DashboardOverviewProps) {
  const showModelBanner = !modelReady;

  return (
    <Box flexDirection="column">
      {showModelBanner && (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={2}
          marginBottom={1}
        >
          <Text color="yellow" bold>
            {!ollamaConnected
              ? 'Ollama is not running. '
              : 'Your AI model needs to be downloaded. '}
          </Text>
          <Text color="gray">
            Press <Text bold color="white">o</Text> to set up local AI.
          </Text>
        </Box>
      )}

      <Box marginBottom={1}>
        <MetricBox label="Agents" value={String(health.totalAgents)} color="cyan" />
        <MetricBox label="Tasks" value={String(health.totalTasks)} color="green" />
        <MetricBox label="Tokens" value={formatTokens(health.totalTokens)} color="yellow" />
        <MetricBox label="Cost" value={`$${(health.totalCostCents / 100).toFixed(2)}`} color="magenta" />
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text color="gray">Web UI: </Text>
          <Text color="cyan" bold>http://localhost:{port}</Text>
        </Box>
        <Box>
          <Text color="gray">Token: </Text>
          <Text color="gray" dimColor>{sessionToken}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>LOCAL MODELS</Text>
        {!ollamaConnected ? (
          <Text color="gray">Ollama not connected</Text>
        ) : !models || models.length === 0 ? (
          <Text color="gray">No models detected yet</Text>
        ) : models.length > 0 && models.every(m => m.status !== 'loaded') ? (
          <Box flexDirection="column">
            {sortModelsForDisplay(models).slice(0, 5).map(model => (
              <Text key={model.modelName}>
                <Text color="gray">{'\u25CF'}</Text>
                {' '}<Text>{model.modelName}</Text>
                <Text color="gray"> {model.status}</Text>
              </Text>
            ))}
            <Text color="yellow">
              No models loaded. Press <Text bold color="white">m</Text> to manage models.
            </Text>
          </Box>
        ) : (
          sortModelsForDisplay(models).slice(0, 5).map(model => {
            const isLoaded = model.status === 'loaded';
            const dot = isLoaded ? '\u25C9' : '\u25CF';
            const dotColor = isLoaded ? 'green' : 'gray';
            const processorBadge = model.processor ? ` (${model.processor})` : '';
            const totalTokens = model.totalInputTokens + model.totalOutputTokens;
            const avgMs = model.avgDurationMs;
            const statsStr = model.totalRequests > 0
              ? `${String(model.totalRequests).padStart(4)} reqs   ${formatTokens(totalTokens).padStart(5)} tokens${avgMs ? `   ${(avgMs / 1000).toFixed(1)}s avg` : ''}`
              : '';
            return (
              <Text key={model.modelName}>
                <Text color={dotColor}>{dot}</Text>
                {' '}<Text>{model.modelName}</Text>
                <Text color="gray"> {(model.status + processorBadge).padEnd(18)} {statsStr}</Text>
              </Text>
            );
          })
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>AGENTS</Text>
        {agents.length === 0 ? (
          <Text color="gray">No agents yet. Press c to create your first one.</Text>
        ) : (
          agents.slice(0, 5).map(agent => {
            const stats = agent.stats as Record<string, number>;
            const taskCount = stats.total_tasks || 0;
            const cost = ((stats.cost_cents || 0) / 100).toFixed(2);
            const statusColor = agent.status === 'working' ? 'yellow' : 'green';
            const statusIcon = agent.status === 'working' ? '\u25C9' : '\u25CF';
            return (
              <Text key={agent.id}>
                <Text color={statusColor}>{statusIcon}</Text>
                {' '}<Text>{agent.name}</Text>
                <Text color="gray"> {agent.status.padEnd(10)} {String(taskCount).padStart(4)} tasks   ${cost}</Text>
              </Text>
            );
          })
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>RECENT TASKS</Text>
        {tasks.length === 0 ? (
          <Text color="gray">No tasks yet.</Text>
        ) : (
          tasks.slice(0, 5).map(task => {
            const icon = task.status === 'completed' ? '\u2713' : task.status === 'failed' ? '\u2717' : task.status === 'in_progress' ? '\u25C9' : '\u25CB';
            const color = task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : task.status === 'in_progress' ? 'yellow' : 'gray';
            const timeAgo = getTimeAgo(task.created_at);
            return (
              <Text key={task.id}>
                <Text color={color}>{icon}</Text>
                {' '}<Text>{task.title}</Text>
                <Text color="gray"> {timeAgo}</Text>
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}

function sortModelsForDisplay(models: OllamaModelSummary[]): OllamaModelSummary[] {
  return [...models].sort((a, b) => {
    if (a.status === 'loaded' && b.status !== 'loaded') return -1;
    if (b.status === 'loaded' && a.status !== 'loaded') return 1;
    const aTime = a.lastUsedAt || a.lastSeenAt;
    const bTime = b.lastUsedAt || b.lastSeenAt;
    return bTime.localeCompare(aTime);
  });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

// ============================================================================
// TODAY STATE BOARD — 3-zone layout (TRIO-05 shell, TRIO-06 attention queue)
// ============================================================================

interface PendingApproval {
  id: string;
  workspace_id: string;
  agent_id: string;
  title: string;
  created_at: string;
  deferred_action: { type: string; params: Record<string, unknown>; provider: string } | null;
}

interface FeedEntry {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  title: string;
  updatedAt: string;
}

interface TodayBoardProps {
  agents: Array<{ id: string; name: string; role: string; status: string; stats: Record<string, unknown>; created_at?: string }>;
  db: DatabaseAdapter | null;
  /** When true, agents created within the last 60 s are shown as "setting up…" */
  justOnboarded?: boolean;
}

const BRAILLE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const;

export function TodayBoard({ agents, db, justOnboarded }: TodayBoardProps) {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [focusedOnApprovals, setFocusedOnApprovals] = useState(false);
  const [rejectInput, setRejectInput] = useState<string | null>(null);
  const [flashState, setFlashState] = useState<{ id: string; type: 'approve' | 'reject' } | null>(null);
  const cols = useTerminalSize();

  // Animation ticks — separate intervals for each animation type
  const brailleTick = useAnimationTick(120);   // ~8fps braille spinner
  const flickerTick = useAnimationTick(500);   // error flicker cadence
  const breatheTick = useAnimationTick(1000);  // idle breathing cadence
  const alertTick = useAnimationTick(800);     // approval urgency pulse
  const stacked = cols < 90;
  const approvalTitleMax = stacked ? Math.max(20, cols - 20) : 40;

  // Fetch pending approvals — sorted oldest first
  useEffect(() => {
    if (!db) return;
    const fetch = async () => {
      const { data } = await db
        .from<{ id: string; workspace_id: string; agent_id: string; title: string; created_at: string; deferred_action?: string | null }>('agent_workforce_tasks')
        .select('id, workspace_id, agent_id, title, created_at, deferred_action')
        .eq('status', 'needs_approval')
        .order('created_at', { ascending: true });
      if (data) {
        setApprovals(data.map(t => ({
          id: t.id,
          workspace_id: t.workspace_id,
          agent_id: t.agent_id,
          title: t.title,
          created_at: t.created_at,
          deferred_action: t.deferred_action
            ? (typeof t.deferred_action === 'string'
              ? JSON.parse(t.deferred_action) as PendingApproval['deferred_action']
              : t.deferred_action as PendingApproval['deferred_action'])
            : null,
        })));
      }
    };
    fetch();
    const timer = setInterval(fetch, 5000);
    return () => clearInterval(timer);
  }, [db]);

  // Fetch completed/failed task feed — last 8, newest first, polls every 10 s
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  useEffect(() => {
    if (!db) return;
    const fetchFeed = async () => {
      const { data } = await db
        .from<{ id: string; agent_id: string; title: string; status: string; updated_at: string }>('agent_workforce_tasks')
        .select('id, agent_id, title, status, updated_at')
        .in('status', ['completed', 'failed', 'approved', 'rejected'])
        .order('updated_at', { ascending: false })
        .limit(8);
      if (data) {
        setFeed(data.map(t => {
          const agent = agents.find(a => a.id === t.agent_id);
          return {
            id: t.id,
            agentId: t.agent_id,
            agentName: agent?.name ?? 'Unknown',
            status: t.status,
            title: t.title,
            updatedAt: t.updated_at,
          };
        }));
      }
    };
    fetchFeed();
    const feedTimer = setInterval(fetchFeed, 10000);
    return () => clearInterval(feedTimer);
  }, [db, agents]);

  const applyApprovalAction = useCallback(async (approval: PendingApproval, action: 'approve' | 'reject', reason?: string) => {
    if (!db) return;
    const now = new Date().toISOString();
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await db.from('agent_workforce_tasks').update({
      status: newStatus,
      updated_at: now,
      ...(action === 'approve' ? { approved_at: now, approved_by: 'runtime' } : {}),
      ...(action === 'reject' && reason ? { rejection_reason: reason } : {}),
    }).eq('id', approval.id);

    const { getEventBus } = await import('../../hooks/use-event-bus.js');
    getEventBus().emit('task:completed', {
      taskId: approval.id,
      agentId: approval.agent_id,
      status: newStatus,
      tokensUsed: 0,
      costCents: 0,
    });

    setApprovals(prev => prev.filter(a => a.id !== approval.id));
    setSelectedIdx(prev => Math.max(0, prev - 1));
  }, [db]);

  useInput((input, key) => {
    // Reject reason input mode
    if (rejectInput !== null) {
      if (key.return) {
        const approval = approvals[selectedIdx];
        if (approval) {
          applyApprovalAction(approval, 'reject', rejectInput || undefined);
        }
        setRejectInput(null);
        return;
      }
      if (key.escape) {
        setRejectInput(null);
        return;
      }
      if (key.backspace || key.delete) {
        setRejectInput(prev => (prev ?? '').slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setRejectInput(prev => (prev ?? '') + input);
      }
      return;
    }

    if (approvals.length === 0) return;

    // Tab toggles focus into/out of the approvals list
    if (input === '\t' || key.tab) {
      setFocusedOnApprovals(f => !f);
      return;
    }

    if (!focusedOnApprovals) return;

    if (input === 'j' || key.downArrow) {
      setSelectedIdx(i => Math.min(i + 1, approvals.length - 1));
      return;
    }
    if (input === 'k' || key.upArrow) {
      setSelectedIdx(i => Math.max(i - 1, 0));
      return;
    }
    if (input === 'a') {
      const approval = approvals[selectedIdx];
      if (approval) {
        setFlashState({ id: approval.id, type: 'approve' });
        setTimeout(() => setFlashState(null), 400);
        applyApprovalAction(approval, 'approve');
      }
      return;
    }
    if (input === 'r') {
      const approval = approvals[selectedIdx];
      if (approval) {
        setFlashState({ id: approval.id, type: 'reject' });
        setTimeout(() => setFlashState(null), 400);
      }
      setRejectInput('');
      return;
    }
  });

  // Clamp selectedIdx when approvals shrink
  const clampedIdx = Math.min(selectedIdx, Math.max(0, approvals.length - 1));

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} marginTop={1}>
      {/* Main row: side-by-side on wide terminals, stacked on narrow */}
      <Box flexDirection={stacked ? 'column' : 'row'} flexGrow={1}>
        {/* AGENTS column — 40% wide or full-width when stacked */}
        <Box
          flexDirection="column"
          width={stacked ? '100%' : '40%'}
          borderStyle="single"
          borderColor={C.cyan}
          paddingX={1}
          paddingY={0}
          marginRight={stacked ? 0 : 1}
          marginBottom={stacked ? 1 : 0}
        >
          <Text bold color={C.cyan}>══╡ OPERATIVES ╞══</Text>
          {agents.length === 0 ? (
            <Box flexDirection="column">
              <Text color={C.slate}>◌ YOUR TEAM AWAITS</Text>
              <Text dimColor>Run /agents to deploy your first operative.</Text>
            </Box>
          ) : (
            agents.map((agent, index) => {
              // Show "setting up…" for agents created in the last 60 s after onboarding
              const isNew = justOnboarded && agent.created_at
                ? (Date.now() - new Date(agent.created_at).getTime()) < 60_000
                : false;

              if (agent.status === 'working' || agent.status === 'running' || agent.status === 'busy') {
                // Animated braille spinner — each agent has a phase offset so they don't sync
                const frame = BRAILLE_FRAMES[(brailleTick + index * 3) % 8];
                const activityLine = typeof agent.stats?.currentTask === 'string'
                  ? agent.stats.currentTask
                  : 'working';
                return (
                  <Box key={agent.id} flexDirection="row" marginTop={0}>
                    <Text color={C.green}>{frame} </Text>
                    <Box flexDirection="column">
                      <Text bold>{agent.name}</Text>
                      <Text dimColor>{activityLine}</Text>
                    </Box>
                  </Box>
                );
              } else if (agent.status === 'error') {
                // Flicker between full and dim on 500ms cadence
                const dimFlicker = (flickerTick + index) % 2 === 1;
                return (
                  <Box key={agent.id} flexDirection="row" marginTop={0}>
                    <Text color={C.red} dimColor={dimFlicker}>{'✗'} </Text>
                    <Box flexDirection="column">
                      <Text bold>{agent.name}</Text>
                      <Text dimColor>error</Text>
                    </Box>
                  </Box>
                );
              } else if (isNew) {
                return (
                  <Box key={agent.id} flexDirection="row" marginTop={0}>
                    <Text color={C.cyan}>{'◌'} </Text>
                    <Box flexDirection="column">
                      <Text bold>{agent.name}</Text>
                      <Text dimColor>setting up…</Text>
                    </Box>
                  </Box>
                );
              } else {
                // Idle breathing — dim for 2 ticks, bright for 2 ticks, per-agent offset
                const phase = (breatheTick + index) % 4;
                const dimBreath = phase === 0 || phase === 1;
                return (
                  <Box key={agent.id} flexDirection="row" marginTop={0}>
                    <Text color={C.idle} dimColor={dimBreath}>{'●'} </Text>
                    <Box flexDirection="column">
                      <Text bold>{agent.name}</Text>
                      <Text dimColor>idle</Text>
                    </Box>
                  </Box>
                );
              }
            })
          )}
        </Box>

        {/* CENTER COLUMN ~45%: Attention queue */}
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="single"
          borderColor={
            focusedOnApprovals
              ? C.red
              : approvals.length > 0
                ? (alertTick % 2 === 0 ? C.amber : C.red)
                : C.slate
          }
          paddingX={1}
          paddingY={0}
        >
          <Text bold color={C.amber}>══╡ COMMAND QUEUE ╞══</Text>

          {/* APPROVALS section */}
          <Box flexDirection="column" marginTop={0}>
            <Box flexDirection="row">
              <Text bold color={C.red}>{'🔴'} ▐ DECISIONS ▌</Text>
              {approvals.length > 0 && (
                <Text bold color={C.amber}>{` (${approvals.length})`}</Text>
              )}
            </Box>
            {approvals.length === 0 ? (
              <Text dimColor>◎ All decisions made.</Text>
            ) : (
              approvals.map((approval, idx) => {
                const isSelected = focusedOnApprovals && idx === clampedIdx;
                const age = getTimeAgo(approval.created_at);
                const isFlashing = flashState?.id === approval.id;
                const flashColor = isFlashing
                  ? (flashState?.type === 'approve' ? C.mint : C.red)
                  : C.red;
                return (
                  <Box key={approval.id} flexDirection="row">
                    <Text color={isSelected ? 'white' : C.red} bold={isSelected}>
                      {isSelected ? '▶ ' : '  '}
                    </Text>
                    <Box flexDirection="column">
                      <Text color={flashColor} bold={isSelected || isFlashing} inverse={isSelected || isFlashing}>
                        {approval.title.length > approvalTitleMax ? approval.title.slice(0, approvalTitleMax - 3) + '...' : approval.title}
                      </Text>
                      <Text dimColor>{age}</Text>
                    </Box>
                  </Box>
                );
              })
            )}
          </Box>

          {/* Reject reason inline input */}
          {rejectInput !== null && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="red" bold>Rejection reason:</Text>
              <Box>
                <Text color="white">{rejectInput}</Text>
                <Text color="gray">{'_'}</Text>
              </Box>
              <Text dimColor>Enter: confirm  Esc: cancel</Text>
            </Box>
          )}

          {/* ERRORS section placeholder */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={C.amber}>{'🟡'} ▐ ALERTS ▌</Text>
            {agents.filter(a => a.status === 'error').length === 0 ? (
              <Text dimColor>◈ Systems nominal.</Text>
            ) : (
              agents.filter(a => a.status === 'error').map(a => (
                <Text key={a.id} color={C.amber}>{a.name}: error</Text>
              ))
            )}
          </Box>

          {/* Key hints when focused */}
          {focusedOnApprovals && approvals.length > 0 && rejectInput === null && (
            <Box marginTop={1}>
              <Text dimColor>j/k nav  </Text>
              <Text color="green" bold>a</Text>
              <Text dimColor>:approve  </Text>
              <Text color="red" bold>r</Text>
              <Text dimColor>:reject  Tab:unfocus</Text>
            </Box>
          )}
          {!focusedOnApprovals && approvals.length > 0 && (
            <Box marginTop={1}>
              <Text dimColor>Tab to focus approvals</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* NEURAL FEED — last 8 completed/failed events */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={C.slate}
        paddingX={1}
        marginTop={1}
      >
        <Text bold color={C.slate}>◈ NEURAL FEED</Text>
        {feed.length === 0 ? (
          <Text dimColor>◎ No activity yet. Agents are standing by.</Text>
        ) : (
          feed.map(entry => {
            const dt = new Date(entry.updatedAt);
            const hh = String(dt.getHours()).padStart(2, '0');
            const mm = String(dt.getMinutes()).padStart(2, '0');
            const timeStr = `${hh}:${mm}`;
            const isSuccess = entry.status === 'completed' || entry.status === 'approved';
            const glyph = isSuccess ? '✓' : '✗';
            const glyphColor = isSuccess ? C.green : C.red;
            const nameDisplay = entry.agentName.length > 18 ? entry.agentName.slice(0, 15) + '...' : entry.agentName;
            const titleDisplay = entry.title.length > 35 ? entry.title.slice(0, 32) + '...' : entry.title;
            return (
              <Box key={entry.id} flexDirection="row" gap={1}>
                <Text dimColor>{timeStr}</Text>
                <Text color={C.cyan}>{'◈'}</Text>
                <Text bold>{nameDisplay.padEnd(18)}</Text>
                <Text color={glyphColor}>{glyph}</Text>
                <Text dimColor>{titleDisplay}</Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* BOTTOM STRIP: Dispatch rail */}
      <Box
        flexDirection="row"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginTop={1}
      >
        <Text dimColor>d · dispatch</Text>
      </Box>
    </Box>
  );
}
