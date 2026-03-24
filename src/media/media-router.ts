/**
 * Media Router
 *
 * Cost-aware routing that picks the best media generation provider
 * based on quality preference, local availability, and cost constraints.
 */

import type { McpClientManager } from '../mcp/client.js';
import { logger } from '../lib/logger.js';

export type MediaModality = 'image' | 'video' | 'tts' | 'stt';
export type MediaQuality = 'draft' | 'standard' | 'premium';

export interface MediaRequest {
  type: MediaModality;
  quality: MediaQuality;
  preferLocal: boolean;
  maxCostCredits?: number;
}

export interface MediaRoute {
  /** The namespaced MCP tool name to call (e.g. mcp__fal-ai__generate_image). */
  toolName: string;
  /** The server providing this tool. */
  serverName: string;
  /** Whether this is a local provider (zero credit cost). */
  isLocal: boolean;
  /** Estimated credit cost per unit. */
  estimatedCredits: number;
}

/** Known media MCP servers and their capabilities. */
const MEDIA_SERVER_PROFILES: Record<string, {
  modalities: MediaModality[];
  quality: MediaQuality[];
  isLocal: boolean;
  /** Cost tier: lower = cheaper */
  costTier: number;
}> = {
  'comfyui': { modalities: ['image', 'video'], quality: ['draft', 'standard', 'premium'], isLocal: true, costTier: 0 },
  'kokoro': { modalities: ['tts'], quality: ['draft', 'standard'], isLocal: true, costTier: 0 },
  'whisper': { modalities: ['stt'], quality: ['draft', 'standard', 'premium'], isLocal: true, costTier: 0 },
  'fal-ai': { modalities: ['image', 'video'], quality: ['draft', 'standard', 'premium'], costTier: 2, isLocal: false },
  'replicate': { modalities: ['image', 'video'], quality: ['draft', 'standard', 'premium'], costTier: 2, isLocal: false },
  'openai-image': { modalities: ['image'], quality: ['standard', 'premium'], costTier: 3, isLocal: false },
  'minimax': { modalities: ['image', 'video', 'tts'], quality: ['standard', 'premium'], costTier: 3, isLocal: false },
  'elevenlabs': { modalities: ['tts'], quality: ['standard', 'premium'], costTier: 4, isLocal: false },
};

const CREDIT_COSTS: Record<MediaModality, Record<MediaQuality, number>> = {
  image: { draft: 5, standard: 25, premium: 55 },
  video: { draft: 10, standard: 50, premium: 400 },
  tts: { draft: 2, standard: 2, premium: 5 },
  stt: { draft: 3, standard: 3, premium: 5 },
};

/**
 * Find the best available MCP tool for a media generation request.
 * Returns null if no suitable provider is connected.
 */
export function routeMediaRequest(
  request: MediaRequest,
  mcpClients: McpClientManager | null,
): MediaRoute | null {
  if (!mcpClients) return null;

  const tools = mcpClients.getToolDefinitions();
  const connectedServers = new Set<string>();

  // Extract server names from connected MCP tools
  for (const tool of tools) {
    const match = tool.name.match(/^mcp__([^_]+(?:__[^_]+)?)__/);
    if (match) {
      // Normalize: mcp__fal-ai__tool → fal-ai
      const serverName = match[1].replace(/__/g, '-');
      connectedServers.add(serverName);
    }
  }

  // Build candidate list from connected servers that support this modality
  const candidates: Array<{
    serverName: string;
    profile: typeof MEDIA_SERVER_PROFILES[string];
  }> = [];

  for (const [serverName, profile] of Object.entries(MEDIA_SERVER_PROFILES)) {
    if (!connectedServers.has(serverName)) continue;
    if (!profile.modalities.includes(request.type)) continue;
    if (!profile.quality.includes(request.quality)) continue;
    candidates.push({ serverName, profile });
  }

  if (candidates.length === 0) return null;

  // Sort candidates by preference
  candidates.sort((a, b) => {
    // 1. Prefer local if requested
    if (request.preferLocal) {
      if (a.profile.isLocal && !b.profile.isLocal) return -1;
      if (!a.profile.isLocal && b.profile.isLocal) return 1;
    }

    // 2. For draft quality, prefer cheapest
    if (request.quality === 'draft') {
      return a.profile.costTier - b.profile.costTier;
    }

    // 3. For premium quality, prefer higher-tier providers (better quality)
    if (request.quality === 'premium') {
      return b.profile.costTier - a.profile.costTier;
    }

    // 4. Standard: balance cost and quality
    return a.profile.costTier - b.profile.costTier;
  });

  const winner = candidates[0];
  const estimatedCredits = winner.profile.isLocal
    ? 0
    : CREDIT_COSTS[request.type]?.[request.quality] ?? 5;

  // Check cost cap
  if (request.maxCostCredits != null && estimatedCredits > request.maxCostCredits) {
    logger.info(`[media-router] Best provider ${winner.serverName} costs ${estimatedCredits} credits, exceeds cap of ${request.maxCostCredits}`);
    // Try to find a cheaper alternative
    const cheaper = candidates.find(c =>
      (c.profile.isLocal ? 0 : CREDIT_COSTS[request.type]?.[request.quality] ?? 5) <= request.maxCostCredits!
    );
    if (!cheaper) return null;
    return {
      toolName: `mcp__${cheaper.serverName}`,
      serverName: cheaper.serverName,
      isLocal: cheaper.profile.isLocal,
      estimatedCredits: cheaper.profile.isLocal ? 0 : CREDIT_COSTS[request.type]?.[request.quality] ?? 5,
    };
  }

  return {
    toolName: `mcp__${winner.serverName}`,
    serverName: winner.serverName,
    isLocal: winner.profile.isLocal,
    estimatedCredits,
  };
}

/**
 * Get a human-readable cost estimate for a media operation.
 */
export function estimateMediaCost(
  type: MediaModality,
  quality: MediaQuality,
  isLocal: boolean,
  units?: number,
): { credits: number; description: string } {
  if (isLocal) {
    return { credits: 0, description: 'Free (local generation)' };
  }

  const perUnit = CREDIT_COSTS[type]?.[quality] ?? 5;
  const total = units ? Math.ceil(perUnit * units) : perUnit;

  const unitLabel = type === 'video' ? 'per second'
    : type === 'tts' ? 'per 1K characters'
    : type === 'stt' ? 'per minute'
    : '';

  const desc = units
    ? `${total} credits (${perUnit} ${unitLabel} x ${units})`
    : `${total} credits`;

  return { credits: total, description: desc };
}
