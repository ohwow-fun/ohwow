/**
 * Host-reach tool definitions.
 *
 * Typed wrappers around the small set of macOS shell incantations we kept
 * asking agents to compose by hand through run_bash. Weaker models routinely
 * got the quoting wrong on osascript / pbcopy; dedicated tools make the
 * capability default-on and reliable.
 *
 * Scope: user-visible surface touches (notifications, speech, clipboard,
 * URLs) — intentionally no file or network tools. File work belongs to
 * run_bash under FileAccessGuard.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export const HOST_REACH_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'notify_user',
    description:
      "Show a native macOS notification to the user. Prefer this over run_bash + osascript when you want the user's attention — it handles quoting and sound name validation for you. The notification appears in the top-right Notification Center with the given title and body.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short notification title (shown bold).' },
        body: { type: 'string', description: 'Notification body text.' },
        sound: {
          type: 'string',
          description:
            'Optional system sound name: Glass, Ping, Hero, Submarine, Tink, Funk, Basso, Blow, Bottle, Frog, Morse, Pop, Purr, Sosumi. Omit for silent.',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'speak',
    description:
      "Speak text aloud through the host's speakers using macOS text-to-speech. Use sparingly — the user can hear you. Blocks until playback completes.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak. Keep it under ~30 words.' },
        voice: {
          type: 'string',
          description:
            'Optional voice name (e.g. Samantha, Alex, Victoria, Daniel). Default: system default.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'clipboard_read',
    description:
      "Read the current contents of the user's clipboard (pbpaste). Returns text only — images and other data yield an empty string.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'clipboard_write',
    description:
      "Replace the contents of the user's clipboard with the given text. Overwrites whatever was there — use sparingly, and only when the user explicitly asked you to put something on their clipboard.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to place on the clipboard.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'open_url',
    description:
      "Open a URL in the user's default web browser. Only use for well-formed http/https URLs; refuse to construct search URLs or anything that could redirect somewhere unexpected.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Fully-qualified http or https URL.' },
      },
      required: ['url'],
    },
  },
];

export const HOST_REACH_TOOL_NAMES = HOST_REACH_TOOL_DEFINITIONS.map((t) => t.name);

export function isHostReachTool(toolName: string): boolean {
  return HOST_REACH_TOOL_NAMES.includes(toolName);
}

export const HOST_REACH_SYSTEM_PROMPT = `
## Reaching the User

You have typed tools for user-visible host actions:
- **notify_user** — native macOS notification (preferred for getting attention)
- **speak** — text-to-speech through the user's speakers (use sparingly)
- **clipboard_read** / **clipboard_write** — read/replace the clipboard
- **open_url** — open a URL in the user's default browser

Prefer these over shelling out through run_bash — quoting is handled, sounds
are validated, URLs are checked. Use with care: they interrupt the user's
environment. Don't speak or notify on every step; reserve these for moments
where the user actually benefits from the interruption.
`;
