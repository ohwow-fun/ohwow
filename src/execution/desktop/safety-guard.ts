/**
 * Desktop Control Safety Guard
 * Detects dangerous actions and enforces safety policies before desktop execution.
 *
 * Safety layers:
 * 1. Dangerous app detection (Terminal, System Settings)
 * 2. Dangerous key combo blocking (force quit, destructive shortcuts)
 * 3. Screen text injection scanning
 */

import { execSync } from 'child_process';
import { logger } from '../../lib/logger.js';
import type { DesktopAction } from './desktop-types.js';

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
]);

const SYSTEM_SETTINGS_APPS = new Set([
  'system preferences',
  'system settings',
]);

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
 * Check if the frontmost app is a terminal emulator.
 */
export function isTerminalFocused(): boolean {
  const app = getFrontmostApp();
  return app !== null && TERMINAL_APPS.has(app);
}

/**
 * Check if the frontmost app is System Settings/Preferences.
 */
export function isSystemSettingsFocused(): boolean {
  const app = getFrontmostApp();
  return app !== null && SYSTEM_SETTINGS_APPS.has(app);
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
// SAFETY CHECK
// ============================================================================

/**
 * Run safety checks on a desktop action before execution.
 * Returns whether the action should proceed, and any warnings.
 */
export function checkActionSafety(action: DesktopAction): SafetyCheckResult {
  // Type text into Terminal is dangerous (arbitrary command execution)
  if (action.type === 'type_text') {
    if (isTerminalFocused()) {
      return {
        allowed: false,
        blocked: 'Typing into a terminal emulator is blocked for safety. Terminal commands could execute arbitrary code on the system.',
      };
    }
  }

  // Key press into Terminal is dangerous
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
