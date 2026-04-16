/**
 * RuntimeEngine system-prompt builder — pure function extracted from
 * RuntimeEngine.buildSystemPrompt. Takes the agent + task + capability
 * flags + the workspace's BusinessContext and returns the assembled
 * system prompt string.
 *
 * The only reason this lived as a private method on RuntimeEngine was
 * that it read `this.businessContext`. Pass that in explicitly and the
 * function becomes trivially testable and isolatable.
 */

import { BROWSER_SYSTEM_PROMPT } from './browser/index.js';
import { DRAFT_TOOL_PROMPT_HINT } from './draft-tools.js';
import { SCRAPLING_SYSTEM_PROMPT } from './scrapling/index.js';
import { FILESYSTEM_SYSTEM_PROMPT } from './filesystem/index.js';
import { BASH_SYSTEM_PROMPT } from './bash/index.js';
import { DOC_MOUNT_SYSTEM_PROMPT } from './doc-mounts/index.js';
import { DEVOPS_SYSTEM_PROMPT } from './devops/devops-prompts.js';
import { COPYWRITING_RULES } from '../lib/copywriting-rules.js';
import { scanForInjection, wrapUserData } from '../lib/prompt-injection.js';
import { loadStateContext, loadPreviousTaskContext } from './state/index.js';
import { logger } from '../lib/logger.js';
import type { BusinessContext } from './types.js';
import type { RuntimeEngine } from './engine.js';
import type { TaskCapabilities } from './task-capabilities.js';

export interface BuildSystemPromptOptions {
  agentName: string;
  agentRole: string;
  agentPrompt: string;
  taskTitle: string;
  taskDescription?: string;
  memoryDocument?: string;
  knowledgeDocument?: string;
  skillsDocument?: string;
  webSearchEnabled?: boolean;
  browserEnabled?: boolean;
  scraplingEnabled?: boolean;
  localFilesEnabled?: boolean;
  bashEnabled?: boolean;
  devopsEnabled?: boolean;
  desktopEnabled?: boolean;
  approvalRequired?: boolean;
  goalContext?: string;
  /**
   * Declared `deferred_action` from the task row — dispatchers stamp
   * this to signal "this task will culminate in a concrete real-world
   * action". Surfaced to the LLM as a `Task Intent` section so it
   * reaches for the matching tool instead of drafting markdown.
   */
  deferredAction?: { type: string; provider?: string | null };
}

/**
 * Mapping from `deferred_action.type` → preferred tool name. Kept
 * tiny on purpose — only the pairs the dispatchers actually emit
 * today. Add entries when new deferred-action types land. The LLM
 * gets the pair verbatim so it knows which tool to reach for.
 */
const DEFERRED_ACTION_TOOL_HINTS: Record<string, string> = {
  post_tweet: 'x_compose_tweet',
};

/**
 * Render the Task Intent section. Exported for unit tests. Returns
 * empty string when no deferredAction is set.
 */
export function renderTaskIntentSection(
  deferredAction: BuildSystemPromptOptions['deferredAction'] | undefined,
): string {
  if (!deferredAction?.type) return '';
  const providerStr = deferredAction.provider ? ` via **${deferredAction.provider}**` : '';
  const preferredTool = DEFERRED_ACTION_TOOL_HINTS[deferredAction.type];
  const toolLine = preferredTool
    ? `Prefer the \`${preferredTool}\` tool to perform the action directly.`
    : 'Prefer the matching tool in your tool list to perform the action directly.';
  return `
## Task Intent
This task declared a deferred_action: **${deferredAction.type}**${providerStr}.
${toolLine} Do NOT produce a markdown draft as a substitute — call the tool. If the tool errors, report the specific error (selector not found, login redirect, profile mismatch, etc.) rather than capitulating to manual posting or pretending the action succeeded.
`;
}

