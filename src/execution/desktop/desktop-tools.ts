/**
 * Desktop Control Tools
 * Claude tool_use definitions and dispatcher for local desktop automation.
 * Includes a lightweight `request_desktop` tool for dynamic on-demand access.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalDesktopService } from './local-desktop.service.js';
import type { DesktopAction, DesktopActionResult, DisplayInfo } from './desktop-types.js';

// ============================================================================
// REQUEST DESKTOP TOOL (lightweight, included by default)
// ============================================================================

export const REQUEST_DESKTOP_TOOL: Tool = {
  name: 'request_desktop',
  description:
    'Request desktop control to interact with the user\'s real macOS screen. Use this for: (1) controlling native apps (Finder, Mail, Calendar, VS Code), (2) interacting with the user\'s real Chrome browser that has saved logins and cookies (social media, email, banking), (3) multi-app coordination, (4) tasks needing visual verification via screenshots. Desktop control sees the actual screen — all logged-in sessions, all open apps. Only one task can control the desktop at a time.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Brief reason why desktop access is needed',
      },
    },
    required: ['reason'],
  },
};

export const DESKTOP_ACTIVATION_MESSAGE = `Desktop control activated. You now have these tools:
- desktop_screenshot: Capture the screen (use display:N for a specific monitor)
- desktop_click: Click at coordinates (x, y)
- desktop_type: Type text at cursor position
- desktop_key: Press keyboard shortcuts (e.g. "cmd+c", "enter")
- desktop_scroll: Scroll at position
- desktop_drag: Click-drag between two points
- desktop_move_window: Move frontmost window to a different display
- desktop_focus_app: Bring a specific app to the foreground (ALWAYS use this before typing in an app). For Google Chrome, also pass chrome_profile to target the right profile.
- desktop_list_chrome_profiles: Enumerate all Chrome profiles with their directory names and emails. Use this before desktop_focus_app when the task needs a specific Chrome profile (e.g. the one logged into x.com).
- desktop_wait: Pause for a duration

Workflow: focus the app first (desktop_focus_app), screenshot to see it, then click/type/key to interact. A screenshot is automatically taken after each action so you can see the result.

Chrome profile workflow for tasks like "check my X messages" or "post to my Twitter":
1. desktop_list_chrome_profiles to see which profiles exist
2. Pick the one whose email matches the target account
3. desktop_focus_app(app: "Google Chrome", chrome_profile: "<directory>") to open a window in that profile
4. Navigate and interact`;

/**
 * Build the desktop system prompt, optionally including multi-monitor layout info.
 */
export function buildDesktopSystemPrompt(displays?: DisplayInfo[]): string {
  let prompt = `## Desktop Control (Active)
You can control this macOS desktop. You see the screen via screenshots and interact via mouse and keyboard.

After each action (click, type, key, scroll), you receive an automatic screenshot showing the result. Use this to verify your action worked before proceeding.

Coordinate system: Screenshots are scaled to fit within 1280x800. Use coordinates as they appear in the scaled image. The system handles mapping to actual screen coordinates.`;

  if (displays && displays.length > 1) {
    const displayDescs = displays.map(d => {
      const flags = [d.isPrimary ? 'primary' : null, d.scaleFactor > 1 ? 'Retina' : null].filter(Boolean).join(', ');
      return `- Display ${d.displayNumber}: ${d.name} (${flags ? flags + ', ' : ''}${d.physicalWidth}x${d.physicalHeight})`;
    });
    prompt += `

Multi-monitor setup:
${displayDescs.join('\n')}

Multi-monitor workflow:
- To work on a specific display, capture it: desktop_screenshot(display: N) for full-resolution view
- After capturing a display, all click/type/key actions target that display's coordinate space
- Use desktop_move_window(display: N) to move the frontmost window between displays
- Default screenshot (no display param) captures the primary display only
- Display 1 is the primary (usually laptop). Higher numbers are external monitors.
- When switching displays, always take a fresh screenshot of the target first`;
  }

  prompt += `

Tips:
- Always take a screenshot first to orient yourself
- Click precisely on buttons and text fields
- Use desktop_key for keyboard shortcuts (e.g. "cmd+s" to save, "cmd+tab" to switch apps)
- If an action didn't work, try again or try an alternative approach
- Use desktop_wait if you need to let an animation or loading complete
- To move a window, drag from its title bar (the thin bar at the very top of the window), not from the center. Starting a drag from the window center will interact with content instead of moving the window.`;

  return prompt;
}

/** Default system prompt (single display, backward compat) */
export const DESKTOP_SYSTEM_PROMPT = buildDesktopSystemPrompt();

// ============================================================================
// FULL DESKTOP TOOL DEFINITIONS (injected after request_desktop is called)
// ============================================================================

