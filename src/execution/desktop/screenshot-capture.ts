/**
 * Desktop Screenshot Capture
 * macOS screen capture via `screencapture` CLI + Retina-aware coordinate scaling via `sharp`.
 *
 * Design decisions:
 * - Uses macOS `screencapture -x` (zero native dependencies, works on all macOS versions)
 * - Resizes screenshots to max 1280px longest edge before sending to LLM
 *   (Anthropic research shows 4-5x accuracy improvement vs API-side resizing)
 * - Handles Retina displays by detecting physical vs logical pixel ratio
 * - Multi-monitor: detects all displays via system_profiler + Swift/CoreGraphics
 */

import { execFileSync, execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../lib/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any = null;

async function loadSharp(): Promise<typeof import('sharp')> {
  if (!sharpModule) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      throw new Error(
        'Screenshot scaling requires sharp. Install it with: npm install sharp',
      );
    }
  }
  return sharpModule;
}
import type { ScreenInfo, DisplayInfo } from './desktop-types.js';

// ============================================================================
// DEFAULTS
// ============================================================================

/** Max pixels on longest edge for LLM consumption (WXGA sweet spot) */
const DEFAULT_MAX_LONG_EDGE = 1280;

// ============================================================================
// DISPLAY DETECTION (multi-monitor)
// ============================================================================

interface QuartzDisplay {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  main: boolean;
}

interface SystemProfilerDisplay {
  name: string;
  logicalWidth: number;
  logicalHeight: number;
  isRetina: boolean;
}

/**
 * Get display positions and sizes via Swift/CoreGraphics.
 * Swift ships with macOS. Returns logical (point) coordinates.
 */
