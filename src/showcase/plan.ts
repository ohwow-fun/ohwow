/**
 * Showcase plan synthesis.
 *
 * Takes a ShowcaseResult and crafts a `ShowcasePlan` — the tailored agent
 * system prompt, project name, goal title, and contact name that the user
 * will see at the proposal step. Template-based for MVP; LLM-driven
 * synthesis is a future enhancement.
 */

import type { ShowcasePlan, ShowcaseResult } from './types.js';

export function buildPlan(result: ShowcaseResult): ShowcasePlan {
  const { target, pageTitle, pageDescription } = result;
  const isPerson = target.kind === 'person';

  const contextLines: string[] = [];
  if (target.company && isPerson) contextLines.push(`Company: ${target.company}`);
  if (target.email) contextLines.push(`Email: ${target.email}`);
  if (result.pageUrl) contextLines.push(`Website: ${result.pageUrl}`);
  if (pageTitle) contextLines.push(`Page title: ${pageTitle}`);
  if (pageDescription) contextLines.push(`Page description: ${pageDescription}`);

  const contextBlock =
    contextLines.length > 0 ? `\n\nWhat we know about the target:\n${contextLines.map(l => `- ${l}`).join('\n')}` : '';

  if (isPerson) {
    return {
      agentName: `${target.name} Outreach`,
      agentRole: 'Outreach Researcher',
      agentDescription: `Drafts tailored outreach and watches for fresh signals about ${target.name}.`,
      agentSystemPrompt:
        `You are an outreach researcher focused on a single target: ${target.name}. ` +
        `Your job is to draft short, personalized, non-pushy outreach messages; keep a running ` +
        `summary of what matters to them; and flag any fresh public signals (news, posts, hires, ` +
        `launches) that would change the pitch. Always ground claims in sources. ` +
        `Prefer concrete specifics over generic flattery.${contextBlock}`,
      projectName: `Outreach: ${target.name}`,
      goalTitle: `Land a conversation with ${target.name}`,
      contactName: target.name,
    };
  }

  // Company
  return {
    agentName: `${target.name} Intel Watch`,
    agentRole: 'Account Intel Watcher',
    agentDescription: `Tracks ${target.name}: news, product moves, hiring, key people, and outreach angles.`,
    agentSystemPrompt:
      `You are an account intelligence analyst for a single target company: ${target.name}. ` +
      `Your job is to maintain a short, living brief on the company (what they do, recent moves, ` +
      `who to know, current priorities), surface any changes worth acting on, and suggest concrete ` +
      `outreach or content angles that would land well. Always cite sources and avoid speculation.${contextBlock}`,
    projectName: `Account: ${target.name}`,
    goalTitle: `Build a clear intel picture on ${target.name}`,
    contactName: target.name,
  };
}
