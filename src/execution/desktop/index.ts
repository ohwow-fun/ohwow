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

export { checkActionSafety, logSafetyEvent, getFrontmostApp } from './safety-guard.js';

export {
  detectScreenInfo,
  captureAndScaleScreenshot,
  scaleToPhysical,
  calculateScaledDimensions,
} from './screenshot-capture.js';