function detectDisplayPositions(): QuartzDisplay[] {
  try {
    const swiftCode = `
import CoreGraphics
var ids = [CGDirectDisplayID](repeating: 0, count: 16)
var cnt: UInt32 = 0
CGGetActiveDisplayList(16, &ids, &cnt)
let m = CGMainDisplayID()
print("[")
for i in 0..<Int(cnt) {
    let d = ids[i]; let b = CGDisplayBounds(d)
    let sep = i < Int(cnt)-1 ? "," : ""
    print("{\\"id\\":\\(d),\\"x\\":\\(Int(b.origin.x)),\\"y\\":\\(Int(b.origin.y)),\\"w\\":\\(Int(b.size.width)),\\"h\\":\\(Int(b.size.height)),\\"main\\":\\(d==m)}\\(sep)")
}
print("]")
`;
    const output = execSync(`swift -e '${swiftCode.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    return JSON.parse(output) as QuartzDisplay[];
  } catch (err) {
    logger.debug(`[desktop] Swift display detection failed: ${err}`);
    return [];
  }
}

/**
 * Parse all displays from system_profiler SPDisplaysDataType.
 * Returns display names, logical resolutions, and Retina status.
 */
function parseSystemProfilerDisplays(): SystemProfilerDisplay[] {
  try {
    const output = execSync('system_profiler SPDisplaysDataType 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const displays: SystemProfilerDisplay[] = [];
    const lines = output.split('\n');
    let currentName = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Display name: indented line ending with ":" that precedes Resolution
      // e.g. "        Color LCD:" or "        LED MONITOR:"
      if (trimmed.endsWith(':') && !trimmed.startsWith('Resolution') &&
          !trimmed.startsWith('Chipset') && !trimmed.startsWith('Type') &&
          !trimmed.startsWith('Bus') && !trimmed.startsWith('Vendor') &&
          !trimmed.startsWith('Metal') && !trimmed.startsWith('Displays') &&
          !trimmed.startsWith('Total') && !trimmed.startsWith('Display Type') &&
          !trimmed.startsWith('UI Looks') && !trimmed.startsWith('Mirror') &&
          !trimmed.startsWith('Online') && !trimmed.startsWith('Automatically') &&
          !trimmed.startsWith('Connection') && !trimmed.startsWith('Rotation') &&
          !trimmed.startsWith('Main Display')) {
        // Check if the next few lines contain a Resolution line
        let hasResolution = false;
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j].trim().startsWith('Resolution:')) { hasResolution = true; break; }
          if (lines[j].trim().endsWith(':') && !lines[j].trim().startsWith('Display Type')) break;
        }
        if (hasResolution) {
          currentName = trimmed.replace(/:$/, '');
        }
      }

      // Resolution line: "Resolution: 2560 x 1664 Retina" or "Resolution: 1920 x 1080 (1080p...)"
      const resMatch = trimmed.match(/^Resolution:\s*(\d+)\s*x\s*(\d+)/);
      if (resMatch) {
        const isRetina = /retina/i.test(trimmed);
        displays.push({
          name: currentName || `Display ${displays.length + 1}`,
          logicalWidth: parseInt(resMatch[1], 10),
          logicalHeight: parseInt(resMatch[2], 10),
          isRetina,
        });
      }
    }

    return displays;
  } catch (err) {
    logger.debug(`[desktop] system_profiler parsing failed: ${err}`);
    return [];
  }
}

/**
 * Detect all connected displays with positions, resolutions, and Retina status.
 * Uses system_profiler for names/resolution/Retina + Swift/CoreGraphics for positions.
 */
export function detectAllDisplays(): DisplayInfo[] {
  const quartzDisplays = detectDisplayPositions();
  const profilerDisplays = parseSystemProfilerDisplays();

  if (quartzDisplays.length === 0 && profilerDisplays.length === 0) {
    return [];
  }

  // If we have Quartz data, correlate with system_profiler by matching logical resolution
  if (quartzDisplays.length > 0) {
    // Sort: primary first, then left-to-right by origin
    const sorted = [...quartzDisplays].sort((a, b) => {
      if (a.main && !b.main) return -1;
      if (!a.main && b.main) return 1;
      return a.x - b.x;
    });

    const usedProfiler = new Set<number>();
    const displays: DisplayInfo[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const qd = sorted[i];

      // Find matching system_profiler entry by logical resolution
      let matched: SystemProfilerDisplay | undefined;
      for (let j = 0; j < profilerDisplays.length; j++) {
        if (usedProfiler.has(j)) continue;
        const pd = profilerDisplays[j];
        if (pd.logicalWidth === qd.w && pd.logicalHeight === qd.h) {
          matched = pd;
          usedProfiler.add(j);
          break;
        }
        // For Retina: system_profiler reports logical resolution matching Quartz
        // For non-Retina: both report the same physical resolution
      }

      const isRetina = matched?.isRetina ?? false;
      const scaleFactor = isRetina ? 2 : 1;

      displays.push({
        displayNumber: i + 1,
        name: matched?.name ?? `Display ${i + 1}`,
        isPrimary: qd.main,
        physicalWidth: qd.w * scaleFactor,
        physicalHeight: qd.h * scaleFactor,
        logicalWidth: qd.w,
        logicalHeight: qd.h,
        scaleFactor,
        originX: qd.x,
        originY: qd.y,
      });
    }

    return displays;
  }

  // Fallback: system_profiler only (no position data)
  // Assume horizontal side-by-side arrangement
  let offsetX = 0;
  return profilerDisplays.map((pd, i) => {
    const scaleFactor = pd.isRetina ? 2 : 1;
    const physW = pd.logicalWidth * scaleFactor;
    const physH = pd.logicalHeight * scaleFactor;
    const display: DisplayInfo = {
      displayNumber: i + 1,
      name: pd.name,
      isPrimary: i === 0,
      physicalWidth: physW,
      physicalHeight: physH,
      logicalWidth: pd.logicalWidth,
      logicalHeight: pd.logicalHeight,
      scaleFactor,
      originX: offsetX,
      originY: 0,
    };
    offsetX += pd.logicalWidth;
    return display;
  });
}

// ============================================================================
// SCREEN DETECTION
// ============================================================================

/**
 * Detect display configuration: all displays with positions and resolutions.
 * Falls back to single-display detection if multi-monitor detection fails.
 */
export function detectScreenInfo(): ScreenInfo {
  const displays = detectAllDisplays();

  if (displays.length > 0) {
    const primary = displays.find(d => d.isPrimary) ?? displays[0];
    // Composite dimensions will be corrected by sharp metadata after first capture
    // For now, estimate from display positions
    const maxRight = Math.max(...displays.map(d => (d.originX + d.logicalWidth) * d.scaleFactor));
    const maxBottom = Math.max(...displays.map(d => (d.originY + d.logicalHeight) * d.scaleFactor));
    const minLeft = Math.min(...displays.map(d => d.originX * d.scaleFactor));
    const minTop = Math.min(...displays.map(d => d.originY * d.scaleFactor));

    return {
      physicalWidth: maxRight - minLeft,
      physicalHeight: maxBottom - minTop,
      scaleFactor: primary.scaleFactor,
      displays,
    };
  }

  // Legacy single-display fallback
  try {
    const output = execSync(
      'system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Resolution|Retina"',
      { encoding: 'utf-8', timeout: 5000 },
    );

    const resMatch = output.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
    const isRetina = /retina/i.test(output);

    if (resMatch) {
      const width = parseInt(resMatch[1], 10);
      const height = parseInt(resMatch[2], 10);
      const scaleFactor = isRetina ? 2 : 1;
      return {
        physicalWidth: width * scaleFactor,
        physicalHeight: height * scaleFactor,
        scaleFactor,
        displays: [],
      };
    }
  } catch (err) {
    logger.warn(`[desktop] Could not detect screen info: ${err}`);
  }

  // Fallback: assume 1920x1080 non-Retina
  return { physicalWidth: 1920, physicalHeight: 1080, scaleFactor: 1, displays: [] };
}

// ============================================================================
// DISPLAY LAYOUT DESCRIPTION
// ============================================================================

/**
 * Build a human-readable display layout description for the model.
 * Returns empty string for single-display setups.
 */
export function buildDisplayLayout(displays: DisplayInfo[], capturedDisplay?: number): string {
  if (displays.length <= 1) return '';

  const descriptions = displays.map(d => {
    const flags = [
      d.isPrimary ? 'primary' : null,
      d.scaleFactor > 1 ? 'Retina' : null,
    ].filter(Boolean).join(', ');
    return `[${d.displayNumber}] ${d.name} (${flags ? flags + ', ' : ''}${d.physicalWidth}x${d.physicalHeight})`;
  });

  let layout = `Display layout: ${descriptions.join(' | ')}`;
  if (capturedDisplay) {
    layout += `\nCaptured: display ${capturedDisplay} only`;
  } else {
    layout += '\nCaptured: all displays (composite)';
  }
  return layout;
}

// ============================================================================
// SCREENSHOT CAPTURE
// ============================================================================

/**
 * Capture a screenshot of the macOS screen, resize for LLM consumption,
 * and return as base64 JPEG.
 *
 * @param displayNumber - If provided, capture only this display (1-based).
 *                        Omit to capture all screens as composite.
 */
export async function captureAndScaleScreenshot(
  screenInfo: ScreenInfo,
  maxLongEdge: number = DEFAULT_MAX_LONG_EDGE,
  displayNumber?: number,
): Promise<{ base64: string; scaledWidth: number; scaledHeight: number; dimensionsChanged: boolean }> {
  const tmpPath = join(tmpdir(), `ohwow-desktop-${Date.now()}.jpg`);

  try {
    // Validate display number if provided
    if (displayNumber !== undefined && screenInfo.displays.length > 0) {
      const validNums = screenInfo.displays.map(d => d.displayNumber);
      if (!validNums.includes(displayNumber)) {
        throw new Error(`Invalid display number: ${displayNumber}. Available: ${validNums.join(', ')}`);
      }
    }

    // On multi-monitor, default to primary display for better resolution
    const effectiveDisplay = displayNumber ?? (screenInfo.displays.length > 1 ? 1 : undefined);

    // Capture: specific display or primary
    const captureArgs = ['-x', '-t', 'jpg'];
    if (effectiveDisplay) {
      captureArgs.push('-D', String(effectiveDisplay));
    }
    captureArgs.push(tmpPath);
    execFileSync('screencapture', captureArgs, { timeout: 10000 });

    const rawBuffer = readFileSync(tmpPath);

    // Get actual captured dimensions (may differ from estimates)
    const sharp = await loadSharp();
    const metadata = await sharp(rawBuffer).metadata();
    const capturedWidth = metadata.width ?? screenInfo.physicalWidth;
    const capturedHeight = metadata.height ?? screenInfo.physicalHeight;

    // Detect if composite dimensions changed (hot-plug indicator)
    let dimensionsChanged = false;
    if (!displayNumber) {
      dimensionsChanged = capturedWidth !== screenInfo.physicalWidth ||
                          capturedHeight !== screenInfo.physicalHeight;
      // Update composite dimensions
      screenInfo.physicalWidth = capturedWidth;
      screenInfo.physicalHeight = capturedHeight;
    }

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

    return { base64, scaledWidth, scaledHeight, dimensionsChanged };
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
 * Used for composite (all displays) captures.
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

/**
 * Scale coordinates from a single-display screenshot to macOS global coordinates.
 * Maps scaled coords to the display's physical space, then adds the display's origin.
 */
export function scaleToPhysicalForDisplay(
  x: number,
  y: number,
  scaledWidth: number,
  scaledHeight: number,
  display: DisplayInfo,
): { x: number; y: number } {
  const scaleX = display.physicalWidth / scaledWidth;
  const scaleY = display.physicalHeight / scaledHeight;
  // Map to display-local physical coords, then translate to global logical coords.
  // nut.js uses logical (point) coordinates on macOS.
  return {
    x: Math.round(display.originX + (x * scaleX) / display.scaleFactor),
    y: Math.round(display.originY + (y * scaleY) / display.scaleFactor),
  };
}

// ============================================================================
// SCREENSHOT NOTIFICATION
// ============================================================================

/**
 * Show a brief macOS notification that a screenshot was captured.
 * Non-blocking: fires and forgets so it doesn't slow down the action loop.
 */
export function notifyScreenshotCaptured(): void {
  if (process.platform !== 'darwin') return;
  try {
    const { spawn } = require('child_process');
    const child = spawn('osascript', [
      '-e',
      'display notification "Desktop screenshot captured by agent" with title "ohwow"',
    ], { stdio: 'ignore', detached: true });
    child.unref();
  } catch { /* non-fatal */ }
}
