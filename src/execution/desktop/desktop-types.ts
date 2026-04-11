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
  | 'typewrite'
  | 'key'
  | 'scroll'
  | 'mouse_move'
  | 'wait'
  | 'left_click_drag'
  | 'move_window'
  | 'focus_app'
  | 'focus_window'
  | 'list_windows';

// ============================================================================
// DESKTOP ACTIONS (tool inputs for the LLM)
// ============================================================================

export interface DesktopScreenshotAction { type: 'screenshot'; display?: number }
export interface DesktopLeftClickAction { type: 'left_click'; x: number; y: number }
export interface DesktopRightClickAction { type: 'right_click'; x: number; y: number }
export interface DesktopDoubleClickAction { type: 'double_click'; x: number; y: number }
export interface DesktopTripleClickAction { type: 'triple_click'; x: number; y: number }
export interface DesktopTypeTextAction { type: 'type_text'; text: string }
export interface DesktopTypewriteAction { type: 'typewrite'; text: string; delayMs?: number }
export interface DesktopKeyAction { type: 'key'; key: string }
export interface DesktopScrollAction { type: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
export interface DesktopMouseMoveAction { type: 'mouse_move'; x: number; y: number }
export interface DesktopWaitAction { type: 'wait'; duration: number }
export interface DesktopLeftClickDragAction { type: 'left_click_drag'; startX: number; startY: number; endX: number; endY: number }
export interface DesktopMoveWindowAction { type: 'move_window'; display: number }
export interface DesktopFocusAppAction { type: 'focus_app'; appName: string }
export interface DesktopFocusWindowAction { type: 'focus_window'; appName: string; titleContains?: string }
export interface DesktopListWindowsAction { type: 'list_windows' }

export type DesktopAction =
  | DesktopScreenshotAction
  | DesktopLeftClickAction
  | DesktopRightClickAction
  | DesktopDoubleClickAction
  | DesktopTripleClickAction
  | DesktopTypeTextAction
  | DesktopTypewriteAction
  | DesktopKeyAction
  | DesktopScrollAction
  | DesktopMouseMoveAction
  | DesktopWaitAction
  | DesktopLeftClickDragAction
  | DesktopMoveWindowAction
  | DesktopFocusAppAction
  | DesktopFocusWindowAction
  | DesktopListWindowsAction;

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
  /** Text content for non-visual results (e.g. window list) */
  content?: string;
  /** Name of the frontmost macOS application when the action was executed */
  frontmostApp?: string;
  /** Human-readable display layout description for multi-monitor setups */
  displayLayout?: string;
  /** Base64 JPEG screenshot captured before the action (for audit/debugging, not sent to LLM) */
  preActionScreenshot?: string;
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
  /** Capture a screenshot before mutation actions for before/after comparison (default: false) */
  enablePreActionScreenshots?: boolean;
  /** Record the desktop session as video via FFmpeg (default: false) */
  enableRecording?: boolean;
}

// ============================================================================
// SCREEN INFO
// ============================================================================

export interface DisplayInfo {
  /** Display index (1-based, matches screencapture -D numbering) */
  displayNumber: number;
  /** Human-readable name (e.g. "Built-in Retina Display", "DELL U2723QE") */
  name: string;
  /** Whether this is the primary/main display */
  isPrimary: boolean;
  /** Physical pixel width of this display */
  physicalWidth: number;
  /** Physical pixel height of this display */
  physicalHeight: number;
  /** Logical (point) width before Retina scaling */
  logicalWidth: number;
  /** Logical (point) height before Retina scaling */
  logicalHeight: number;
  /** Retina scale factor (2 for Retina, 1 for standard) */
  scaleFactor: number;
  /** Origin X in macOS global coordinate space (logical points) */
  originX: number;
  /** Origin Y in macOS global coordinate space (logical points) */
  originY: number;
}

export interface ScreenInfo {
  /** Physical pixel width of the composite capture (all displays) */
  physicalWidth: number;
  /** Physical pixel height of the composite capture (all displays) */
  physicalHeight: number;
  /** Retina scale factor of the primary display (backward compat) */
  scaleFactor: number;
  /** Per-display info, ordered by displayNumber. Empty = legacy single-display mode. */
  displays: DisplayInfo[];
}
