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

import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../lib/logger.js';
import { checkDesktopPermissions } from './accessibility-check.js';
import {
  detectScreenInfo,
  captureAndScaleScreenshot,
  scaleToPhysical,
  notifyScreenshotCaptured,
} from './screenshot-capture.js';
import { checkActionSafety, logSafetyEvent, getFrontmostApp } from './safety-guard.js';
import { desktopLock } from './desktop-lock.js';
import type {
  DesktopAction,
  DesktopActionResult,
  DesktopActionType,
  DesktopServiceOptions,
  ScreenInfo,
} from './desktop-types.js';

// ============================================================================
// KILL FILE PATH — touch this file to trigger emergency stop
// ============================================================================

const OHWOW_DIR = join(homedir(), '.ohwow');
const KILL_FILE = join(OHWOW_DIR, 'desktop-kill');
const PID_FILE = join(OHWOW_DIR, 'desktop-control.pid');

// ============================================================================
// ACTION HELPERS
// ============================================================================

/** Actions that mutate the desktop (vs read-only screenshot/wait/mouse_move) */
function isMutationAction(type: DesktopActionType): boolean {
  return type !== 'screenshot' && type !== 'wait' && type !== 'mouse_move';
}

/** Human-readable description of a desktop action for approval prompts */
function describeAction(action: DesktopAction, appName: string | null): string {
  const inApp = appName ? ` in ${appName}` : '';
  switch (action.type) {
    case 'left_click': return `Click at (${action.x}, ${action.y})${inApp}`;
    case 'right_click': return `Right-click at (${action.x}, ${action.y})${inApp}`;
    case 'double_click': return `Double-click at (${action.x}, ${action.y})${inApp}`;
    case 'triple_click': return `Triple-click at (${action.x}, ${action.y})${inApp}`;
    case 'type_text': return `Type "${action.text.slice(0, 50)}${action.text.length > 50 ? '...' : ''}"${inApp}`;
    case 'key': return `Press ${action.key}${inApp}`;
    case 'scroll': return `Scroll ${action.direction} at (${action.x}, ${action.y})${inApp}`;
    case 'left_click_drag': return `Drag from (${action.startX}, ${action.startY}) to (${action.endX}, ${action.endY})${inApp}`;
    default: return `${action.type}${inApp}`;
  }
}

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

/** Callback invoked after every desktop action for audit logging */
export type DesktopActionCallback = (
  action: DesktopAction,
  result: DesktopActionResult,
) => void;

export class LocalDesktopService {
  private ready = false;
  private stopped = false;
  private screenInfo: ScreenInfo = { physicalWidth: 1920, physicalHeight: 1080, scaleFactor: 1 };
  private lastScaledWidth = 0;
  private lastScaledHeight = 0;
  private lastActionTime = 0;
  private killCheckInterval: ReturnType<typeof setInterval> | null = null;

  private maxLongEdge: number;
  private postActionDelay: number;
  private minActionInterval: number;
  private dataDir: string | undefined;
  private allowedApps: string[];
  private notifyOnScreenshot: boolean;
  private approvalCallback?: (action: DesktopAction, context: string) => Promise<boolean>;
  private autonomyLevel: number;

  /** Subscribe to action events for audit logging */
  onAction: DesktopActionCallback | null = null;

  constructor(opts?: DesktopServiceOptions) {
    this.maxLongEdge = opts?.maxLongEdge ?? 1280;
    this.postActionDelay = opts?.postActionDelay ?? 500;
    this.minActionInterval = 1000 / (opts?.maxActionsPerSecond ?? 2);
    this.dataDir = opts?.dataDir;
    this.allowedApps = (opts?.allowedApps ?? []).map(a => a.toLowerCase());
    this.notifyOnScreenshot = opts?.notifyOnScreenshot ?? true;
    this.approvalCallback = opts?.approvalCallback;
    this.autonomyLevel = opts?.autonomyLevel ?? 5;
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
    this.startKillFileWatcher();
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

      // Capture frontmost app for audit trail and safety checks
      const currentApp = getFrontmostApp();

      // App allowlist check (if configured)
      if (this.allowedApps.length > 0 && action.type !== 'screenshot' && action.type !== 'wait') {
        if (currentApp && !this.allowedApps.includes(currentApp)) {
          const result: DesktopActionResult = {
            success: false,
            type: action.type,
            frontmostApp: currentApp ?? undefined,
            error: `Action blocked: "${currentApp}" is not in the allowed apps list. Allowed: ${this.allowedApps.join(', ')}.`,
          };
          this.onAction?.(action, result);
          return result;
        }
      }

      // Safety check before executing
      const safety = checkActionSafety(action);
      logSafetyEvent(action, safety);
      if (!safety.allowed) {
        const result: DesktopActionResult = {
          success: false,
          type: action.type,
          frontmostApp: currentApp ?? undefined,
          error: safety.blocked ?? 'Action blocked by safety guard.',
        };
        this.onAction?.(action, result);
        return result;
      }

      // Autonomy/approval check for mutation actions
      if (this.approvalCallback && this.autonomyLevel <= 2 && isMutationAction(action.type)) {
        const description = describeAction(action, currentApp);
        const approved = await this.approvalCallback(action, description);
        if (!approved) {
          const result: DesktopActionResult = {
            success: false,
            type: action.type,
            frontmostApp: currentApp ?? undefined,
            error: 'Action denied by approval policy.',
          };
          this.onAction?.(action, result);
          return result;
        }
      }

      const nut = await loadNutJs();
      const { mouse, keyboard, Key, Button, Point } = nut;

      let result: DesktopActionResult;

      switch (action.type) {
        case 'screenshot': {
          result = await this.takeScreenshot();
          break;
        }

        case 'left_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          await mouse.click(Button.LEFT);
          result = await this.mutationResult('left_click');
          break;
        }

        case 'right_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          await mouse.click(Button.RIGHT);
          result = await this.mutationResult('right_click');
          break;
        }

