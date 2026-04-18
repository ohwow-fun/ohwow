/**
 * Daemon orchestration phase
 *
 * Builds the channel + connector registries, the workflow trigger
 * evaluator, the LocalOrchestrator (skipped on workers), the digital body
 * + nervous system, the consciousness bridge, the message router, and
 * the device-pinned data fetcher. Populates ctx.{channelRegistry,
 * connectorRegistry, triggerEvaluator, orchestrator, digitalBody,
 * digitalNS, messageRouter, deviceFetcher}. Must run after the cloud
 * phase so ctx.workspaceId and ctx.controlPlane are settled.
 */

import { ChannelRegistry } from '../integrations/channel-registry.js';
import { ConnectorRegistry } from '../integrations/connector-registry.js';
import { GitHubConnector } from '../integrations/connectors/github-connector.js';
import { GoogleDriveConnector } from '../integrations/connectors/google-drive-connector.js';
import { LocalFilesConnector } from '../integrations/connectors/local-files-connector.js';
import { NotionConnector } from '../integrations/connectors/notion-connector.js';
import { MessageRouter } from '../integrations/message-router.js';
import { LocalOrchestrator } from '../orchestrator/local-orchestrator.js';
import { ConsciousnessBridge } from '../brain/consciousness-bridge.js';
import { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import { DigitalBody, type VoiceServiceLike } from '../body/digital-body.js';
import { DigitalNervousSystem } from '../body/digital-nervous-system.js';
import { logger } from '../lib/logger.js';
import type { DaemonContext } from './context.js';
import type { InferenceState } from './inference.js';

export async function setupOrchestration(
  ctx: Partial<DaemonContext>,
  inferenceState: InferenceState,
): Promise<void> {
  const { config, db, rawDb, bus, engine, workspaceId, controlPlane, modelRouter, scraplingService, dataDir } = ctx as DaemonContext;
  const isWorker = config.deviceRole === 'worker';

  // Mutable voice state tracker — read by the DigitalBody's voice adapter
  // closures. Currently never mutated; left as a mutable struct so later
  // wiring can flip state without rebuilding the adapter.
  const voiceState = { state: 'idle' as 'idle' | 'listening' | 'processing' | 'speaking', stt: null as string | null, tts: null as string | null };

  const channelRegistry = new ChannelRegistry();
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.registerFactory('github', (cfg) => new GitHubConnector(cfg));
  connectorRegistry.registerFactory('google-drive', (cfg) => new GoogleDriveConnector(cfg));
  connectorRegistry.registerFactory('local-files', (cfg) => new LocalFilesConnector(cfg));
  connectorRegistry.registerFactory('notion', (cfg) => new NotionConnector(cfg));
  const triggerEvaluator = new LocalTriggerEvaluator(db, engine, workspaceId, channelRegistry);

  // Workers skip orchestrator/messaging (task execution only)
  const orchestrator = isWorker ? null : new LocalOrchestrator(
    db, engine, workspaceId, config.anthropicApiKey,
    channelRegistry, controlPlane!, modelRouter, scraplingService, config.orchestratorModel, process.cwd(),
    config.browserHeadless, dataDir, config.mcpServers,
    config.browserTarget, config.chromeCdpPort,
    config.desktopToolsEnabled,
  );

  if (orchestrator) {
    orchestrator.setRagConfig({
      ollamaUrl: config.ollamaUrl,
      ollamaModel: config.ollamaModel,
      ragBm25Weight: config.ragBm25Weight,
      rerankerEnabled: config.rerankerEnabled,
      meshRagEnabled: config.meshRagEnabled,
    });
    orchestrator.setConnectorRegistry(connectorRegistry);
    orchestrator.setChromeProfileAliases(config.chromeProfileAliases);
    // Propagate the configured Chrome profile to every spawn path that
    // reads OHWOW_CHROME_PROFILE (ensureDebugChrome, x-intel child, etc).
    // Without this, a daemon restart that has to spawn a fresh debug
    // Chrome lands on 'Default' profile, which is rarely the Google
    // account signed into x.com for this workspace.
    if (config.chromeDefaultProfile) {
      process.env.OHWOW_CHROME_PROFILE = config.chromeDefaultProfile;
    }
    orchestrator.setSkipMediaCostConfirmation(config.skipMediaCostConfirmation);

    // LSP manager — lazy-start language servers on first tool call
    if (config.lspEnabled) {
      const { LspManager } = await import('../lsp/lsp-manager.js');
      const lspManager = new LspManager(process.cwd());
      orchestrator.setLspManager(lspManager);
      bus.on('shutdown', () => { lspManager.stopAll().catch(() => {}); });
    }
    if (inferenceState.inferenceCapabilities) {
      orchestrator.setInferenceCapabilities(inferenceState.inferenceCapabilities);
      bus.emit('inference:capabilities-changed', inferenceState.inferenceCapabilities);
    }

    // Initialize meeting session (macOS only)
    if (process.platform === 'darwin') {
      const { MeetingSession } = await import('../meeting/meeting-session.js');
      const openaiKey = (engine as unknown as { config?: { openaiApiKey?: string } })?.config?.openaiApiKey;
      const meetingSession = new MeetingSession(
        db, modelRouter, controlPlane, workspaceId,
        config.ollamaUrl, openaiKey,
      );
      orchestrator.setMeetingSession(meetingSession);
      if (controlPlane) {
        controlPlane.setMeetingSession(meetingSession);
      }
    }
  }

  // 10b. Bootstrap digital body (Merleau-Ponty: embodiment)
  const voiceAdapter: VoiceServiceLike = {
    isActive: () => voiceState.state !== 'idle',
    getState: () => voiceState.state,
    getSttProvider: () => voiceState.stt,
    getTtsProvider: () => voiceState.tts,
  };

  const digitalBody = new DigitalBody({
    channels: channelRegistry,
    voice: voiceAdapter,
    workingDirectory: process.cwd(),
  });

  const digitalNS = new DigitalNervousSystem({
    body: digitalBody,
    experienceStream: orchestrator?.getBrain()?.experienceStream,
    workspace: orchestrator?.getBrain()?.workspace,
  });
  digitalNS.start();

  // Subscribe to high-salience nervous signals for logging
  digitalNS.onSignal((signal) => {
    if (signal.salience >= 0.5) {
      logger.info({ organ: signal.organId, type: signal.type, salience: signal.salience }, '[body] Nervous signal');
    }
  });

  // Wire body into brain(s) and orchestrator for proprioceptive awareness
  if (orchestrator) {
    orchestrator.getBrain()?.setDigitalBody(digitalBody);
    orchestrator.setDigitalBody(digitalBody);
  }
  engine.getBrain().setDigitalBody(digitalBody);

  // Wire consciousness bridge for persistence and cloud sync
  if (orchestrator) {
    const orchBrain = orchestrator.getBrain();
    if (orchBrain) {
      const consciousnessBridge = new ConsciousnessBridge(db, orchBrain.workspace, workspaceId);
      orchBrain.setConsciousnessBridge(consciousnessBridge);
      consciousnessBridge.hydrate().catch(err => {
        logger.debug({ err }, '[daemon] Consciousness hydration failed');
      });
      // Wire to control plane for cloud sync (if connected)
      if (controlPlane) {
        controlPlane.setConsciousnessBridge(consciousnessBridge);
      }
    }
  }

  logger.info(`[body] Digital body created with ${digitalBody.getOrgans().length} organs, nervous system started`);

  let messageRouter: MessageRouter | null = null;
  if (!isWorker) {
    messageRouter = new MessageRouter({ orchestrator: orchestrator!, channelRegistry, rawDb, db, workspaceId, triggerEvaluator, eventBus: bus });
  }

  // Device data fetcher (for device-pinned data)
  let deviceFetcher: import('../data-locality/fetch-client.js').DeviceDataFetcher | null = null;
  if (controlPlane?.connectedDeviceId) {
    const { DeviceDataFetcher } = await import('../data-locality/fetch-client.js');
    const { createPeerResolver } = await import('../data-locality/resolve-peer.js');

    deviceFetcher = new DeviceDataFetcher({
      db,
      workspaceId,
      deviceId: controlPlane.connectedDeviceId,
      cloudUrl: config.cloudUrl || '',
      sessionToken: controlPlane.cloudSessionToken,
      resolvePeer: createPeerResolver(db, {
        cloudUrl: config.cloudUrl,
        sessionToken: controlPlane.cloudSessionToken,
      }),
    });

    // Wire into engine for device-pinned memory retrieval during tasks
    engine.setDeviceFetcher(deviceFetcher);
  }

  ctx.channelRegistry = channelRegistry;
  ctx.connectorRegistry = connectorRegistry;
  ctx.triggerEvaluator = triggerEvaluator;
  ctx.orchestrator = orchestrator;
  ctx.digitalBody = digitalBody;
  ctx.digitalNS = digitalNS;
  ctx.messageRouter = messageRouter;
  ctx.deviceFetcher = deviceFetcher;
}
