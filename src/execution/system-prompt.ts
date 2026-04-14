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
import { wrapUserData } from '../lib/prompt-injection.js';
import type { BusinessContext } from './types.js';

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

## Current Task
Title: ${wrapUserData(opts.taskTitle)}
${opts.taskDescription ? `Description: ${wrapUserData(opts.taskDescription)}` : ''}

---

${opts.agentPrompt}`;
}
