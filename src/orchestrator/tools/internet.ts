/**
 * Internet Tools — zero-cost, zero-config internet access for agents.
 * Wraps open-source CLIs (yt-dlp, gh) and pure JS libraries (rss-parser).
 * Inspired by the Agent-Reach channel pattern.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../lib/logger.js';
import { commandExists } from '../../lib/platform-utils.js';
import { ensureYtdlp, ensureGh } from '../../lib/internet-installer.js';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// youtube_transcript — extract subtitles via yt-dlp
// ---------------------------------------------------------------------------

/** Parse VTT subtitle content into clean timestamped text. */
function parseVtt(vtt: string): string {
  const lines = vtt.split('\n');
  const segments: string[] = [];
  let lastText = '';

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headers, empty lines, and timestamp lines
    if (
      !trimmed ||
      trimmed === 'WEBVTT' ||
      trimmed.startsWith('Kind:') ||
      trimmed.startsWith('Language:') ||
      trimmed.startsWith('NOTE') ||
      /^\d{2}:\d{2}/.test(trimmed)
    ) {
      continue;
    }
    // Strip VTT tags like <c> </c> <00:00:01.000>
    const cleaned = trimmed
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    // Deduplicate consecutive identical lines (VTT often repeats)
    if (cleaned && cleaned !== lastText) {
      segments.push(cleaned);
      lastText = cleaned;
    }
  }

  return segments.join('\n');
}

export async function youtubeTranscript(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const url = input.url as string;
  if (!url) return { success: false, error: 'url is required' };

  const lang = (input.language as string) || 'en';

  // Auto-install yt-dlp if missing
  const available = await ensureYtdlp();
  if (!available) {
    return {
      success: false,
      error: 'yt-dlp could not be auto-installed. Install manually: brew install yt-dlp (macOS) or pip install yt-dlp',
    };
  }

  try {
    // Step 1: Get video metadata and subtitle info
    const { stdout: infoJson } = await execFileAsync('yt-dlp', [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      url,
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(infoJson);
    const title = info.title || 'Unknown';
    const duration = info.duration || 0;
    const channel = info.channel || info.uploader || 'Unknown';

    // Step 2: Try to get subtitles (manual first, then auto-generated)
    const subArgs = [
      '--skip-download',
      '--write-sub',
      '--write-auto-sub',
      '--sub-lang', lang,
      '--sub-format', 'vtt',
      '--print', '%(requested_subtitles)j',
      '-o', '-',
      url,
    ];

    // Use yt-dlp to get subtitle URL, then fetch it
    const subtitles = info.subtitles?.[lang] || info.automatic_captions?.[lang];
    if (!subtitles || subtitles.length === 0) {
      return {
        success: true,
        data: {
          title,
          channel,
          duration,
          transcript: null,
          message: `No ${lang} subtitles available for this video`,
        },
      };
    }

    // Find the VTT format subtitle URL
    const vttSub = subtitles.find((s: { ext: string }) => s.ext === 'vtt')
      || subtitles[0];

    if (!vttSub?.url) {
      return {
        success: true,
        data: { title, channel, duration, transcript: null, message: 'Subtitle URL not found' },
      };
    }

    // Step 3: Fetch the subtitle file directly
    const response = await fetch(vttSub.url);
    if (!response.ok) {
      return { success: false, error: `Couldn't fetch subtitles: HTTP ${response.status}` };
    }

    const vttContent = await response.text();
    const transcript = parseVtt(vttContent);

    return {
      success: true,
      data: {
        title,
        channel,
        duration,
        transcript,
        language: lang,
        characterCount: transcript.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'YouTube transcript extraction failed';
    logger.error({ err, url }, '[Internet] YouTube transcript failed');
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// read_rss_feed — parse RSS/Atom feeds via rss-parser
// ---------------------------------------------------------------------------

export async function readRssFeed(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const url = input.url as string;
  if (!url) return { success: false, error: 'url is required' };

  const limit = Math.min((input.limit as number) || 20, 50);

  try {
    // Dynamic import to avoid loading the module until needed
    const Parser = (await import('rss-parser')).default;
    const parser = new Parser({ timeout: 15_000 });

    const feed = await parser.parseURL(url);

    const items = (feed.items || []).slice(0, limit).map((item) => ({
      title: item.title || null,
      link: item.link || null,
      date: item.isoDate || item.pubDate || null,
      author: item.creator || null,
      summary: item.contentSnippet?.slice(0, 500) || null,
      categories: item.categories || [],
    }));

    return {
      success: true,
      data: {
        feedTitle: feed.title || null,
        feedDescription: feed.description || null,
        feedLink: feed.link || null,
        itemCount: items.length,
        items,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'RSS feed parsing failed';
    logger.error({ err, url }, '[Internet] RSS feed parsing failed');
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// github_search — search GitHub via gh CLI
// ---------------------------------------------------------------------------

const GH_SEARCH_FIELDS: Record<string, string> = {
  repos: 'name,owner,description,url,stargazersCount,forksCount,updatedAt,language,isArchived',
  issues: 'title,url,state,author,createdAt,updatedAt,labels,repository',
  prs: 'title,url,state,author,createdAt,updatedAt,labels,repository',
  code: 'path,repository,url,textMatches',
};

export async function githubSearch(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const query = input.query as string;
  if (!query) return { success: false, error: 'query is required' };

  const searchType = (input.type as string) || 'repos';
  const limit = Math.min((input.limit as number) || 10, 30);

  if (!GH_SEARCH_FIELDS[searchType]) {
    return { success: false, error: `Invalid type "${searchType}". Use: repos, issues, prs, or code` };
  }

  // Auto-install gh if missing
  const available = await ensureGh();
  if (!available) {
    return {
      success: false,
      error: 'gh CLI could not be auto-installed. Install manually: brew install gh (macOS) or see https://cli.github.com',
    };
  }

  try {
    const fields = GH_SEARCH_FIELDS[searchType];
    const { stdout } = await execFileAsync('gh', [
      'search', searchType,
      query,
      '--json', fields,
      '--limit', String(limit),
    ], { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 });

    const results = JSON.parse(stdout || '[]');

    return {
      success: true,
      data: {
        query,
        type: searchType,
        resultCount: results.length,
        results,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub search failed';
    // Check for auth errors
    if (message.includes('auth login') || message.includes('not logged')) {
      return {
        success: false,
        error: 'gh CLI is not authenticated. Run: gh auth login',
      };
    }
    logger.error({ err, query }, '[Internet] GitHub search failed');
    return { success: false, error: message };
  }
}
