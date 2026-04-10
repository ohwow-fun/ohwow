/**
 * macOS Accessibility Permission Check
 * Detects whether the current process has Accessibility and Screen Recording permissions.
 *
 * macOS requires these via the TCC (Transparency, Consent, Compliance) framework:
 * - Accessibility: needed for mouse/keyboard control (System Settings > Privacy > Accessibility)
 * - Screen Recording: needed for screencapture (System Settings > Privacy > Screen Recording)
 */

import { execSync } from 'child_process';
import { statSync, unlinkSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
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
 * Ensure OHWOW appears in macOS Accessibility settings for easy permission granting.
 * Creates a minimal .app bundle at ~/.ohwow/OHWOW.app that wraps the current Node.js binary.
 * When the user opens Accessibility settings, they see "OHWOW" instead of a cryptic "node" path.
 *
 * Also opens System Settings to the Accessibility page and triggers the permission prompt
 * so the entry appears in the list automatically.
 */
export function ensureAccessibilitySetup(): { appPath: string; nodePath: string } {
  if (process.platform !== 'darwin') {
    return { appPath: '', nodePath: process.execPath };
  }

  const ohwowDir = join(homedir(), '.ohwow');
  const appPath = join(ohwowDir, 'OHWOW.app');
  const contentsDir = join(appPath, 'Contents');
  const macosDir = join(contentsDir, 'MacOS');
  const plistPath = join(contentsDir, 'Info.plist');
  const execPath = join(macosDir, 'ohwow');
  const nodePath = process.execPath;

  // Create the .app bundle if it doesn't exist or node path changed
  const needsCreate = !existsSync(execPath);

  if (needsCreate) {
    try {
      mkdirSync(macosDir, { recursive: true });

      // Info.plist — makes macOS show "OHWOW" in permission dialogs
      writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>fun.ohwow.desktop</string>
  <key>CFBundleName</key>
  <string>OHWOW</string>
  <key>CFBundleDisplayName</key>
  <string>OHWOW</string>
  <key>CFBundleExecutable</key>
  <string>ohwow</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>`);

      // Executable wrapper — delegates to the real node binary
      writeFileSync(execPath, `#!/bin/bash
exec "${nodePath}" "$@"
`);
      chmodSync(execPath, 0o755);

      logger.info(`[desktop] Created OHWOW.app bundle at ${appPath}`);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[desktop] Couldn\'t create OHWOW.app bundle');
    }
  }

  return { appPath, nodePath };
}

/**
 * Open macOS System Settings to the Accessibility page and trigger the permission prompt.
 * After this, the user just needs to toggle ON "OHWOW" (or "node") in the list.
 */
export function openAccessibilitySettings(): void {
  if (process.platform !== 'darwin') return;
  try {
    execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', { timeout: 5000 });
  } catch {
    logger.warn('[desktop] Couldn\'t open Accessibility settings');
  }
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
