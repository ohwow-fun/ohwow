/**
 * Runtime Browser Tools
 * Claude tool_use definitions and dispatcher for local browser automation.
 * Includes a lightweight `request_browser` tool for dynamic on-demand access.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalBrowserService } from './local-browser.service.js';
import type { BrowserAction, BrowserActionResult } from './browser-types.js';

// ============================================================================
// TOOL DEFINITIONS (for Claude API tool_use)
// ============================================================================

// ============================================================================
// REQUEST BROWSER TOOL (lightweight, included by default)
// ============================================================================

export const REQUEST_BROWSER_TOOL: Tool = {
  name: 'request_browser',
  description:
    'Request a browser for web tasks. Use this for: (1) public websites, search, research — use profile="isolated" for speed and privacy, (2) web apps where the user is already logged in (X, Gmail, etc.) — omit profile to use their real Chrome with saved sessions. Do NOT use this for native macOS apps (use request_desktop instead). For tasks needing saved credentials on websites (X, Gmail, etc.), use the real Chrome profile, NOT "isolated".',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Brief reason why browser access is needed',
      },
      profile: {
        type: 'string',
        description: 'Chrome profile to use. Options: a profile directory name from list_chrome_profiles (e.g. "Profile 1"), an email to auto-match (e.g. "ogsus@ohwow.fun"), or "isolated" for a fresh browser with no sessions. Omit to use the default Chrome profile.',
      },
    },
    required: ['reason'],
  },
};

/** Tool to discover Chrome profiles before choosing one */
export const LIST_CHROME_PROFILES_TOOL: Tool = {
  name: 'list_chrome_profiles',
  description: 'List all Chrome profiles on this device with their names and email accounts. Use this to find the right profile before opening the browser (e.g. to find which profile is logged into a specific service).',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export const BROWSER_ACTIVATION_MESSAGE = `Browser launched successfully. You now have these tools available:
- browser_navigate: Go to a URL
- browser_snapshot: Get accessibility tree (numbered refs for click/type)
- browser_click: Click element by ref number
- browser_type: Type into input by ref number
- browser_screenshot: Take visual screenshot
- browser_download_file: Download file by clicking ref

Workflow: navigate → snapshot → interact. Always snapshot after navigating.`;

// ============================================================================
// FULL BROWSER TOOL DEFINITIONS (injected after request_browser is called)
// ============================================================================

export const BROWSER_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'browser_navigate',
    description:
      'Navigate the browser to a URL. Use this to visit websites, follow links, or go to specific pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to (must include protocol, e.g. https://)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an interactive element on the page. Use the ref number from browser_snapshot to identify the element.',
    input_schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The ref number of the element to click (from browser_snapshot output)',
        },
        description: {
          type: 'string',
          description: 'A brief description of what you are clicking (e.g. "Submit button")',
        },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input field. Use the ref number from browser_snapshot to identify the field.',
    input_schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The ref number of the input field (from browser_snapshot output)',
        },
        text: {
          type: 'string',
          description: 'The text to type into the field',
        },
        submit: {
          type: 'boolean',
          description: 'Whether to press Enter after typing (default: false)',
        },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Get an accessibility snapshot of the current page. Returns a tree of interactive elements with numbered refs that can be used with browser_click and browser_type. Always call this after navigating to understand the page structure.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Take a screenshot of the current browser viewport. Returns a JPEG image. Use this when you need to see the visual state of the page.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_download_file',
    description:
      'Click a download link or button to download a file from the current page. Returns the file content as base64-encoded data. Use the ref number from browser_snapshot to identify the download element.',
    input_schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The ref number of the download link or button (from browser_snapshot output)',
        },
        description: {
          type: 'string',
          description: 'A brief description of what you are downloading',
        },
      },
      required: ['ref'],
    },
  },
];

export const BROWSER_TOOL_NAMES = BROWSER_TOOL_DEFINITIONS.map((t) => t.name) as string[];

// ============================================================================
// TOOL DISPATCHER
// ============================================================================

/**
 * Execute a browser tool call from Claude's tool_use response.
 */
export async function executeBrowserTool(
  browserService: LocalBrowserService,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<BrowserActionResult> {
  const action = mapToolToAction(toolName, toolInput);
  if (!action) {
    return {
      success: false,
      type: 'navigate',
      error: `Unknown browser tool: ${toolName}`,
    };
  }

  return browserService.executeAction(action);
}

function mapToolToAction(
  toolName: string,
  input: Record<string, unknown>
): BrowserAction | null {
  switch (toolName) {
    case 'browser_navigate':
      return { type: 'navigate', url: input.url as string };
    case 'browser_click':
      return {
        type: 'click',
        ref: input.ref as string,
        description: input.description as string | undefined,
      };
    case 'browser_type':
      return {
        type: 'type',
        ref: input.ref as string,
        text: input.text as string,
        submit: input.submit as boolean | undefined,
      };
    case 'browser_snapshot':
      return { type: 'snapshot' };
    case 'browser_screenshot':
      return { type: 'screenshot' };
    case 'browser_download_file':
      return {
        type: 'download',
        ref: input.ref as string,
        description: input.description as string | undefined,
      };
    default:
      return null;
  }
}

/**
 * Check if a tool name is a browser tool
 */
export function isBrowserTool(toolName: string): boolean {
  return BROWSER_TOOL_NAMES.includes(toolName);
}

/**
 * Format a BrowserActionResult into a tool_result content block for Claude
 */
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } };

export function formatBrowserToolResult(
  result: BrowserActionResult
): ToolResultBlock[] {
  const blocks: ToolResultBlock[] = [];

  if (result.error) {
    blocks.push({ type: 'text', text: `Error: ${result.error}` });
  } else if (result.content) {
    blocks.push({ type: 'text', text: result.content });
  }

  if (result.screenshot) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg' as const,
        data: result.screenshot,
      },
    });
  }

  if (result.downloadBase64) {
    blocks.push({
      type: 'text',
      text: `[DOWNLOAD_BASE64:${result.downloadFilename || 'file'}]\n${result.downloadBase64}`,
    });
  }

  return blocks;
}

/**
 * Browser instructions appended to the system prompt when browser is enabled.
 */
export const BROWSER_SYSTEM_PROMPT = `
## Browser
You have a local Chromium browser. Use it to visit websites, interact with pages, and extract information.

Available tools:
- **browser_navigate**: Go to a URL
- **browser_snapshot**: Get an accessibility tree of the page (numbered refs for click/type)
- **browser_click**: Click an element by ref number
- **browser_type**: Type text into an input by ref number
- **browser_screenshot**: Take a visual screenshot
- **browser_download_file**: Download a file by clicking a ref

Workflow:
1. Use browser_navigate to go to a URL
2. Use browser_snapshot to see the page structure
3. Use browser_click / browser_type to interact with elements
4. Use browser_screenshot if you need to see the visual layout
`;
