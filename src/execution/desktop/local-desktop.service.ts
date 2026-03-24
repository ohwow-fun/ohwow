/**
 * Local Desktop Service
 * Controls the macOS desktop: mouse, keyboard, screen capture.
 * Architecture mirrors LocalBrowserService (lazy init, action dispatch, cleanup).
 *
 * Uses:
 * - @nut-tree-fork/nut-js for mouse/keyboard input
 * - macOS `screencapture` CLI for screen capture
 * - `sharp` for Retina-aware image scaling
 */

import { logger } from '../../lib/logger.js';
import { checkDesktopPermissions } from './accessibility-check.js';
import {
  detectScreenInfo,
  captureAndScaleScreenshot,
  scaleToPhysical,
} from './screenshot-capture.js';
import { checkActionSafety, logSafetyEvent } from './safety-guard.js';
import type {
  DesktopAction,
  DesktopActionResult,
  DesktopServiceOptions,
  ScreenInfo,
} from './desktop-types.js';

// ============================================================================
// KEY MAPPING
// ============================================================================

/**
 * Map human-readable key names to nut.js Key enum values.
 * Lazily loaded because nut.js import is heavy.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nutJs: any = null;

async function loadNutJs(): Promise<typeof import('@nut-tree-fork/nut-js')> {
  if (!nutJs) {
    try {
      nutJs = await import('@nut-tree-fork/nut-js');
    } catch {
      throw new Error(
        'Desktop control requires @nut-tree-fork/nut-js. Install it with: npm install @nut-tree-fork/nut-js',
      );
    }
  }
  return nutJs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveKey(keyName: string, Key: any): number {
  const keyMap: Record<string, string> = {
    // Modifiers
    cmd: 'LeftCmd', command: 'LeftCmd', meta: 'LeftCmd',
    ctrl: 'LeftControl', control: 'LeftControl',
    alt: 'LeftAlt', option: 'LeftAlt',
    shift: 'LeftShift',
    // Common keys
    enter: 'Enter', return: 'Enter',
    tab: 'Tab',
    escape: 'Escape', esc: 'Escape',
    space: 'Space',
    backspace: 'Backspace', delete: 'Delete',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    home: 'Home', end: 'End',
    pageup: 'PageUp', pagedown: 'PageDown',
    // Function keys
    f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
    f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
  };

  const mapped = keyMap[keyName.toLowerCase()];
  if (mapped && Key[mapped] !== undefined) return Key[mapped];

  // Try direct match (e.g. "A", "1", etc.)
  if (Key[keyName.toUpperCase()] !== undefined) return Key[keyName.toUpperCase()];
  if (Key[keyName] !== undefined) return Key[keyName];

  // Single character: use the character directly
  if (keyName.length === 1) {
    const upper = keyName.toUpperCase();
    if (Key[upper] !== undefined) return Key[upper];
  }

  throw new Error(`Unknown key: "${keyName}"`);
}

/**
 * Parse a key combo string like "cmd+c" or "cmd+shift+s" into nut.js Key values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseKeyCombo(combo: string, Key: any): number[] {
  return combo.split('+').map(part => resolveKey(part.trim(), Key));
}

// ============================================================================
// LOCAL DESKTOP SERVICE
// ============================================================================

export class LocalDesktopService {
  private ready = false;
  private stopped = false;
  private screenInfo: ScreenInfo = { physicalWidth: 1920, physicalHeight: 1080, scaleFactor: 1 };
  private lastScaledWidth = 0;
  private lastScaledHeight = 0;
  private lastActionTime = 0;

  private maxLongEdge: number;
  private postActionDelay: number;
  private minActionInterval: number;
  private dataDir: string | undefined;

  constructor(opts?: DesktopServiceOptions) {
    this.maxLongEdge = opts?.maxLongEdge ?? 1280;
    this.postActionDelay = opts?.postActionDelay ?? 500;
    this.minActionInterval = 1000 / (opts?.maxActionsPerSecond ?? 2);
    this.dataDir = opts?.dataDir;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async ensureReady(): Promise<void> {
    if (this.ready) return;

    // Check macOS permissions
    const perms = checkDesktopPermissions();
    if (!perms.accessibility || !perms.screenRecording) {
      throw new Error(
        perms.message ?? 'Desktop control requires Accessibility and Screen Recording permissions.',
      );
    }

    // Detect screen info
    this.screenInfo = detectScreenInfo();
    logger.info(
      `[desktop] Screen detected: ${this.screenInfo.physicalWidth}x${this.screenInfo.physicalHeight} (scale: ${this.screenInfo.scaleFactor})`,
    );

    // Pre-load nut.js
    const nut = await loadNutJs();
    // Configure mouse speed for precision
    nut.mouse.config.mouseSpeed = 1000;

    this.ready = true;
    logger.info('[desktop] Desktop control service initialized');
  }

  isActive(): boolean {
    return this.ready && !this.stopped;
  }

  // ==========================================================================
  // ACTION DISPATCH
  // ==========================================================================

  async executeAction(action: DesktopAction): Promise<DesktopActionResult> {
    if (this.stopped) {
      return { success: false, type: action.type, error: 'Desktop control has been stopped.' };
    }

    try {
      await this.ensureReady();
      await this.throttle();

      // Safety check before executing
      const safety = checkActionSafety(action);
      logSafetyEvent(action, safety);
      if (!safety.allowed) {
        return { success: false, type: action.type, error: safety.blocked ?? 'Action blocked by safety guard.' };
      }

      const nut = await loadNutJs();
      const { mouse, keyboard, Key, Button, Point } = nut;

      switch (action.type) {
        case 'screenshot': {
          return await this.takeScreenshot();
        }

        case 'left_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          await mouse.click(Button.LEFT);
          return await this.mutationResult('left_click');
        }

        case 'right_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          await mouse.click(Button.RIGHT);
          return await this.mutationResult('right_click');
        }

        case 'double_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          await mouse.doubleClick(Button.LEFT);
          return await this.mutationResult('double_click');
        }

        case 'triple_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          // nut.js doesn't have tripleClick; simulate with 3 rapid clicks
          await mouse.click(Button.LEFT);
          await mouse.click(Button.LEFT);
          await mouse.click(Button.LEFT);
          return await this.mutationResult('triple_click');
        }

        case 'type_text': {
          await keyboard.type(action.text);
          return await this.mutationResult('type_text');
        }

        case 'key': {
          const keys = parseKeyCombo(action.key, Key);
          await keyboard.pressKey(...keys);
          await keyboard.releaseKey(...keys);
          return await this.mutationResult('key');
        }

        case 'scroll': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          const scrollAmount = action.amount || 3;
          if (action.direction === 'down') {
            await mouse.scrollDown(scrollAmount);
          } else if (action.direction === 'up') {
            await mouse.scrollUp(scrollAmount);
          } else if (action.direction === 'left') {
            await mouse.scrollLeft(scrollAmount);
          } else {
            await mouse.scrollRight(scrollAmount);
          }
          return await this.mutationResult('scroll');
        }

        case 'mouse_move': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          return { success: true, type: 'mouse_move' };
        }

        case 'wait': {
          await new Promise(resolve => setTimeout(resolve, action.duration));
          return { success: true, type: 'wait' };
        }

        case 'left_click_drag': {
          const start = this.scaleCoords(action.startX, action.startY);
          const end = this.scaleCoords(action.endX, action.endY);
          await mouse.drag([new Point(start.x, start.y), new Point(end.x, end.y)]);
          return await this.mutationResult('left_click_drag');
        }

        default: {
          const unknownType = (action as { type: string }).type;
          return { success: false, type: 'screenshot', error: `Unknown desktop action: ${unknownType}` };
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown desktop error';
      logger.error(`[desktop] Action ${action.type} failed: ${errorMessage}`);
      return { success: false, type: action.type, error: errorMessage };
    }
  }

  // ==========================================================================
  // EMERGENCY STOP
  // ==========================================================================

  async emergencyStop(): Promise<void> {
    this.stopped = true;
    logger.warn('[desktop] Emergency stop triggered');

    try {
      const nut = await loadNutJs();
      const { mouse, keyboard, Point, Key } = nut;

      // Release common modifier keys
      try {
        await keyboard.releaseKey(Key.LeftCmd);
        await keyboard.releaseKey(Key.LeftControl);
        await keyboard.releaseKey(Key.LeftAlt);
        await keyboard.releaseKey(Key.LeftShift);
      } catch { /* best effort */ }

      // Move mouse to screen center
      const centerX = Math.round(this.screenInfo.physicalWidth / 2);
      const centerY = Math.round(this.screenInfo.physicalHeight / 2);
      await mouse.setPosition(new Point(centerX, centerY));
    } catch (err) {
      logger.error(`[desktop] Emergency stop cleanup error: ${err}`);
    }
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  close(): void {
    this.stopped = true;
    this.ready = false;
    logger.info('[desktop] Desktop control service closed');
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Take a screenshot and return as a result.
   */
  private async takeScreenshot(): Promise<DesktopActionResult> {
    const { base64, scaledWidth, scaledHeight } = await captureAndScaleScreenshot(
      this.screenInfo,
      this.maxLongEdge,
    );
    this.lastScaledWidth = scaledWidth;
    this.lastScaledHeight = scaledHeight;

    return {
      success: true,
      type: 'screenshot',
      screenshot: base64,
      scaledWidth,
      scaledHeight,
    };
  }

  /**
   * After a mutation action, wait briefly then auto-capture a screenshot.
   */
  private async mutationResult(
    type: DesktopActionResult['type'],
  ): Promise<DesktopActionResult> {
    // Wait for UI to settle
    await new Promise(resolve => setTimeout(resolve, this.postActionDelay));

    // Auto-capture screenshot for visual feedback
    const { base64, scaledWidth, scaledHeight } = await captureAndScaleScreenshot(
      this.screenInfo,
      this.maxLongEdge,
    );
    this.lastScaledWidth = scaledWidth;
    this.lastScaledHeight = scaledHeight;

    return {
      success: true,
      type,
      screenshot: base64,
      scaledWidth,
      scaledHeight,
    };
  }

  /**
   * Scale LLM coordinates to physical screen coordinates.
   */
  private scaleCoords(x: number, y: number): { x: number; y: number } {
    if (this.lastScaledWidth === 0 || this.lastScaledHeight === 0) {
      // No previous screenshot — assume 1:1 mapping
      return { x: Math.round(x), y: Math.round(y) };
    }
    return scaleToPhysical(
      x, y,
      this.lastScaledWidth, this.lastScaledHeight,
      this.screenInfo.physicalWidth, this.screenInfo.physicalHeight,
    );
  }

  /**
   * Token-bucket throttle: enforce minimum interval between actions.
   */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastActionTime;
    if (elapsed < this.minActionInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minActionInterval - elapsed));
    }
    this.lastActionTime = Date.now();
  }
}
