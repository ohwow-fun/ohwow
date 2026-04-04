/**
 * Runtime Express Server
 * HTTP server for browser-to-runtime content access and web UI.
 * Runs on the customer's LAN (default port 7700).
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type { LocalOrchestrator } from '../orchestrator/local-orchestrator.js';
import { createAuthMiddleware } from './middleware.js';
import { createHealthRouter } from './routes/health.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAgentsRouter } from './routes/agents.js';
import { createActivityRouter } from './routes/activity.js';
import { createApprovalsRouter } from './routes/approvals.js';
import { createSchedulesRouter } from './routes/schedules.js';
import { createSystemRouter } from './routes/system.js';
import { createOrchestratorRouter } from './routes/orchestrator.js';
import { createVoiceRouter } from './routes/voice.js';
import { createPodcastRouter } from './routes/podcast.js';
import { createSettingsRouter } from './routes/settings.js';
import { createOnboardingRouter } from './routes/onboarding.js';
import { attachWebSocket } from './websocket.js';
import { attachVoiceWebSocket } from './voice-websocket.js';
import { createTriggersRouter } from './routes/triggers.js';
import { createAutomationsRouter } from './routes/automations.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createContactsRouter } from './routes/contacts.js';
import { createRevenueRouter } from './routes/revenue.js';
import { createGoalsRouter } from './routes/goals.js';
import { createDepartmentsRouter } from './routes/departments.js';
import { createTeamMembersRouter } from './routes/team-members.js';
import { createProjectsRouter } from './routes/projects.js';
import { createWorkflowsRouter } from './routes/workflows.js';
import { createModelsRouter } from './routes/models.js';
import { createA2ARouter } from './routes/a2a.js';
import { createPdfToolsRouter } from './routes/pdf-tools.js';
import { createFileAccessRouter } from './routes/file-access.js';
import { createTemplatesRouter } from './routes/templates.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createWhatsAppRouter } from './routes/whatsapp.js';
import { createPeerPublicRouter, createPeersRouter } from './routes/peers.js';
import { createRagPublicRouter } from './routes/rag.js';
import { createMcpRouter } from './routes/mcp.js';
import { createCloudProxyRouter } from './routes/cloud-proxy.js';
import { createOrgRouter } from './routes/org.js';
import { createWebhookRouter } from '../webhooks/webhook-handler.js';
import { createBrowserSessionRouter } from './routes/browser-session.js';
import { createDesktopSessionRouter } from './routes/desktop-session.js';
import { errorHandler } from './error-handler.js';
import { VoiceSession } from '../voice/voice-session.js';
import { VoiceboxSTTProvider } from '../voice/voicebox-stt-provider.js';
import { VoiceboxTTSProvider } from '../voice/voicebox-tts-provider.js';
import { WhisperLocalProvider, WhisperAPIProvider } from '../voice/stt-providers.js';
import { PiperProvider, OpenAITTSProvider } from '../voice/tts-providers.js';
import { VibeVoiceSTTProvider } from '../voice/vibevoice-stt-provider.js';
import { VibeVoiceTTSProvider } from '../voice/vibevoice-tts-provider.js';
import type { STTProvider, TTSProvider } from '../voice/types.js';
import type { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import type { VoiceboxService } from '../voice/voicebox-service.js';
import type { VibeVoiceService } from '../voice/vibevoice-service.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import { VERSION } from '../version.js';
import { logger } from '../lib/logger.js';
import { attachTerminalWebSocket } from './terminal-websocket.js';

export interface ServerDeps {
  config: ServerConfig;
  db: DatabaseAdapter;
  rawDb: Database.Database;
  startTime: number;
  eventBus: TypedEventBus<RuntimeEvents>;
  engine: RuntimeEngine | null;
  orchestrator: LocalOrchestrator | null;
  sessionToken: string;
  triggerEvaluator?: LocalTriggerEvaluator | null;
  workspaceId?: string;
  voiceboxService?: VoiceboxService | null;
  vibeVoiceService?: VibeVoiceService | null;
  modelRouter?: ModelRouter | null;
  getWhatsAppClient?: () => WhatsAppClient | null;
  channelRegistry?: import('../integrations/channel-registry.js').ChannelRegistry;
  messageRouter?: import('../integrations/message-router.js').MessageRouter;
  controlPlane?: import('../control-plane/client.js').ControlPlaneClient | null;
  onScheduleChange?: () => void;
  ragConfig?: import('./routes/rag.js').RagRouterConfig;
}

export interface ServerConfig {
  port: number;
  jwtSecret: string;
  tier?: 'free' | 'connected';
  contentPublicKey?: JsonWebKey;
  dataDir?: string;
}

/**
 * Create and configure the Express server.
 * Serves the web UI SPA, health endpoint (public), and /api/* routes (auth required).
 * Returns the app and a function to attach WebSocket after listen().
 */
