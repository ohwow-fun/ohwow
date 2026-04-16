/**
 * generate_video_from_spec — orchestrator tool that renders a VideoSpec JSON
 * to an MP4 via the composed video-generation skill. Distinct from the legacy
 * `generate_video` tool (which hits a generative model for a short clip). Use
 * this tool for deterministic, reproducible demos and branded content.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { runVideoGeneration } from '../../execution/skills/video_generation.js';
import { logger } from '../../lib/logger.js';

export async function generateVideoFromSpec(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const specPath = input.spec_path as string | undefined;
  if (!specPath) {
    return {
      success: false,
      error: 'spec_path is required. Provide an absolute path to a VideoSpec JSON file.',
    };
  }

  const outputPath = input.output_path as string | undefined;
  const packageDir = input.package_dir as string | undefined;

  try {
    const result = await runVideoGeneration({
      specPath,
      outputPath,
      packageDir,
    });
    const audioUrl = `/media/videos/${encodeURIComponent(result.filename)}`;
    return {
      success: true,
      data: {
        video_url: audioUrl,
        download_url: `${audioUrl}?download=1`,
        path: result.path,
        filename: result.filename,
        size_bytes: result.sizeBytes,
        duration_ms: result.durationMs,
        spec_hash: result.specHash,
        spec_path: result.specPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Video generation failed';
    logger.error(`[generate_video_from_spec] ${msg}`);
    return { success: false, error: msg };
  }
}