export function buildAgentSystemPrompt(
  businessContext: BusinessContext,
  opts: BuildSystemPromptOptions,
): string {
  const biz = businessContext;
  const memorySection = opts.memoryDocument ? `\n${opts.memoryDocument}\n` : '';
  const knowledgeSection = opts.knowledgeDocument ? `\n${opts.knowledgeDocument}\n` : '';
  const skillsSection = opts.skillsDocument ? `\n## Standard Procedures\n**You MUST execute the tool calls listed below. Do NOT just describe what you would do — actually call each tool in sequence. Start by calling request_desktop or request_browser as the first step. If you skip the tool calls and only write text, the task will fail.**\n\n${opts.skillsDocument}\n` : '';
  const classificationSection = `\n## Response Classification
Before your response content, include exactly one hidden metadata tag on the very first line:
- <!--response_meta:{"type":"deliverable"}--> when your response contains a concrete work product (a draft, email, article, proposal, report, plan, code, creative content, data analysis, or any actionable output)
- <!--response_meta:{"type":"informational"}--> when your response is a brief answer, status update, clarification, or acknowledgment
${DRAFT_TOOL_PROMPT_HINT}`;
  const webSearchSection = opts.webSearchEnabled
    ? `\n## Web Search
You have web search capability. Use it whenever you need current or factual information.
- Be specific with search queries for better results.
- Cite your sources when presenting search results.
`
    : '';
  const browserSection = opts.browserEnabled ? BROWSER_SYSTEM_PROMPT : '';
  const scraplingSection = opts.scraplingEnabled ? SCRAPLING_SYSTEM_PROMPT : '';
  const docMountSection = opts.scraplingEnabled ? DOC_MOUNT_SYSTEM_PROMPT : '';
  const filesystemSection = opts.localFilesEnabled ? FILESYSTEM_SYSTEM_PROMPT : '';
  const bashSection = opts.bashEnabled ? BASH_SYSTEM_PROMPT : '';
  const devopsSection = opts.devopsEnabled ? DEVOPS_SYSTEM_PROMPT : '';

  // Guide the agent on when to use browser vs desktop.
  const toolChoiceGuide = opts.browserEnabled && opts.desktopEnabled ? `
## Browser vs Desktop: When to Use Which

**Use request_desktop when the task involves:**
- Social media accounts (X/Twitter, Instagram, LinkedIn) — the user's Chrome has saved logins
- Email, banking, or any service requiring stored credentials
- Native macOS apps (Finder, Mail, Calendar, VS Code)
- Tasks where you need to see and interact with the actual screen

**Use request_browser (with profile="isolated") when the task involves:**
- Public web search, research, scraping
- Reading public pages that don't need login
- Tasks where speed matters more than credentials

**Rule of thumb:** If the task mentions a specific account, service login, or "my" (my email, my messages, my account), use request_desktop. If it's public information gathering, use request_browser.
` : '';

  const wrappedBusinessDesc = biz.businessDescription
    ? wrapUserData(biz.businessDescription)
    : `A ${biz.businessType.replace(/_/g, ' ')} business.`;

  const taskIntentSection = renderTaskIntentSection(opts.deferredAction);

  return `You are ${opts.agentName}, a ${opts.agentRole} working for ${biz.businessName}.

## Business Context
${wrappedBusinessDesc}
${opts.goalContext ? `\n${opts.goalContext}\n` : ''}${memorySection}${knowledgeSection}${skillsSection}${toolChoiceGuide}${classificationSection}${webSearchSection}${browserSection}${scraplingSection}${docMountSection}${filesystemSection}${bashSection}${devopsSection}
${COPYWRITING_RULES}

## Guidelines
- Always maintain a professional and helpful tone
- Focus on quality and accuracy in your work
- If you're unsure about something, ask for clarification
- Provide clear, actionable outputs
${taskIntentSection}
## Current Task
Title: ${wrapUserData(opts.taskTitle)}
${opts.taskDescription ? `Description: ${wrapUserData(opts.taskDescription)}` : ''}

---

${opts.agentPrompt}`;
}

/**
 * Assemble the full per-task system prompt, including:
 *   1. The base prompt from buildAgentSystemPrompt (agent + task + caps)
 *   2. Persistent state context (loadStateContext)
 *   3. Previous task context for cross-task continuity
 *   4. Parent task output for delegated dependency chains
 *   5. Cross-session working memory + session row creation / reuse
 *
 * Also scans user-provided fields (title, description, input) for
 * prompt-injection attempts up-front (log-only). Returns the assembled
 * string plus the activeSessionId so the completion pipeline can record
 * the session binding.
 */
