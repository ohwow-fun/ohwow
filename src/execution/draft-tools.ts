/**
 * Draft Tool Definitions for the Runtime Engine
 * Static definitions for draftable tools (e.g., gmail_draft_email).
 * The runtime doesn't load integration tools from a database, so these
 * are defined statically and included when approval_required is true.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

// ============================================================================
// DRAFT TOOL DEFINITIONS
// ============================================================================

export const DRAFT_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'gmail_draft_email',
    description:
      'Draft an email for the user to review before sending. The email will be sent automatically after approval. Use this instead of sending emails directly when the user should review first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address',
        },
        subject: {
          type: 'string',
          description: 'Email subject line',
        },
        body: {
          type: 'string',
          description: 'Email body content (plain text or HTML)',
        },
        cc: {
          type: 'string',
          description: 'CC recipients (comma-separated)',
        },
        bcc: {
          type: 'string',
          description: 'BCC recipients (comma-separated)',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

// ============================================================================
// DRAFT TOOL → REAL TOOL MAPPING
// ============================================================================

const DRAFT_TO_REAL: Record<string, string> = {
  gmail_draft_email: 'gmail_send_email',
};

const DRAFT_TO_PROVIDER: Record<string, string> = {
  gmail_draft_email: 'gmail',
};

/** Check if a tool name is a draft tool */
export function isDraftTool(name: string): boolean {
  return name in DRAFT_TO_REAL;
}

/** Build a deferred action payload from a draft tool call */
export function buildDeferredAction(
  toolName: string,
  input: Record<string, unknown>,
): { type: string; params: Record<string, unknown>; provider: string } {
  return {
    type: DRAFT_TO_REAL[toolName] || toolName,
    params: input,
    provider: DRAFT_TO_PROVIDER[toolName] || 'unknown',
  };
}

/** System prompt hint for draft tools */
export const DRAFT_TOOL_PROMPT_HINT = `\nWhen performing outbound actions (sending emails, posting messages), prefer using draft tools (e.g., \`gmail_draft_email\` instead of \`gmail_send_email\`) so the user can review before sending. Use the immediate versions only when explicitly instructed to send without review.`;
