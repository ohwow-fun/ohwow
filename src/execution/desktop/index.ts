/**
 * Desktop Control — barrel exports
 */

export type {
  DesktopActionType,
  DesktopAction,
  DesktopActionResult,
  DesktopServiceOptions,
  ScreenInfo,
} from './desktop-types.js';

export { LocalDesktopService } from './local-desktop.service.js';
export type { DesktopActionCallback } from './local-desktop.service.js';

export {
  REQUEST_DESKTOP_TOOL,
  DESKTOP_TOOL_DEFINITIONS,
  DESKTOP_ACTIVATION_MESSAGE,
  DESKTOP_SYSTEM_PROMPT,
  isDesktopTool,
  executeDesktopTool,
  formatDesktopToolResult,
} from './desktop-tools.js';

export { checkDesktopPermissions } from './accessibility-check.js';

export { desktopLock } from './desktop-lock.js';
export type { DesktopLockHolder } from './desktop-lock.js';

export {
  checkActionSafety,
  logSafetyEvent,
  getFrontmostApp,
  isLikelyTerminal,
  isSensitiveAppFocused,
  classifyActionRisk,
} from './safety-guard.js';
export type { SafetyCheckResult, DesktopActionRisk } from './safety-guard.js';

export {
  detectScreenInfo,
  captureAndScaleScreenshot,
  scaleToPhysical,
  calculateScaledDimensions,
  notifyScreenshotCaptured,
} from './screenshot-capture.js';
