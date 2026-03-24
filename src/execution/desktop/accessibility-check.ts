/**
 * macOS Accessibility Permission Check
 * Detects whether the current process has Accessibility and Screen Recording permissions.
 *
 * macOS requires these via the TCC (Transparency, Consent, Compliance) framework:
 * - Accessibility: needed for mouse/keyboard control (System Settings > Privacy > Accessibility)
 * - Screen Recording: needed for screencapture (System Settings > Privacy > Screen Recording)
 */

import { execSync } from 'child_process';
import { statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../lib/logger.js';

export interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  message?: string;
}

/**
 * Check macOS permissions required for desktop control.
 * Uses practical detection: attempts the actual operations and checks for failure.
 */
export function checkDesktopPermissions(): PermissionStatus {
  if (process.platform !== 'darwin') {
    return {
      accessibility: false,
      screenRecording: false,
      message: 'Desktop control is only supported on macOS.',
    };
  }

  const accessibility = checkAccessibilityPermission();
  const screenRecording = checkScreenRecordingPermission();

  const missing: string[] = [];
  if (!accessibility) missing.push('Accessibility');
  if (!screenRecording) missing.push('Screen Recording');

  const message = missing.length > 0
    ? `Missing permissions: ${missing.join(', ')}. Open System Settings > Privacy & Security > ${missing[0]} and add your terminal app.`
    : undefined;

  return { accessibility, screenRecording, message };
}

/**
 * Check Accessibility permission by attempting to query UI elements via AppleScript.
 * If the process lacks Accessibility permission, this will fail.
 */
function checkAccessibilityPermission(): boolean {
  try {
    // This AppleScript query requires Accessibility permission
    execSync(
      'osascript -e \'tell application "System Events" to get name of first process whose frontmost is true\' 2>/dev/null',
      { timeout: 5000, encoding: 'utf-8' },
    );
    return true;
  } catch {
    logger.debug('[desktop] Accessibility permission check failed');
    return false;
  }
}

/**
 * Check Screen Recording permission by attempting a screencapture.
 * On macOS 10.15+, screencapture without Screen Recording permission produces a blank image.
 * We capture a tiny region and check if the result is suspiciously small (blank).
 */
function checkScreenRecordingPermission(): boolean {
  const tmpFile = join(tmpdir(), `ohwow-permcheck-${process.pid}.png`);
  try {
    execSync(
      `screencapture -x -t png -R 0,0,1,1 ${tmpFile} 2>/dev/null`,
      { timeout: 5000, encoding: 'utf-8' },
    );
    const { size } = statSync(tmpFile);
    // A valid 1x1 PNG screenshot is typically > 100 bytes
    // A blank/permission-denied result is very small or 0
    return size > 50;
  } catch {
    logger.debug('[desktop] Screen Recording permission check failed');
    return false;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
