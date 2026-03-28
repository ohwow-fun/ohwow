/**
 * Desktop Control Safety Guard
 * Detects dangerous actions and enforces safety policies before desktop execution.
 *
 * Safety layers:
 * 1. Dynamic terminal detection (exact match + heuristic bundle ID check)
 * 2. Sensitive application detection (password managers, banking, security)
 * 3. Dangerous key combo blocking (force quit, destructive shortcuts)
 * 4. System Settings warning
 * 5. Action risk classification for autonomy integration
 */

import { execSync } from 'child_process';
import { logger } from '../../lib/logger.js';
import type { DesktopAction, DesktopActionType } from './desktop-types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SafetyCheckResult {
  allowed: boolean;
  /** Warning message if action is risky but allowed */
  warning?: string;
  /** Block message if action is denied */
  blocked?: string;
}

/** Risk level for a desktop action — used by the autonomy/approval system */
export type DesktopActionRisk = 'low' | 'medium' | 'high';

// ============================================================================
// DANGEROUS APP DETECTION
// ============================================================================

const TERMINAL_APPS = new Set([
  'terminal',
  'iterm2',
  'iterm',
  'warp',
  'alacritty',
  'kitty',
  'hyper',
  'tabby',
  'rio',
  'ghostty',
  'wave',
  'contour',
  'foot',
  'st',
]);

const SYSTEM_SETTINGS_APPS = new Set([
  'system preferences',
  'system settings',
]);

/** Keywords in bundle IDs that indicate a terminal-like app */
const TERMINAL_BUNDLE_KEYWORDS = ['terminal', 'console', 'shell', 'term', 'ssh', 'iterm'];

/** Sensitive apps: password managers, banking, security tools */
const SENSITIVE_APP_PATTERNS = new Set([
  '1password',
  'bitwarden',
  'lastpass',
  'keepass',
  'keepassxc',
  'keychain access',
  'enpass',
  'dashlane',
  'nordpass',
  'roboform',
]);

/** Cached results of dynamic terminal detection to avoid repeated AppleScript calls */
const terminalDetectionCache = new Map<string, boolean>();

/**
 * Get the name of the currently focused (frontmost) macOS application.
 * Returns lowercase app name, or null if detection fails.
 */
