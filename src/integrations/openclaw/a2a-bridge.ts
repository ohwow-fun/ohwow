/**
 * OpenClaw A2A Bridge
 * Expose OpenClaw as a Google A2A-compatible agent, and register routes.
 */

import type { Application } from 'express';
import { logger } from '../../lib/logger.js';
import type { OpenClawConfig } from './types.js';
import { listAvailableSkills } from './skill-registry.js';

interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  skills: Array<{ id: string; name: string; description: string }>;
}

/**
 * Build an A2A agent card for the OpenClaw integration.
 */
export function buildOpenClawAgentCard(
  config: OpenClawConfig,
  localUrl: string,
): A2AAgentCard {
  const skills = config.binaryPath
    ? listAvailableSkills(config.binaryPath)
        .filter(s => config.allowlistedSkills.includes(s.id))
        .map(s => ({ id: s.id, name: s.name, description: s.description }))
    : [];

  return {
    name: 'OpenClaw Agent',
    description: 'OpenClaw skills exposed via ohwow A2A bridge',
    url: `${localUrl}/.well-known/openclaw-agent-card.json`,
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    skills,
  };
}

/**
 * Handle an A2A task request targeting an OpenClaw skill.
 */
export async function handleOpenClawA2ATask(
  config: OpenClawConfig,
  taskPayload: { skillId: string; input: Record<string, unknown> },
): Promise<{ success: boolean; output: string; error?: string }> {
  if (!config.allowlistedSkills.includes(taskPayload.skillId)) {
    return { success: false, output: '', error: `Skill "${taskPayload.skillId}" is not allowlisted` };
  }

  try {
    const { execFileSync } = await import('child_process');
    const inputJson = JSON.stringify(taskPayload.input);

    const output = execFileSync(config.binaryPath, ['skill', 'run', taskPayload.skillId, '--input', inputJson], {
      encoding: 'utf-8',
      timeout: config.maxExecutionTimeMs,
      env: {
        ...(process.platform === 'win32'
          ? { USERPROFILE: 'C:\\Temp\\openclaw-sandbox', TEMP: 'C:\\Temp\\openclaw-sandbox', TMP: 'C:\\Temp\\openclaw-sandbox', PATH: 'C:\\Windows\\System32;C:\\Windows' }
          : { HOME: '/tmp/openclaw-sandbox', TMPDIR: '/tmp/openclaw-sandbox', PATH: '/usr/bin:/bin' }),
        OPENCLAW_SANDBOX: '1',
        ...(!config.sandboxAllowNetwork ? { OPENCLAW_NO_NETWORK: '1' } : {}),
      },
    });

    return { success: true, output: output.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, skillId: taskPayload.skillId }, '[OpenClaw] A2A task execution failed');
    return { success: false, output: '', error: message };
  }
}

/**
 * Register OpenClaw A2A routes on the Express app.
 */
export function registerOpenClawA2ARoutes(
  app: Application,
  config: OpenClawConfig,
  localUrl: string,
): void {
  // Agent card discovery endpoint
  app.get('/.well-known/openclaw-agent-card.json', (_req, res) => {
    const card = buildOpenClawAgentCard(config, localUrl);
    res.json(card);
  });

  // A2A task endpoint
  app.post('/a2a/openclaw/task', async (req, res) => {
    const { skillId, input } = req.body as { skillId?: string; input?: Record<string, unknown> };

    if (!skillId) {
      res.status(400).json({ error: 'Missing skillId' });
      return;
    }

    const result = await handleOpenClawA2ATask(config, {
      skillId,
      input: input ?? {},
    });

    if (result.success) {
      res.json({ status: 'completed', output: result.output });
    } else {
      res.status(500).json({ status: 'failed', error: result.error });
    }
  });

  logger.info('[OpenClaw] A2A routes registered');
}
