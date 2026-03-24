/**
 * Desktop Control Types
 * Action types for local macOS desktop automation via mouse, keyboard, and screen capture.
 * Matches Claude's computer_use tool action contract.
 */

// ============================================================================
// ACTION TYPES
// ============================================================================

export type DesktopActionType =
  | 'screenshot'
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'triple_click'
  | 'type_text'
  | 'key'
  | 'scroll'
  | 'mouse_move'
  | 'wait'
  | 'left_click_drag';

// ============================================================================
// DESKTOP ACTIONS (tool inputs for the LLM)
// ============================================================================

export interface DesktopScreenshotAction { type: 'screenshot' }
export interface DesktopLeftClickAction { type: 'left_click'; x: number; y: number }
export interface DesktopRightClickAction { type: 'right_click'; x: number; y: number }
export interface DesktopDoubleClickAction { type: 'double_click'; x: number; y: number }
export interface DesktopTripleClickAction { type: 'triple_click'; x: number; y: number }
export interface DesktopTypeTextAction { type: 'type_text'; text: string }
export interface DesktopKeyAction { type: 'key'; key: string }
export interface DesktopScrollAction { type: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
export interface DesktopMouseMoveAction { type: 'mouse_move'; x: number; y: number }
export interface DesktopWaitAction { type: 'wait'; duration: number }
export interface DesktopLeftClickDragAction { type: 'left_click_drag'; startX: number; startY: number; endX: number; endY: number }

export type DesktopAction =
  | DesktopScreenshotAction
  | DesktopLeftClickAction
  | DesktopRightClickAction
  | DesktopDoubleClickAction
  | DesktopTripleClickAction
  | DesktopTypeTextAction
  | DesktopKeyAction
  | DesktopScrollAction
  | DesktopMouseMoveAction
  | DesktopWaitAction
  | DesktopLeftClickDragAction;

// ============================================================================
// ACTION RESULTS
// ============================================================================

export interface DesktopActionResult {
  success: boolean;
  type: DesktopActionType;
  /** Base64 JPEG screenshot (auto-captured after mutation actions) */
  screenshot?: string;
  /** Dimensions of the screenshot sent to the LLM (scaled) */
  scaledWidth?: number;
  scaledHeight?: number;
  error?: string;
  /** Name of the frontmost macOS application when the action was executed */
  frontmostApp?: string;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface DesktopServiceOptions {
  /** Max pixels on longest edge for LLM screenshots (default: 1280) */
  maxLongEdge?: number;
  /** Delay (ms) after mutation actions before auto-screenshot (default: 500) */
  postActionDelay?: number;
  /** Max actions per second — throttle (default: 2) */
  maxActionsPerSecond?: number;
  /** Data directory for saving screenshots */
  dataDir?: string;
  /** Restrict desktop interactions to these apps only (empty = blocklist mode) */
  allowedApps?: string[];
  /** Show macOS notification on each screenshot capture (default: true) */
  notifyOnScreenshot?: boolean;
  /** Callback for approval flow — return true to allow, false to deny */
  approvalCallback?: (action: DesktopAction, context: string) => Promise<boolean>;
  /** Agent's autonomy level (1-5) for approval decisions */
  autonomyLevel?: number;
}

// ============================================================================
// SCREEN INFO
// ============================================================================

export interface ScreenInfo {
  /** Physical pixel width of the display */
  physicalWidth: number;
  /** Physical pixel height of the display */
  physicalHeight: number;
  /** Retina scale factor (e.g. 2.0 on Retina, 1.0 on non-Retina) */
  scaleFactor: number;
}