export const DESKTOP_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'desktop_screenshot',
    description:
      'Take a screenshot of the macOS screen. By default captures all displays as a composite. Optionally specify a display number to capture only that display (gives better resolution for focused work on multi-monitor setups).',
    input_schema: {
      type: 'object',
      properties: {
        display: {
          type: 'number',
          description: 'Display number to capture (1 = primary). Omit to capture all displays.',
        },
      },
      required: [],
    },
  },
  {
    name: 'desktop_click',
    description:
      'Click at a specific (x, y) coordinate on the screen. Coordinates are relative to the screenshot image dimensions. Use the most recent screenshot to determine where to click.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in the screenshot image' },
        y: { type: 'number', description: 'Y coordinate in the screenshot image' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'double'],
          description: 'Mouse button (default: left). Use "double" for double-click.',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'desktop_type',
    description:
      'Type text at the current cursor position. Click on a text field first, then use this tool to enter text. Use mode "typewrite" for character-by-character input (more reliable in apps that drop characters).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type' },
        mode: {
          type: 'string',
          enum: ['normal', 'typewrite'],
          description: 'Typing mode. "normal" sends all text at once (default). "typewrite" types each character individually with a delay, more reliable in some apps.',
        },
        delayMs: {
          type: 'number',
          description: 'Delay between keystrokes in typewrite mode (default: 50ms). Ignored in normal mode.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'desktop_key',
    description:
      'Press a keyboard shortcut or special key. Use "+" to combine modifiers (e.g. "cmd+c", "cmd+shift+s", "enter", "escape", "tab", "cmd+tab").',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key or combo to press (e.g. "cmd+c", "enter", "escape", "cmd+shift+s")',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'desktop_scroll',
    description:
      'Scroll at a specific screen position. Move the mouse to (x, y) then scroll in the given direction.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate to scroll at' },
        y: { type: 'number', description: 'Y coordinate to scroll at' },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction',
        },
        amount: {
          type: 'number',
          description: 'Number of scroll steps (default: 3)',
        },
      },
      required: ['x', 'y', 'direction'],
    },
  },
  {
    name: 'desktop_drag',
    description:
      'Click and drag from one position to another. Useful for moving windows, selecting regions, or slider controls. When moving a window, start the drag from its title bar (the top edge of the window, roughly 20-30px from the top), not the center.',
    input_schema: {
      type: 'object',
      properties: {
        startX: { type: 'number', description: 'Starting X coordinate' },
        startY: { type: 'number', description: 'Starting Y coordinate' },
        endX: { type: 'number', description: 'Ending X coordinate' },
        endY: { type: 'number', description: 'Ending Y coordinate' },
      },
      required: ['startX', 'startY', 'endX', 'endY'],
    },
  },
  {
    name: 'desktop_wait',
    description:
      'Wait for a specified duration in milliseconds. Use this when you need to wait for an animation, loading, or transition to complete.',
    input_schema: {
      type: 'object',
      properties: {
        duration: {
          type: 'number',
          description: 'Duration to wait in milliseconds (e.g. 1000 for 1 second)',
        },
      },
      required: ['duration'],
    },
  },
  {
    name: 'desktop_move_window',
    description:
      'Move the frontmost window to a specific display. The window fills the target display. Use this to arrange apps across monitors (e.g. move Chrome to the external display).',
    input_schema: {
      type: 'object',
      properties: {
        display: {
          type: 'number',
          description: 'Target display number (1 = primary/laptop, 2 = external monitor, etc.)',
        },
      },
      required: ['display'],
    },
  },
  {
    name: 'desktop_focus_app',
    description:
      'Bring a specific application to the foreground. ALWAYS call this before typing or clicking in an app to make sure it is focused. More reliable than Cmd+Tab or Spotlight. For Google Chrome on a machine with multiple profiles, ALSO pass chrome_profile to target the right profile — without it you get whatever profile was last frontmost, which on dev machines is almost never the one logged into the target site. Use desktop_list_chrome_profiles first to discover profile directory names and emails.',
    input_schema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Application name exactly as macOS knows it (e.g. "Google Chrome", "Visual Studio Code", "Terminal", "Discord", "Finder")',
        },
        chrome_profile: {
          type: 'string',
          description: 'Chrome profile directory name (e.g. "Profile 1", "Default", "Profile 4"). Only meaningful for Chrome-family apps. When set, launches Chrome with --profile-directory=<value> which raises (or opens) a window belonging to that specific profile. Get valid directory names from desktop_list_chrome_profiles.',
        },
      },
      required: ['app'],
    },
  },
  {
    name: 'desktop_list_chrome_profiles',
    description:
      'Enumerate every Chrome profile on this machine with its directory name (e.g. "Profile 1"), display name, and primary email. Use this to pick the right profile for a task before calling desktop_focus_app. Essential when the user has multiple Chrome profiles (dev, personal, social) and the task needs the session/cookies of a specific one.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'desktop_focus_window',
    description:
      'Focus a specific window by matching its title. Use after desktop_list_windows to target the right window when an app has multiple windows open (e.g., different Chrome profiles or tabs). More precise than desktop_focus_app which just activates the app.',
    input_schema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Application name exactly as macOS knows it (e.g. "Google Chrome")',
        },
        title_contains: {
          type: 'string',
          description: 'Partial match for the window title (e.g. "x.com", "Gmail", "ohwow.fun"). Case-insensitive.',
        },
      },
      required: ['app'],
    },
  },
  {
    name: 'desktop_list_windows',
    description:
      'List all open windows with their app name, title, position, and size. Use this to find which app is on which display before taking screenshots or moving windows.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

// ============================================================================
// TOOL NAME HELPERS
// ============================================================================

const DESKTOP_TOOL_NAMES = new Set([
  'desktop_screenshot',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'desktop_scroll',
  'desktop_drag',
  'desktop_wait',
  'desktop_move_window',
  'desktop_focus_app',
  'desktop_focus_window',
  'desktop_list_windows',
  'desktop_list_chrome_profiles',
]);

/** Check if a tool name is a desktop tool */
export function isDesktopTool(toolName: string): boolean {
  return DESKTOP_TOOL_NAMES.has(toolName);
}

// ============================================================================
// TOOL DISPATCHER
// ============================================================================

/**
 * Map a tool call to a DesktopAction and execute it.
 */
export async function executeDesktopTool(
  desktopService: LocalDesktopService,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<DesktopActionResult> {
  const action = mapToolToAction(toolName, toolInput);
  if (!action) {
    return {
      success: false,
      type: 'screenshot',
      error: `Unknown desktop tool: ${toolName}`,
    };
  }
  return desktopService.executeAction(action);
}

function mapToolToAction(
  toolName: string,
  input: Record<string, unknown>,
): DesktopAction | null {
  switch (toolName) {
    case 'desktop_screenshot':
      return { type: 'screenshot', display: input.display as number | undefined };

    case 'desktop_click': {
      const button = input.button as string | undefined;
      if (button === 'right') {
        return { type: 'right_click', x: input.x as number, y: input.y as number };
      }
      if (button === 'double') {
        return { type: 'double_click', x: input.x as number, y: input.y as number };
      }
      return { type: 'left_click', x: input.x as number, y: input.y as number };
    }

    case 'desktop_type': {
      if (input.mode === 'typewrite') {
        return { type: 'typewrite', text: input.text as string, delayMs: input.delayMs as number | undefined };
      }
      return { type: 'type_text', text: input.text as string };
    }

    case 'desktop_key':
      return { type: 'key', key: input.key as string };

    case 'desktop_scroll':
      return {
        type: 'scroll',
        x: input.x as number,
        y: input.y as number,
        direction: input.direction as 'up' | 'down' | 'left' | 'right',
        amount: (input.amount as number) ?? 3,
      };

    case 'desktop_drag':
      return {
        type: 'left_click_drag',
        startX: input.startX as number,
        startY: input.startY as number,
        endX: input.endX as number,
        endY: input.endY as number,
      };

    case 'desktop_wait':
      return { type: 'wait', duration: input.duration as number };

    case 'desktop_move_window':
      return { type: 'move_window', display: input.display as number };

    case 'desktop_focus_app':
      return {
        type: 'focus_app',
        appName: input.app as string,
        chromeProfile: typeof input.chrome_profile === 'string' ? input.chrome_profile : undefined,
      };

    case 'desktop_focus_window':
      return { type: 'focus_window', appName: input.app as string, titleContains: input.title_contains as string | undefined };

    case 'desktop_list_windows':
      return { type: 'list_windows' };

    case 'desktop_list_chrome_profiles':
      return { type: 'list_chrome_profiles' };

    default:
      return null;
  }
}

// ============================================================================
// RESULT FORMATTER
// ============================================================================

/**
 * Format a DesktopActionResult into content blocks for the LLM response.
 * Returns text + image blocks (same pattern as formatBrowserToolResult).
 */
export function formatDesktopToolResult(
  result: DesktopActionResult,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
  const blocks: Array<{ type: string; text?: string; [key: string]: unknown }> = [];

  if (!result.success) {
    blocks.push({ type: 'text', text: `Error: ${result.error}` });
    return blocks;
  }

  // Text description of what happened
  const descriptions: Record<string, string> = {
    screenshot: 'Screenshot captured.',
    left_click: 'Left click performed.',
    right_click: 'Right click performed.',
    double_click: 'Double click performed.',
    triple_click: 'Triple click performed.',
    type_text: 'Text typed.',
    typewrite: 'Text typed (character-by-character).',
    key: 'Key pressed.',
    scroll: 'Scrolled.',
    mouse_move: 'Mouse moved.',
    wait: 'Wait completed.',
    left_click_drag: 'Drag performed.',
    move_window: 'Window moved to target display.',
    focus_app: 'Application focused.',
    focus_window: 'Window focused.',
    list_windows: 'Window list retrieved.',
  };

  blocks.push({ type: 'text', text: descriptions[result.type] ?? `Action ${result.type} completed.` });

  // Include text content (e.g. window list)
  if (result.content) {
    blocks.push({ type: 'text', text: result.content });
  }

  // Include screenshot as base64 image block
  if (result.screenshot) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: result.screenshot,
      },
    });
    if (result.scaledWidth && result.scaledHeight) {
      let dimText = `Screen dimensions: ${result.scaledWidth}x${result.scaledHeight}`;
      if (result.displayLayout) {
        dimText += `\n${result.displayLayout}`;
      }
      blocks.push({ type: 'text', text: dimText });
    }
  }

  return blocks;
}