export async function assembleSystemPrompt(
  this: RuntimeEngine,
  args: {
    agent: { name: string; role: string; system_prompt: string };
    task: {
      title: string;
      description: string | null;
      input: string | unknown;
      parent_task_id: string | null;
      goal_id: string | null;
      /**
       * Dispatcher-stamped intent (e.g. `{type:"post_tweet", provider:"x"}`).
       * Optional on the interface so test helpers that construct tasks
       * directly don't have to pass it. When present, renders as the
       * `Task Intent` section of the agent's system prompt.
       */
      deferred_action?: string | Record<string, unknown> | null;
    };
    taskId: string;
    agentId: string;
    workspaceId: string;
    memoryDoc: string;
    knowledgeDoc: string;
    skillsDoc: string;
    caps: TaskCapabilities;
  },
): Promise<{ systemPrompt: string; activeSessionId: string | null }> {
  const { agent, task, taskId, agentId, workspaceId, memoryDoc, knowledgeDoc, skillsDoc, caps } = args;

  // Scan user-provided fields for injection attempts (log-only)
  scanForInjection(
    { title: task.title, description: task.description, input: typeof task.input === 'string' ? task.input : null },
    { taskId, agentId },
  );

  // Normalize deferred_action to the struct buildAgentSystemPrompt
  // expects. The DB adapter returns JSONB columns as either a raw
  // string or an already-parsed object; handle both. Bad JSON is
  // silently treated as absent — failure to render the Task Intent
  // section must never block task execution.
  let deferredAction: BuildSystemPromptOptions['deferredAction'];
  const rawDeferred = task.deferred_action;
  if (rawDeferred != null) {
    try {
      const parsed: unknown = typeof rawDeferred === 'string' ? JSON.parse(rawDeferred) : rawDeferred;
      if (parsed && typeof parsed === 'object') {
        const typed = parsed as { type?: unknown; provider?: unknown };
        if (typeof typed.type === 'string' && typed.type.length > 0) {
          deferredAction = {
            type: typed.type,
            provider: typeof typed.provider === 'string' ? typed.provider : null,
          };
        }
      }
    } catch {
      /* malformed JSON — leave deferredAction undefined */
    }
  }

  let systemPrompt = buildAgentSystemPrompt(this.businessContext, {
    agentName: agent.name,
    agentRole: agent.role,
    agentPrompt: agent.system_prompt,
    taskTitle: task.title,
    taskDescription: task.description || undefined,
    memoryDocument: memoryDoc || undefined,
    knowledgeDocument: knowledgeDoc || undefined,
    skillsDocument: skillsDoc || undefined,
    webSearchEnabled: caps.webSearchEnabled,
    browserEnabled: false, // Browser instructions injected on-demand, not upfront
    scraplingEnabled: caps.scraplingEnabled,
    localFilesEnabled: caps.localFilesEnabled && caps.fileAccessGuard !== null,
    bashEnabled: caps.bashEnabled && caps.fileAccessGuard !== null,
    devopsEnabled: caps.devopsEnabled,
    desktopEnabled: caps.desktopEnabled,
    approvalRequired: caps.approvalRequired,
    goalContext: caps.goalContext,
    deferredAction,
  });

  // 4.1 Inject persistent state context
  try {
    const stateDoc = await loadStateContext(this.db, workspaceId, agentId, task.goal_id || undefined);
    if (stateDoc) {
      systemPrompt += `\n\n${stateDoc}`;
    }
  } catch {
    logger.warn('[RuntimeEngine] State context injection skipped');
  }

  // 4.1b Inject previous task context for cross-task continuity
  try {
    const prevContext = await loadPreviousTaskContext(this.db, workspaceId, agentId, taskId);
    if (prevContext) {
      systemPrompt += `\n\n${prevContext}`;
    }
  } catch {
    logger.warn('[RuntimeEngine] Previous task context injection skipped');
  }

  // 4.1c Inject parent task output for dependency chains
  if (task.parent_task_id) {
    try {
      const { data: parentData } = await this.db
        .from('agent_workforce_tasks')
        .select('title, output')
        .eq('id', task.parent_task_id)
        .single();
      if (parentData) {
        const parent = parentData as { title: string; output: string | unknown };
        const parentOutput = typeof parent.output === 'string'
          ? parent.output
          : JSON.stringify(parent.output);
        const trimmed = parentOutput.length > 4000
          ? parentOutput.slice(0, 4000) + '...'
          : parentOutput;
        systemPrompt += `\n\n## Parent Task Output\nFrom task "${parent.title}":\n\n${trimmed}`;
      }
    } catch {
      logger.warn('[RuntimeEngine] Parent task context injection skipped');
    }
  }

  // 4.2 Inject cross-session working memory
  let activeSessionId: string | null = null;
  try {
    // Expire stale sessions
    await this.db
      .from('agent_workforce_sessions')
      .update({ status: 'expired' })
      .eq('workspace_id', workspaceId)
      .eq('agent_id', agentId)
      .eq('status', 'active')
      .lt('expires_at', new Date().toISOString());

    // Find active session
    const { data: sessionData } = await this.db
      .from('agent_workforce_sessions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('agent_id', agentId)
      .eq('status', 'active')
      .order('last_active_at', { ascending: false })
      .limit(1)
      .single();

    if (sessionData && sessionData.context_summary) {
      activeSessionId = sessionData.id as string;
      systemPrompt += `\n\n## Recent Session Context\n${sessionData.context_summary}`;
      await this.db
        .from('agent_workforce_tasks')
        .update({ session_id: activeSessionId })
        .eq('id', taskId);
    } else if (sessionData) {
      activeSessionId = sessionData.id as string;
      await this.db
        .from('agent_workforce_tasks')
        .update({ session_id: activeSessionId })
        .eq('id', taskId);
    } else {
      // Create new session
      const { data: newSession } = await this.db
        .from('agent_workforce_sessions')
        .insert({
          workspace_id: workspaceId,
          agent_id: agentId,
          title: task.title,
        })
        .select('id')
        .single();

      if (newSession) {
        activeSessionId = newSession.id as string;
        await this.db
          .from('agent_workforce_tasks')
          .update({ session_id: activeSessionId })
          .eq('id', taskId);
      }
    }
  } catch {
    // Session context is best-effort; don't fail the task
    logger.warn('[RuntimeEngine] Session context injection skipped');
  }

  return { systemPrompt, activeSessionId };
}
