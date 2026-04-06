/**
 * Predictive Pre-Fetch
 *
 * Anticipates which device-pinned data an agent will need based on
 * conversation context and task keywords. Pre-fetches into the
 * ephemeral cache so the data is ready when the agent actually needs it.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { DeviceDataFetcher } from './fetch-client.js';
import { searchManifest, type ManifestEntry } from './manifest.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// KEYWORD EXTRACTION
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'and', 'but', 'or', 'not', 'no',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'what', 'which', 'who', 'when', 'where', 'how', 'about', 'just', 'very',
  'also', 'some', 'any', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'such', 'than', 'too', 'like', 'want', 'need', 'help',
  'please', 'thanks', 'thank', 'good', 'well', 'make', 'get', 'know',
]);

function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

// ============================================================================
// PREDICTION
// ============================================================================

/**
 * Predict which device-pinned data might be needed for a task or conversation.
 * Returns manifest entries sorted by relevance.
 */
export async function predictNeededData(
  db: DatabaseAdapter,
  workspaceId: string,
  context: {
    taskTitle?: string;
    taskInput?: string;
    userMessage?: string;
    agentRole?: string;
  },
): Promise<ManifestEntry[]> {
  // Build keyword set from all available context
  const parts = [
    context.taskTitle ?? '',
    context.taskInput ?? '',
    context.userMessage ?? '',
    context.agentRole ?? '',
  ].join(' ');

  const keywords = extractKeywords(parts);
  if (keywords.length === 0) return [];

  // Search manifest
  const matches = await searchManifest(db, workspaceId, keywords, { limit: 5 });

  return matches;
}

/**
 * Pre-fetch predicted data into the ephemeral cache.
 * Fire-and-forget — failures are logged but don't block.
 */
export async function preFetchPredicted(
  db: DatabaseAdapter,
  workspaceId: string,
  fetcher: DeviceDataFetcher,
  context: {
    taskTitle?: string;
    taskInput?: string;
    userMessage?: string;
    agentRole?: string;
  },
): Promise<number> {
  const predictions = await predictNeededData(db, workspaceId, context);
  if (predictions.length === 0) return 0;

  let fetched = 0;

  // Fetch top 3 in parallel, with short timeout
  const top = predictions.slice(0, 3);

  await Promise.allSettled(
    top.map(async (entry) => {
      try {
        await fetcher.fetch(entry.dataId);
        fetched++;
        logger.debug({ dataId: entry.dataId, title: entry.title }, '[predictive-fetch] Pre-fetched');
      } catch {
        // Expected: device offline, access denied, etc.
      }
    }),
  );

  if (fetched > 0) {
    logger.info({ predicted: predictions.length, fetched }, '[predictive-fetch] Pre-fetch complete');
  }

  return fetched;
}
