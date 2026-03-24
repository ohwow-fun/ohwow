/**
 * Desktop Screenshot Capture
 * macOS screen capture via `screencapture` CLI + Retina-aware coordinate scaling via `sharp`.
 *
 * Design decisions:
 * - Uses macOS `screencapture -x` (zero native dependencies, works on all macOS versions)
 * - Resizes screenshots to max 1280px longest edge before sending to LLM
 *   (Anthropic research shows 4-5x accuracy improvement vs API-side resizing)
 * - Handles Retina displays by detecting physical vs logical pixel ratio
 */

import { execFileSync, execSync } from 'child_process';
import { readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { logger } from '../../lib/logger.js';
import type { ScreenInfo } from './desktop-types.js';

// ============================================================================
// DEFAULTS
// ============================================================================

/** Max pixels on longest edge for LLM consumption (WXGA sweet spot) */
const DEFAULT_MAX_LONG_EDGE = 1280;

// ============================================================================
// SCREEN DETECTION
// ============================================================================

/**
 * Detect primary display resolution and Retina scale factor.
 * Uses macOS `system_profiler` to query display data.
 */
export function detectScreenInfo(): ScreenInfo {
  try {
    const output = execSync(
      'system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Resolution|Retina"',
      { encoding: 'utf-8', timeout: 5000 },
    );

    // Parse resolution: "Resolution: 2560 x 1440 (QHD/WQHD)" or "3456 x 2234 Retina"
    const resMatch = output.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
    const isRetina = /retina/i.test(output);

    if (resMatch) {
      const width = parseInt(resMatch[1], 10);
      const height = parseInt(resMatch[2], 10);
      // system_profiler reports logical resolution for Retina, physical for non-Retina
      // screencapture always captures at physical pixels
      const scaleFactor = isRetina ? 2 : 1;
      return {
        physicalWidth: width * scaleFactor,
        physicalHeight: height * scaleFactor,
        scaleFactor,
      };
    }
  } catch (err) {
    logger.warn(`[desktop] Could not detect screen info: ${err}`);
  }

  // Fallback: assume 1920x1080 non-Retina
  return { physicalWidth: 1920, physicalHeight: 1080, scaleFactor: 1 };
}

// ============================================================================
// SCREENSHOT CAPTURE
// ============================================================================

/**
 * Capture a screenshot of the entire macOS screen, resize for LLM consumption,
 * and return as base64 JPEG.
 */
export async function captureAndScaleScreenshot(
  screenInfo: ScreenInfo,
  maxLongEdge: number = DEFAULT_MAX_LONG_EDGE,
): Promise<{ base64: string; scaledWidth: number; scaledHeight: number }> {
  const tmpPath = join(tmpdir(), `ohwow-desktop-${Date.now()}.jpg`);

  try {
    // Capture full screen as JPEG (silent, no click sound)
    execFileSync('screencapture', ['-x', '-t', 'jpg', tmpPath], {
      timeout: 10000,
    });

    const rawBuffer = readFileSync(tmpPath);

    // Get actual captured dimensions (may differ from system_profiler on multi-monitor)
    const metadata = await sharp(rawBuffer).metadata();
    const capturedWidth = metadata.width ?? screenInfo.physicalWidth;
    const capturedHeight = metadata.height ?? screenInfo.physicalHeight;

    // Update screen info with actual captured dimensions
    screenInfo.physicalWidth = capturedWidth;
    screenInfo.physicalHeight = capturedHeight;

    // Calculate scaled dimensions preserving aspect ratio
    const { scaledWidth, scaledHeight } = calculateScaledDimensions(
      capturedWidth,
      capturedHeight,
      maxLongEdge,
    );

    // Resize and compress
    const scaledBuffer = await sharp(rawBuffer)
      .resize({ width: scaledWidth, height: scaledHeight, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();

    const base64 = scaledBuffer.toString('base64');

    return { base64, scaledWidth, scaledHeight };
  } finally {
    // Clean up temp file
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ============================================================================
// COORDINATE SCALING
// ============================================================================

/**
 * Calculate scaled image dimensions preserving aspect ratio.
 * Constrains the longest edge to maxLongEdge.
 */
export function calculateScaledDimensions(
  physicalWidth: number,
  physicalHeight: number,
  maxLongEdge: number,
): { scaledWidth: number; scaledHeight: number } {
  const longestEdge = Math.max(physicalWidth, physicalHeight);

  if (longestEdge <= maxLongEdge) {
    return { scaledWidth: physicalWidth, scaledHeight: physicalHeight };
  }

  const ratio = maxLongEdge / longestEdge;
  return {
    scaledWidth: Math.round(physicalWidth * ratio),
    scaledHeight: Math.round(physicalHeight * ratio),
  };
}

/**
 * Scale coordinates from LLM image space back to physical screen space.
 * The LLM sees a scaled-down image; we need to map its clicks to real pixels.
 */
export function scaleToPhysical(
  x: number,
  y: number,
  scaledWidth: number,
  scaledHeight: number,
  physicalWidth: number,
  physicalHeight: number,
): { x: number; y: number } {
  const scaleX = physicalWidth / scaledWidth;
  const scaleY = physicalHeight / scaledHeight;
  return {
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY),
  };
}