        case 'double_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          await mouse.doubleClick(Button.LEFT);
          result = await this.mutationResult('double_click');
          break;
        }

        case 'triple_click': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          // nut.js doesn't have tripleClick; simulate with 3 rapid clicks
          await mouse.click(Button.LEFT);
          await mouse.click(Button.LEFT);
          await mouse.click(Button.LEFT);
          result = await this.mutationResult('triple_click');
          break;
        }

        case 'type_text': {
          await keyboard.type(action.text);
          result = await this.mutationResult('type_text');
          break;
        }

        case 'key': {
          const keys = parseKeyCombo(action.key, Key);
          await keyboard.pressKey(...keys);
          await keyboard.releaseKey(...keys);
          result = await this.mutationResult('key');
          break;
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
          result = await this.mutationResult('scroll');
          break;
        }

        case 'mouse_move': {
          const physical = this.scaleCoords(action.x, action.y);
          await mouse.setPosition(new Point(physical.x, physical.y));
          result = { success: true, type: 'mouse_move' };
          break;
        }

        case 'wait': {
          await new Promise(resolve => setTimeout(resolve, action.duration));
          result = { success: true, type: 'wait' };
          break;
        }

        case 'left_click_drag': {
          const start = this.scaleCoords(action.startX, action.startY);
          const end = this.scaleCoords(action.endX, action.endY);
          // Use explicit press-move-release instead of mouse.drag() which is
          // unreliable for window dragging on macOS (moves too fast for the
          // window manager to register the drag).
          await mouse.setPosition(new Point(start.x, start.y));
          await mouse.pressButton(Button.LEFT);
          await new Promise(resolve => setTimeout(resolve, 100));
          await mouse.move([new Point(start.x, start.y), new Point(end.x, end.y)]);
          await new Promise(resolve => setTimeout(resolve, 50));
          await mouse.releaseButton(Button.LEFT);
          result = await this.mutationResult('left_click_drag');
          break;
        }

        default: {
          const unknownType = (action as { type: string }).type;
          result = { success: false, type: 'screenshot', error: `Unknown desktop action: ${unknownType}` };
        }
      }

      // Attach frontmost app to all results for audit
      result.frontmostApp = currentApp ?? undefined;

      // Emit action callback for audit logging
      this.onAction?.(action, result);

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown desktop error';
      logger.error(`[desktop] Action ${action.type} failed: ${errorMessage}`);
      const errorResult: DesktopActionResult = { success: false, type: action.type, error: errorMessage };
      this.onAction?.(action, errorResult);
      return errorResult;
    }
  }

  // ==========================================================================
  // EMERGENCY STOP
  // ==========================================================================

  async emergencyStop(): Promise<void> {
    this.stopped = true;
    this.stopKillFileWatcher();
    desktopLock.forceRelease();
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
    this.stopKillFileWatcher();
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

    if (this.notifyOnScreenshot) notifyScreenshotCaptured();

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
   * Start polling for the kill file (~/.ohwow/desktop-kill).
   * If the file appears, trigger emergency stop immediately.
   * Also writes a PID file so external tools can identify the process.
   */
  private startKillFileWatcher(): void {
    try {
      mkdirSync(OHWOW_DIR, { recursive: true });
      writeFileSync(PID_FILE, String(process.pid));

      // Clean up any stale kill file from a previous session
      try { unlinkSync(KILL_FILE); } catch { /* ignore */ }
    } catch (err) {
      logger.warn(`[desktop] Could not write PID file: ${err}`);
    }

    this.killCheckInterval = setInterval(() => {
      if (existsSync(KILL_FILE)) {
        try { unlinkSync(KILL_FILE); } catch { /* ignore */ }
        logger.warn('[desktop] Kill file detected, triggering emergency stop');
        void this.emergencyStop();
      }
    }, 500);
  }

  /**
   * Stop the kill file watcher and clean up PID file.
   */
  private stopKillFileWatcher(): void {
    if (this.killCheckInterval) {
      clearInterval(this.killCheckInterval);
      this.killCheckInterval = null;
    }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
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
