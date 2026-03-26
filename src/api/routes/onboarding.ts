/**
 * Onboarding API Routes
 * Public endpoints (no auth required) for the web onboarding flow.
 * Handles model setup, business profiling, AI agent discovery, and agent creation.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { OnboardingService } from '../../lib/onboarding-service.js';
import { loadConfig, updateConfigFile } from '../../config.js';
import {
  saveWorkspaceData,
  createAgentsFromPresets,
  buildAgentDiscoveryPrompt,
  getPresetsForBusinessType,
  getStaticRecommendations,
  getBusinessTypes,
  type WorkspaceData,
  type AgentToCreate,
} from '../../lib/onboarding-logic.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createOnboardingRouter(db?: DatabaseAdapter | null): Router {
  const router = Router();
  const service = new OnboardingService();

  /** GET /api/onboarding/status — Device info, recommendations, Ollama status */
  router.get('/api/onboarding/status', async (_req: Request, res: Response) => {
    try {
      const status = await service.initialize();
      res.json({ data: status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Status check failed' });
    }
  });

  /** POST /api/onboarding/ensure-ollama — Install/start Ollama with SSE progress */
  router.post('/api/onboarding/ensure-ollama', async (_req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      // Initialize first so device info is available
      await service.initialize();

      for await (const progress of service.ensureOllama()) {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        if (progress.error) break;
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ phase: 'error', message: err instanceof Error ? err.message : 'Unknown error', error: true })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });

  /** POST /api/onboarding/download-model — Download model with SSE progress */
  router.post('/api/onboarding/download-model', async (req: Request, res: Response) => {
    const { tag } = req.body as { tag?: string };
    if (!tag) {
      res.status(400).json({ error: 'Missing model tag' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      for await (const progress of service.downloadModel(tag)) {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        if (progress.error) break;
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ phase: 'downloading_model', message: err instanceof Error ? err.message : 'Unknown error', error: true })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });

  /** POST /api/onboarding/complete — Save config + business data + create agents */
  router.post('/api/onboarding/complete', async (req: Request, res: Response) => {
    // Only accept from loopback addresses (local runtime security)
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
    if (!isLocal) {
      res.status(403).json({ error: 'Onboarding completion is only available locally' });
      return;
    }

    const {
      modelTag,
      businessName,
      businessType,
      businessDescription,
      founderPath,
      founderFocus,
      agents,
      goal,
    } = req.body as {
      modelTag?: string;
      businessName?: string;
      businessType?: string;
      businessDescription?: string;
      founderPath?: string;
      founderFocus?: string;
      agents?: AgentToCreate[];
      goal?: { title: string; metric?: string; target?: number; unit?: string };
    };

    try {
      // Save config file (model + onboarding flags)
      const config = service.saveFreeTierConfig(modelTag || 'qwen3:4b');

      // Mark both onboarding and agent setup as complete
      updateConfigFile({
        onboardingComplete: true,
        agentSetupComplete: true,
        pendingAgentSetup: null,
      });

      // Save workspace data to SQLite (if db available)
      if (db && businessName) {
        const workspaceData: WorkspaceData = {
          businessName: businessName || '',
          businessType: businessType || '',
          businessDescription: businessDescription || '',
          founderPath: founderPath || '',
          founderFocus: founderFocus || '',
        };
        await saveWorkspaceData(db, 'local', workspaceData);
      }

      // Create agents in SQLite (if db available and agents provided)
      if (db && agents && agents.length > 0) {
        await createAgentsFromPresets(db, agents, 'local', modelTag || 'qwen3:4b');
      }

      // Create goal if discovered during chat
      if (db && goal?.title) {
        const goalId = randomUUID();
        const now = new Date().toISOString();
        await db.from('agent_workforce_goals').insert({
          id: goalId,
          workspace_id: 'local',
          title: goal.title,
          description: null,
          target_metric: goal.metric || null,
          target_value: goal.target != null ? goal.target : null,
          current_value: 0,
          unit: goal.unit || null,
          status: 'active',
          priority: 'high',
          color: '#6366f1',
          position: 0,
          created_at: now,
          updated_at: now,
        });
      }

      res.json({ data: { config, tier: config.tier } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not save config' });
    }
  });

  /** POST /api/onboarding/chat — SSE streaming chat with local Ollama for agent discovery */
  router.post('/api/onboarding/chat', async (req: Request, res: Response) => {
    const { messages, businessType, founderPath, founderFocus } = req.body as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      businessType: string;
      founderPath: string;
      founderFocus: string;
    };

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'Missing messages' });
      return;
    }

    // Build system prompt with business context
    const presets = getPresetsForBusinessType(businessType || 'saas_startup');
    const systemPrompt = buildAgentDiscoveryPrompt(
      businessType || 'saas_startup',
      founderPath || 'exploring',
      founderFocus || '',
      presets,
    );

    // Get Ollama URL from config or default
    let ollamaUrl = 'http://localhost:11434';
    let ollamaModel = 'qwen3:4b';
    try {
      const cfg = loadConfig();
      ollamaUrl = cfg.ollamaUrl;
      ollamaModel = cfg.ollamaModel;
    } catch {
      // Use defaults
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      // Build Ollama chat messages
      const ollamaMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ];

      const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages: ollamaMessages,
          max_tokens: 1024,
          temperature: 0.7,
          stream: true,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      // Stream SSE chunks from Ollama to the client
      const reader = response.body.getReader();
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
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
              continue;
            }
            try {
              const chunk = JSON.parse(data) as {
                choices: Array<{ delta: { content?: string } }>;
              };
              const content = chunk.choices?.[0]?.delta?.content;
              if (content) {
                res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        content: err instanceof Error ? err.message : 'Chat failed',
      })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });

  /** GET /api/onboarding/presets — Get agent presets for a business type */
  router.get('/api/onboarding/presets', (req: Request, res: Response) => {
    const businessType = (req.query.businessType as string) || 'saas_startup';
    const presets = getPresetsForBusinessType(businessType);
    const recommended = getStaticRecommendations(businessType);
    res.json({ data: { presets, recommended, businessTypes: getBusinessTypes() } });
  });

  /** GET /api/onboarding/model-available — Check if Ollama has a model ready */
  router.get('/api/onboarding/model-available', async (_req: Request, res: Response) => {
    try {
      let ollamaUrl = 'http://localhost:11434';
      let ollamaModel = 'qwen3:4b';
      try {
        const cfg = loadConfig();
        ollamaUrl = cfg.ollamaUrl;
        ollamaModel = cfg.ollamaModel;
      } catch {
        // Use defaults
      }

      // Check if Ollama is running
      const healthRes = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!healthRes.ok) {
        res.json({ data: { available: false, reason: 'Ollama not running' } });
        return;
      }

      const data = await healthRes.json() as { models: Array<{ name: string }> };
      const modelBase = ollamaModel.split(':')[0];
      const hasModel = data.models?.some(m => m.name.startsWith(modelBase)) ?? false;

      res.json({ data: { available: hasModel, model: ollamaModel } });
    } catch {
      res.json({ data: { available: false, reason: 'Could not reach Ollama' } });
    }
  });

  return router;
}