export function createServer(deps: ServerDeps): {
  app: express.Application;
  attachWs: (server: Server) => void;
} {
  const { config, db, rawDb, startTime, eventBus, engine, orchestrator, sessionToken, triggerEvaluator, workspaceId, voiceboxService, vibeVoiceService, modelRouter, getWhatsAppClient, channelRegistry, messageRouter, controlPlane, onScheduleChange } = deps;
  const app = express();

  // CORS — restrict to known origins (localhost and cloud app)
  const allowedOrigins = [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https?:\/\/0\.0\.0\.0(:\d+)?$/,
    /^https:\/\/([a-z0-9-]+\.)?ohwow\.fun$/,
  ];
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.some((pattern) => pattern.test(origin))) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));

  app.use(express.json());

  // Global rate limiter: 1000 requests per hour per IP
  app.use(rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));

  // Public routes (no auth)
  app.use(createHealthRouter(startTime, rawDb));
  app.use(createOnboardingRouter(db));

  // Webhook routes (public, no auth — external services call these)
  app.use('/webhooks', rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));
  if (triggerEvaluator) {
    app.use(createWebhookRouter({
      db,
      triggerEvaluator,
      eventBus,
      getWebhookSecret: async () => {
        const { data } = await db.from('runtime_settings')
          .select('value')
          .eq('key', 'ghl_webhook_secret')
          .maybeSingle();
        return (data as { value: string } | null)?.value || undefined;
      },
    }));
  }

  // Public tier endpoint (used by web UI Layout for feature gating + model status)
  app.get('/api/runtime/tier', async (_req, res) => {
    const tierValue = config.tier || 'free';
    // Check if a model is available (Ollama with a downloaded model, or an API key)
    let modelReady = false;
    try {
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN || process.env.OPENROUTER_API_KEY) {
        modelReady = true; // API key available
      } else {
        const ollamaUrl = process.env.OHWOW_OLLAMA_URL || 'http://localhost:11434';
        const tagRes = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (tagRes.ok) {
          const data = await tagRes.json() as { models: Array<{ name: string }> };
          modelReady = (data.models?.length ?? 0) > 0;
        }
      }
    } catch {
      // Ollama not reachable
    }
    res.json({ data: { tier: tierValue, modelReady } });
  });

  // Runtime status (for TUI client to check services)
  app.get('/api/runtime/status', (_req, res) => {
    const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);
    res.json({
      data: {
        pid: process.pid,
        uptime: uptimeSeconds,
        version: VERSION,
        tier: config.tier || 'free',
        engineReady: !!engine,
        orchestratorReady: !!orchestrator,
      },
    });
  });

  // Redirect root to web UI
  app.get('/', (_req, res) => {
    res.redirect('/ui/');
  });

  // Serve web UI static files (before auth middleware)
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Try all possible locations for the web UI build.
  // Production (dist/index.js): __dirname = dist/ → ../dist/web works
  // Dev (src/api/server.ts): __dirname = src/api/ → need ../../dist/web
  const webCandidates = [
    join(__dirname, '..', 'dist', 'web'),
    join(__dirname, '..', '..', 'dist', 'web'),
    join(__dirname, '..', 'src', 'web', 'dist'),
    join(__dirname, '..', '..', 'src', 'web', 'dist'),
  ];
  const webPath = webCandidates.find(p => existsSync(join(p, 'index.html'))) ?? null;

  if (webPath) {
    app.use('/ui', express.static(webPath));
    // SPA fallback: serve index.html for any /ui/* route not matched by static files
    app.get('/ui/{*path}', (_req, res) => {
      res.sendFile(join(webPath, 'index.html'));
    });
  }

  // Public peer pairing route (no auth, must be before auth middleware)
  app.use('/api/peers/pair', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));
  app.use(createPeerPublicRouter(db));

  // Peer RAG query route (peer-token auth, must be before session auth middleware)
  app.use(createRagPublicRouter(db, deps.ragConfig ?? {}));

  // Browser session routes (cloud dashboard calls these for local browser automation)
  // /browser/health is public; /browser/session/* require auth
  app.use(createBrowserSessionRouter());

  // Desktop session routes (cloud dashboard calls these for live desktop viewer)
  // /desktop/health is public; /desktop/screenshot and /desktop/action require auth
  app.use(createDesktopSessionRouter());

  // Authenticated routes (content token or local session token required)
  const auth = createAuthMiddleware(config.jwtSecret, sessionToken, config.contentPublicKey, db);
  app.use('/api', auth);
  app.use('/browser/session', auth);
  app.use('/desktop/screenshot', auth);
  app.use('/desktop/action', auth);

  // Register all API routes
  app.use(createTasksRouter(db, engine));
  app.use(createAgentsRouter(db));
  app.use(createActivityRouter(db));
  app.use(createApprovalsRouter(db));
  app.use(createSchedulesRouter(db, onScheduleChange));
  app.use(createSystemRouter(db, rawDb, startTime));
  if (orchestrator) {
    app.use(createOrchestratorRouter(orchestrator));
  }
  app.use(createVoiceRouter(voiceboxService || undefined));
  app.use(createPodcastRouter(vibeVoiceService || undefined));
  app.use(createSettingsRouter(db));
  app.use(createModelsRouter(db, eventBus, orchestrator));
  app.use(createTriggersRouter(db, triggerEvaluator || undefined, onScheduleChange));
  app.use(createAutomationsRouter(db, workspaceId || 'local', triggerEvaluator || undefined, onScheduleChange));
  app.use(createTemplatesRouter(db, workspaceId || 'local'));
  app.use(createDashboardRouter(db));
  app.use(createContactsRouter(db, eventBus));
  app.use(createRevenueRouter(db, eventBus));
  app.use(createGoalsRouter(db, eventBus));
  app.use(createDepartmentsRouter(db, eventBus));
  app.use(createTeamMembersRouter(db, eventBus));
  app.use(createProjectsRouter(db, eventBus));
  app.use(createWorkflowsRouter(db, modelRouter || undefined));
  app.use(createA2ARouter(db));
  app.use(createPeersRouter(db, { messageRouter: messageRouter ?? undefined, rawDb }));
  app.use(createMcpRouter());
  app.use(createCloudProxyRouter(controlPlane ?? null));
  app.use(createOrgRouter(db));
  app.use(createPdfToolsRouter());
  app.use(createFileAccessRouter(db));
  if (config.dataDir) {
    app.use(createAttachmentsRouter(db, config.dataDir));
  }
  if (getWhatsAppClient) {
    app.use(createWhatsAppRouter(getWhatsAppClient, channelRegistry));
  }

  // Endpoint to get session token info (for the web UI login)
  app.get('/api/session', (_req, res) => {
    res.json({ data: { authenticated: true } });
  });

  // Resolve a pending MCP elicitation request (server asked for user input)
  app.post('/api/elicitation-response', (req, res) => {
    const { requestId, accepted, fields } = req.body as {
      requestId?: string;
      accepted?: boolean;
      fields?: Record<string, unknown>;
    };
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    if (!engine) {
      res.status(503).json({ error: 'Engine not available' });
      return;
    }
    engine.resolveElicitation(requestId, accepted ? (fields ?? {}) : null);
    res.json({ ok: true });
  });

  // Global error handler — must be after all routes
  app.use(errorHandler);

  const attachWs = (server: Server) => {
    attachWebSocket(server, eventBus, sessionToken);

    // Voice WebSocket at /ws/voice
    if (orchestrator) {
      const voiceboxUrl = process.env.VOICEBOX_URL || 'http://localhost:8000';

      // Resolve voice profile ID from DB for a given agent or orchestrator
      async function resolveVoiceProfile(agentId: string): Promise<string | null> {
        try {
          if (agentId === 'orchestrator') {
            const { data } = await db.from<{ value: string }>('runtime_settings')
              .select('value')
              .eq('key', 'orchestrator_voice_profile_id')
              .maybeSingle();
            return data?.value || null;
          }
          const { data } = await db.from<{ voice_profile_id: string | null }>('agent_workforce_agents')
            .select('voice_profile_id')
            .eq('id', agentId)
            .maybeSingle();
          return data?.voice_profile_id || null;
        } catch {
          return null;
        }
      }

      attachVoiceWebSocket({
        server,
        sessionToken,
        createVoiceSession: async (agentId: string, voiceProfileId?: string, mode?: string) => {
          // Client-provided profile takes priority, then DB lookup, then 'default'
          const dbProfileId = !voiceProfileId ? await resolveVoiceProfile(agentId) : null;
          const profileId = voiceProfileId || dbProfileId || 'default';

          let stt: STTProvider;
          let tts: TTSProvider;

          if (mode === 'browser-native') {
            // Browser handles STT/TTS via Web Speech API — use null providers
            const { BrowserNativeSTT, BrowserNativeTTS } = await import('../voice/null-providers.js');
            stt = new BrowserNativeSTT();
            tts = new BrowserNativeTTS();
          } else {
            // Try providers in order: Voicebox > VibeVoice > Whisper Local > Whisper API
            const openaiKey = process.env.OPENAI_API_KEY || '';
            const vibevoiceUrl = process.env.VIBEVOICE_URL || 'http://localhost:8001';
            const sttCandidates: STTProvider[] = [
              new VoiceboxSTTProvider(voiceboxUrl),
              new VibeVoiceSTTProvider(vibevoiceUrl),
              new WhisperLocalProvider(),
              ...(openaiKey ? [new WhisperAPIProvider(openaiKey)] : []),
            ];

            // Try providers in order: Voicebox > VibeVoice > Piper > OpenAI TTS
            const ttsCandidates: TTSProvider[] = [
              new VoiceboxTTSProvider(voiceboxUrl, profileId),
              new VibeVoiceTTSProvider(vibevoiceUrl),
              new PiperProvider(),
              ...(openaiKey ? [new OpenAITTSProvider(openaiKey)] : []),
            ];

            let foundStt: STTProvider | null = null;
            for (const candidate of sttCandidates) {
              if (await candidate.isAvailable()) { foundStt = candidate; break; }
            }
            if (!foundStt) throw new Error('No STT provider available');

            let foundTts: TTSProvider | null = null;
            for (const candidate of ttsCandidates) {
              if (await candidate.isAvailable()) { foundTts = candidate; break; }
            }
            if (!foundTts) throw new Error('No TTS provider available');

            stt = foundStt;
            tts = foundTts;
          }

          return new VoiceSession({
            sttProvider: stt,
            ttsProvider: tts,
            ttsOptions: profileId !== 'default' ? { voiceProfileId: profileId } : {},
            onTranscription: async (text, sttResult) => {
              return orchestrator.chatForChannel(text, `voice-${agentId}`, {
                excludedTools: [],
                platform: 'voice',
                voiceContext: {
                  sttConfidence: sttResult.confidence,
                  sttProvider: stt.name,
                  language: sttResult.language,
                  audioDurationMs: sttResult.durationMs,
                },
              });
            },
          });
        },
      });

      // Preload Voicebox model (non-blocking)
      fetch(`${voiceboxUrl}/models/load`, { method: 'POST', signal: AbortSignal.timeout(60000) })
        .then(() => logger.info('[voice] Voicebox model preloaded'))
        .catch(() => { /* Voicebox not running, that's fine */ });

      // Detect VibeVoice server (non-blocking)
      const vibevoiceDetectUrl = process.env.VIBEVOICE_URL || 'http://localhost:8001';
      fetch(`${vibevoiceDetectUrl}/health`, { signal: AbortSignal.timeout(5000) })
        .then(() => logger.info('[voice] VibeVoice server detected'))
        .catch(() => { /* VibeVoice not running, that's fine */ });
    }

    // Terminal WebSocket at /ws/terminal (PTY sessions for remote shell access)
    attachTerminalWebSocket({
      server,
      sessionToken,
      cloudPublicKey: config.contentPublicKey,
    });
  };

  return { app, attachWs };
}
