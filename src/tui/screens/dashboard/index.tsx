/**
 * Dashboard Screen
 * Chat-centric root layout. Chat is the home screen with a grid menu below.
 * Selecting a grid item or using slash commands opens a full-screen view.
 * ESC always returns to chat.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { RuntimeConfig } from '../../../config.js';
import { updateConfigFile, resolveActiveWorkspace } from '../../../config.js';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';
import type Database from 'better-sqlite3';
import { Screen, getGridScreens } from '../../types.js';
import { useRuntime } from '../../hooks/use-runtime.js';
import { useNavigation } from '../../hooks/use-navigation.js';
import { Header } from '../../components/header.js';
import { KeyHints } from '../../components/key-hints.js';
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
import type { OllamaModelSummary } from '../../../lib/ollama-monitor-types.js';
import { useOllamaModels } from '../../hooks/use-ollama-models.js';
import { useWorkspacePointerWatch } from '../../hooks/use-workspace-pointer-watch.js';

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

export function Dashboard({ config, db, rawDb, needsOnboarding, justOnboarded, onStartOnboarding, onConfigChange }: DashboardProps) {
  const { exit } = useApp();
  // The TUI process is bound to whichever workspace was active at boot.
  // Read it once — it can't change mid-process, switching requires re-launch.
  const workspaceName = useMemo(() => resolveActiveWorkspace().name, []);
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

      // Quit
      if (input === 'q') {
        setShowQuitConfirm(true);
        return;
      }

      // New task shortcut
      if (input === 'n' && nav.screen === Screen.Tasks) {
        nav.goTo(Screen.TaskDispatch);
        return;
      }

      // New agent shortcut
      if (input === 'c' && !nav.isDetail) {
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
            needsOnboarding={needsOnboarding}
            onStartOnboarding={onStartOnboarding}
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

  // Key hints based on current focus zone
  const getKeyHints = () => {
    if (isHome && focusZone === 'chat') {
      const hints = [
        { key: 'Enter', label: 'send' },
        { key: '?', label: 'shortcuts' },
        { key: '\u2193', label: 'menu' },
      ];
      if (orchestrator.isStreaming) {
        hints.unshift({ key: 'Esc', label: 'stop' });
      }
      hints.push({ key: 'Ctrl+N', label: 'new' });
      hints.push({ key: 'Ctrl+O', label: 'model' });
      return hints;
    }

    if (isHome && focusZone === 'grid') {
      return [
        { key: 'Arrows', label: 'navigate' },
        { key: 'Enter', label: 'open' },
        { key: 'Esc', label: 'chat' },
        { key: '1-' + gridScreens.length, label: 'quick' },
      ];
    }

    // Screen focus zone
    const hints: Array<{ key: string; label: string }> = [];

    if (nav.isDetail) {
      hints.push({ key: 'Esc', label: 'back' });
    } else {
      hints.push({ key: 'Esc', label: 'chat' });
    }

    hints.push({ key: 'j/k', label: 'nav' });

    if (nav.screen === Screen.Tasks) {
      hints.push({ key: 'n', label: 'new task' });
    }

    if (nav.screen === Screen.Agents) {
      hints.push({ key: 'c', label: 'new agent' });
    }

    if (nav.screen === Screen.Approvals) {
      hints.push({ key: 'a', label: 'approve' });
      hints.push({ key: 'r', label: 'reject' });
    }

    if (nav.screen === Screen.Settings || nav.screen === Screen.Automations) {
      if (subTabFocused) {
        hints.push({ key: '\u2190/\u2192', label: 'sub-tabs' });
        hints.push({ key: '\u2191', label: 'main tabs' });
      } else {
        hints.push({ key: '\u2190/\u2192', label: 'main tabs' });
        hints.push({ key: '\u2193', label: 'sub-tabs' });
      }
    }

    if (nav.screen === Screen.Dashboard) {
      hints.push({ key: 'm', label: 'models' });
      hints.push({ key: 'o', label: 'local AI' });
    }

    if (nav.screen === Screen.Settings) {
      hints.push({ key: 'm', label: 'models' });
      hints.push({ key: 'o', label: 'local AI' });
      hints.push({ key: 'v', label: 'voicebox' });
      hints.push({ key: 'u', label: 'tunnel' });
      if (!isConnected) hints.push({ key: 'l', label: 'connect to cloud' });
      hints.push({ key: 'a', label: 'A2A' });
      hints.push({ key: 'p', label: 'WhatsApp' });
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
            borderColor="yellow"
            paddingX={3}
            paddingY={1}
            width={60}
          >
            <Text bold color="yellow">Media Generation Cost</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>Tool: <Text color="cyan">{toolName}</Text></Text>
              <Text>Cost: <Text color="yellow" bold>{estimatedCredits} credits</Text></Text>
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
            borderColor="yellow"
            paddingX={3}
            paddingY={1}
            width={60}
          >
            <Text bold color="yellow">Permission Required</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>The AI wants to access:</Text>
              <Text color="cyan">{requestedPath}</Text>
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
            borderColor="cyan"
            paddingX={3}
            paddingY={1}
            width={60}
          >
            <Text bold color="cyan">Input Needed</Text>
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
        <TodayBoard agents={agents.list} />
      ) : (
        /* Full-screen view */
        <>
          <Box flexDirection="column" flexGrow={1} paddingX={1} marginTop={1}>
            {renderScreen()}
          </Box>
          <KeyHints hints={getKeyHints()} />
        </>
      )}
      {showQuitConfirm && (
        <ConfirmDialog
          message="Quit the runtime?"
          onConfirm={() => handleQuitConfirm(true)}
          onCancel={() => handleQuitConfirm(false)}
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
  needsOnboarding?: boolean;
  onStartOnboarding?: () => void;
  models?: OllamaModelSummary[];
}

function DashboardOverview({ health, agents, tasks, port, ollamaConnected, modelReady, sessionToken, needsOnboarding, onStartOnboarding, models }: DashboardOverviewProps) {
  const showModelBanner = !modelReady;

  useInput((input, key) => {
    if (needsOnboarding && onStartOnboarding && key.return) {
      onStartOnboarding();
    }
  });

  return (
    <Box flexDirection="column">
      {needsOnboarding && (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={2}
          marginBottom={1}
        >
          <Text color="yellow" bold>Set up your business and team to get started. </Text>
          <Text color="gray">
            Press <Text bold color="white">Enter</Text> to start.
          </Text>
        </Box>
      )}

      {showModelBanner && !needsOnboarding && (
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
// TODAY STATE BOARD — 3-zone layout (TRIO-05)
// ============================================================================

interface TodayBoardProps {
  agents: Array<{ id: string; name: string; role: string; status: string; stats: Record<string, unknown> }>;
}

export function TodayBoard({ agents }: TodayBoardProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} marginTop={1}>
      {/* Main row: left (agent roster) + center (attention queue) */}
      <Box flexDirection="row" flexGrow={1}>
        {/* LEFT COLUMN ~40%: Agent roster */}
        <Box
          flexDirection="column"
          width="40%"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={0}
          marginRight={1}
        >
          <Text bold color="cyan">AGENTS</Text>
          {agents.length === 0 ? (
            <Text dimColor>No agents yet.</Text>
          ) : (
            agents.map((agent) => {
              let indicator = '●';
              let indicatorColor: string = 'gray';
              let activityLine = 'idle';

              if (agent.status === 'working' || agent.status === 'running' || agent.status === 'busy') {
                indicator = '◉';
                indicatorColor = 'green';
                activityLine = typeof agent.stats?.currentTask === 'string'
                  ? agent.stats.currentTask
                  : 'working';
              } else if (agent.status === 'error') {
                indicator = '✗';
                indicatorColor = 'red';
                activityLine = 'error';
              } else {
                indicator = '●';
                indicatorColor = 'gray';
                activityLine = 'idle';
              }

              return (
                <Box key={agent.id} flexDirection="row" marginTop={0}>
                  <Text color={indicatorColor}>{indicator} </Text>
                  <Box flexDirection="column">
                    <Text bold>{agent.name}</Text>
                    <Text dimColor>{activityLine}</Text>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>

        {/* CENTER COLUMN ~45%: Attention queue placeholder */}
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
          paddingY={0}
        >
          <Text bold color="yellow">ATTENTION</Text>
          <Text dimColor>(wired in TRIO-06)</Text>
        </Box>
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
