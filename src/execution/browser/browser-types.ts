/**
 * Runtime Browser Types
 * Browser types for local Stagehand/Chromium automation.
 * Matches the action contract used by the cloud browser package.
 */

// ============================================================================
// ENUMS
// ============================================================================

export type BrowserActionType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'snapshot'
  | 'screenshot'
  | 'download'
  | 'scroll'
  | 'back'
  | 'forward'
  | 'wait'
  | 'hover'
  | 'press_key'
  | 'extract'
  | 'extract_text'
  | 'agent_task'
  | 'click_at'
  | 'type_text'
  | 'new_tab'
  | 'switch_tab'
  | 'close_tab'
  | 'evaluate';

// ============================================================================
// BROWSER ACTIONS (tool inputs/outputs for Claude)
// ============================================================================

export interface BrowserNavigateAction { type: 'navigate'; url: string }
export interface BrowserClickAction { type: 'click'; ref: string; description?: string }
export interface BrowserTypeAction { type: 'type'; ref: string; text: string; submit?: boolean }
export interface BrowserSnapshotAction { type: 'snapshot' }
export interface BrowserScreenshotAction { type: 'screenshot' }
export interface BrowserDownloadAction { type: 'download'; ref: string; description?: string }
export interface BrowserScrollAction { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
export interface BrowserBackAction { type: 'back' }
export interface BrowserForwardAction { type: 'forward' }
export interface BrowserWaitAction { type: 'wait'; selector?: string; timeout?: number; state?: 'visible' | 'attached' | 'networkidle' }
export interface BrowserHoverAction { type: 'hover'; ref?: string; description?: string }
export interface BrowserPressKeyAction { type: 'press_key'; key: string }
export interface BrowserExtractAction { type: 'extract'; instruction: string; schema?: string }
export interface BrowserExtractTextAction { type: 'extract_text'; selector?: string; instruction?: string }
export interface BrowserAgentTaskAction { type: 'agent_task'; instruction: string; maxSteps?: number }
export interface BrowserClickAtAction { type: 'click_at'; x: number; y: number }
export interface BrowserTypeTextAction { type: 'type_text'; text: string; x?: number; y?: number }
export interface BrowserNewTabAction { type: 'new_tab'; url?: string }
export interface BrowserSwitchTabAction { type: 'switch_tab'; tabIndex: number }
export interface BrowserCloseTabAction { type: 'close_tab'; tabIndex?: number }
/**
 * Raw JS evaluation — runs the given expression via Playwright's
 * page.evaluate() on the active page and returns the JSON-serialized
 * result. Zero AI, zero Stagehand. The escape hatch for hostile DOMs
 * and anything where you just need to introspect the page directly.
 */
export interface BrowserEvaluateAction { type: 'evaluate'; expression: string }

export type BrowserAction =
  | BrowserNavigateAction
  | BrowserClickAction
  | BrowserTypeAction
  | BrowserSnapshotAction
  | BrowserScreenshotAction
  | BrowserDownloadAction
  | BrowserScrollAction
  | BrowserBackAction
  | BrowserForwardAction
  | BrowserWaitAction
  | BrowserHoverAction
  | BrowserPressKeyAction
  | BrowserExtractAction
  | BrowserExtractTextAction
  | BrowserAgentTaskAction
  | BrowserClickAtAction
  | BrowserTypeTextAction
  | BrowserNewTabAction
  | BrowserSwitchTabAction
  | BrowserCloseTabAction
  | BrowserEvaluateAction;

export interface BrowserActionResult {
  success: boolean;
  type: BrowserActionType;
  content?: string;
  screenshot?: string; // base64
  downloadBase64?: string;
  downloadFilename?: string;
  error?: string;
  currentUrl?: string;
  pageTitle?: string;
}

// ============================================================================
// SNAPSHOT TYPE (accessibility tree for AI)
// ============================================================================

export interface BrowserSnapshot {
  url: string;
  title: string;
  content: string; // accessibility tree text with numbered refs
}