export function getFrontmostApp(): string | null {
  if (process.platform !== 'darwin') return null;

  try {
    const result = execSync(
      'osascript -e \'tell application "System Events" to get name of first process whose frontmost is true\' 2>/dev/null',
      { encoding: 'utf-8', timeout: 3000 },
    );
    return result.trim().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Dynamically detect if an app is likely a terminal emulator.
 * First checks the exact-match set, then falls back to bundle ID heuristic.
 * Results are cached per app name for the session.
 */
export function isLikelyTerminal(appName: string): boolean {
  if (TERMINAL_APPS.has(appName)) return true;

  // Check cache
  const cached = terminalDetectionCache.get(appName);
  if (cached !== undefined) return cached;

  // Heuristic: query the bundle ID of the process
  let isTerminal = false;
  try {
    const bundleId = execSync(
      `osascript -e 'tell application "System Events" to get bundle identifier of first process whose name is "${appName.replace(/"/g, '\\"')}"' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 2000 },
    ).trim().toLowerCase();

    isTerminal = TERMINAL_BUNDLE_KEYWORDS.some(kw => bundleId.includes(kw));
  } catch {
    // Can't determine — assume not a terminal
  }

  terminalDetectionCache.set(appName, isTerminal);
  return isTerminal;
}

/**
 * Check if the frontmost app is a terminal emulator.
 * Uses dynamic detection (exact match + bundle ID heuristic).
 */
export function isTerminalFocused(): boolean {
  const app = getFrontmostApp();
  return app !== null && isLikelyTerminal(app);
}

/**
 * Check if the frontmost app is System Settings/Preferences.
 */
export function isSystemSettingsFocused(): boolean {
  const app = getFrontmostApp();
  return app !== null && SYSTEM_SETTINGS_APPS.has(app);
}

/**
 * Check if the frontmost app is a sensitive application (password managers, etc.).
 * Returns the app name if sensitive, null otherwise.
 */
export function isSensitiveAppFocused(): string | null {
  const app = getFrontmostApp();
  if (!app) return null;
  if (SENSITIVE_APP_PATTERNS.has(app)) return app;
  // Partial match for apps with version numbers etc.
  for (const pattern of SENSITIVE_APP_PATTERNS) {
    if (app.includes(pattern)) return app;
  }
  return null;
}

// ============================================================================
// DANGEROUS KEY COMBOS
// ============================================================================

/** Key combos that should be blocked without explicit approval */
const BLOCKED_KEY_COMBOS = new Set([
  'cmd+option+escape',    // Force Quit
  'cmd+option+esc',       // Force Quit (alt spelling)
  'cmd+shift+delete',     // Empty Trash
  'cmd+shift+backspace',  // Empty Trash (alt)
]);

/** Key combos that trigger a warning but are allowed */
const WARNING_KEY_COMBOS = new Set([
  'cmd+q',                // Quit app
  'cmd+shift+q',          // Log out
  'cmd+option+power',     // Sleep
]);

// ============================================================================
// RISK CLASSIFICATION
// ============================================================================

/**
 * Classify the risk level of a desktop action.
 * Used by the autonomy/approval system to decide whether to request confirmation.
 *
 * - low: read-only actions (screenshot, wait, mouse_move)
 * - medium: clicks, scrolls, drags (visual navigation)
 * - high: text input, keyboard shortcuts (can execute commands, modify data)
 */
export function classifyActionRisk(action: DesktopAction): DesktopActionRisk {
  switch (action.type) {
    case 'screenshot':
    case 'wait':
    case 'mouse_move':
      return 'low';

    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click':
    case 'scroll':
    case 'left_click_drag':
      return 'medium';

    case 'type_text':
    case 'typewrite':
    case 'key':
      return 'high';

    default:
      return 'medium';
  }
}

// ============================================================================
// SAFETY CHECK
// ============================================================================

/**
 * Run safety checks on a desktop action before execution.
 * Returns whether the action should proceed, and any warnings.
 */
export function checkActionSafety(action: DesktopAction): SafetyCheckResult {
  // Type text into Terminal is dangerous (arbitrary command execution)
  if (action.type === 'type_text' || action.type === 'typewrite') {
    if (isTerminalFocused()) {
      return {
        allowed: false,
        blocked: 'Typing into a terminal emulator is blocked for safety. Terminal commands could execute arbitrary code on the system.',
      };
    }
  }

  // Key press checks
  if (action.type === 'key') {
    // Check blocked combos
    const normalizedKey = action.key.toLowerCase().split('+').sort().join('+');
    for (const blocked of BLOCKED_KEY_COMBOS) {
      const normalizedBlocked = blocked.split('+').sort().join('+');
      if (normalizedKey === normalizedBlocked) {
        return {
          allowed: false,
          blocked: `Key combo "${action.key}" is blocked for safety (${getBlockedReason(blocked)}).`,
        };
      }
    }

    // Check warning combos
    for (const warned of WARNING_KEY_COMBOS) {
      const normalizedWarned = warned.split('+').sort().join('+');
      if (normalizedKey === normalizedWarned) {
        return {
          allowed: true,
          warning: `Key combo "${action.key}" may have significant effects (${getWarningReason(warned)}).`,
        };
      }
    }

    // Typing enter in Terminal could execute a command
    if (action.key.toLowerCase() === 'enter' || action.key.toLowerCase() === 'return') {
      if (isTerminalFocused()) {
        return {
          allowed: false,
          blocked: 'Pressing Enter in a terminal is blocked for safety. This could execute a pending command.',
        };
      }
    }
  }

  // Clicking in System Settings could change system configuration
  if (action.type === 'left_click' || action.type === 'double_click') {
    if (isSystemSettingsFocused()) {
      return {
        allowed: true,
        warning: 'Clicking in System Settings. Be cautious about changing system configuration.',
      };
    }
  }

  // Sensitive application warning (password managers, etc.)
  if (action.type !== 'screenshot' && action.type !== 'wait') {
    const sensitiveApp = isSensitiveAppFocused();
    if (sensitiveApp) {
      return {
        allowed: true,
        warning: `Sensitive application detected (${sensitiveApp}). Proceeding with caution. Avoid interacting with credential fields.`,
      };
    }
  }

  return { allowed: true };
}

// ============================================================================
// HELPERS
// ============================================================================

function getBlockedReason(combo: string): string {
  const reasons: Record<string, string> = {
    'cmd+option+escape': 'Force Quit dialog',
    'cmd+option+esc': 'Force Quit dialog',
    'cmd+shift+delete': 'Empty Trash',
    'cmd+shift+backspace': 'Empty Trash',
  };
  return reasons[combo] ?? 'destructive action';
}

function getWarningReason(combo: string): string {
  const reasons: Record<string, string> = {
    'cmd+q': 'Quit current application',
    'cmd+shift+q': 'Log out of macOS',
    'cmd+option+power': 'Put Mac to sleep',
  };
  return reasons[combo] ?? 'potentially disruptive';
}

/**
 * Log a safety event for auditing.
 */
export function logSafetyEvent(
  action: DesktopAction,
  result: SafetyCheckResult,
): void {
  if (result.blocked) {
    logger.warn({ actionType: action.type, blocked: result.blocked }, '[desktop-safety] Action blocked');
  } else if (result.warning) {
    logger.info({ actionType: action.type, warning: result.warning }, '[desktop-safety] Action warning');
  }
}
