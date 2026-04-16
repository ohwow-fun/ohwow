/**
 * Showcase types. Shared between the CLI, research pipeline, setup writer,
 * and TUI wizard.
 */

export type TargetKind = 'person' | 'company';

export interface ShowcaseTarget {
  name: string;
  kind: TargetKind;
  url?: string;
  company?: string;
  email?: string;
}

export interface ShowcaseResult {
  target: ShowcaseTarget;
  /** Primary fetched page, if any. */
  pageTitle?: string;
  pageDescription?: string;
  pageText?: string;
  pageUrl?: string;
}

export interface ShowcasePlan {
  agentName: string;
  agentRole: string;
  agentDescription: string;
  agentSystemPrompt: string;
  projectName: string;
  goalTitle: string;
  contactName: string;
}

export interface ShowcaseOutcome {
  agentId: string;
  projectId: string;
  goalId: string;
  contactId: string;
}
