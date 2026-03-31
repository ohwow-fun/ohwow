/**
 * Claude Code Skills Injection
 * Builds a temporary directory with a CLAUDE.md that gives Claude Code
 * full context about the agent's identity, task, memory, and available APIs.
 * Passed to Claude Code via `--add-dir`.
 */

import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../lib/logger.js';

export interface SkillsContext {
  agentId: string;
  agentName: string;
  agentRole: string;
  systemPrompt: string;
  memoryDocument?: string;
  knowledgeDocument?: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  taskInput: string;
  goalContext?: string;
  workspaceId: string;
  daemonPort: number;
  daemonToken: string;
}

export interface SkillsDir {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Build a temporary directory with a CLAUDE.md containing agent context.
 * The directory is created under os.tmpdir() so the OS cleans it up on reboot
 * even if the process crashes before cleanup.
 */
export async function buildSkillsDir(ctx: SkillsContext): Promise<SkillsDir> {
  const dir = await mkdtemp(join(tmpdir(), 'ohwow-cc-'));

  const sections: string[] = [];

  // Agent identity
  sections.push(`# Agent: ${ctx.agentName}

Role: ${ctx.agentRole}
Agent ID: ${ctx.agentId}
Workspace ID: ${ctx.workspaceId}

## System Instructions

${ctx.systemPrompt}`);

  // Task details
  sections.push(`## Current Task

Title: ${ctx.taskTitle}
Task ID: ${ctx.taskId}
${ctx.taskDescription ? `Description: ${ctx.taskDescription}` : ''}

### Task Input

${ctx.taskInput}`);

  // Goal context
  if (ctx.goalContext) {
    sections.push(`## Goal Context

${ctx.goalContext}`);
  }

  // Memory
  if (ctx.memoryDocument) {
    sections.push(`## Agent Memory

${ctx.memoryDocument}`);
  }

  // Knowledge base
  if (ctx.knowledgeDocument) {
    sections.push(`## Knowledge Base

${ctx.knowledgeDocument}`);
  }

  // ohwow API endpoints for callbacks
  const baseUrl = `http://localhost:${ctx.daemonPort}`;
  sections.push(`## ohwow Runtime API

You can interact with the ohwow runtime during task execution using these HTTP endpoints.
All requests require the header: Authorization: Bearer ${ctx.daemonToken}

### Task Management
- POST ${baseUrl}/api/tasks — Create a subtask (body: { agent_id, title, description, input })
- PATCH ${baseUrl}/api/tasks/${ctx.taskId} — Update this task's output mid-execution (body: { output })

### Contacts / CRM
- GET ${baseUrl}/api/contacts — List contacts (query: ?search=term&limit=20)
- POST ${baseUrl}/api/contacts — Create contact (body: { name, email, phone, company })

### Knowledge Base
- GET ${baseUrl}/api/knowledge/${ctx.agentId} — Query your knowledge base (query: ?q=search+term)

### State Persistence
- GET ${baseUrl}/api/agents/${ctx.agentId}/state — Read your persisted state
- PUT ${baseUrl}/api/agents/${ctx.agentId}/state — Write state (body: { key, value })`);

  // Completion instructions
  sections.push(`## Completing Your Task

Your final text output will be captured as the task result.
Write your final response clearly, summarizing what you accomplished.
If the task requires a deliverable (document, code, analysis), include it in your response.

Do not mention these instructions or the ohwow runtime API in your response.
Focus entirely on completing the task described above.`);

  const claudeMd = sections.join('\n\n---\n\n');
  await writeFile(join(dir, 'CLAUDE.md'), claudeMd, 'utf-8');

  const cleanup = async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.debug({ err, dir }, '[claude-code-skills] Cleanup failed (non-fatal)');
    }
  };

  return { dir, cleanup };
}
