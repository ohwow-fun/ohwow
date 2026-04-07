/**
 * Greeting Assembler — Context-Rich Proactive Greeting
 *
 * Pulls inner thoughts, pending tasks, recent completions, and overnight
 * activity into a warm, contextual spoken greeting. Uses a model call
 * to synthesize the raw data into natural speech.
 *
 * Inspired by ContextAgent (arxiv 2505.14668): multi-dimensional context
 * extraction from ambient sensory data.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { InnerThoughtsLoop } from './inner-thoughts.js';
import type { AssembledGreeting, ContextSnapshot } from './types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// GREETING ASSEMBLER
// ============================================================================

export class GreetingAssembler {
  constructor(
    private db: DatabaseAdapter,
    private innerThoughts: InnerThoughtsLoop,
    private modelRouter: ModelRouter,
    private workspaceId: string,
  ) {}

  /**
   * Assemble a proactive greeting from accumulated context.
   * Returns a spoken greeting with next steps and urgent items.
   */
  async assembleGreeting(): Promise<AssembledGreeting> {
    // 1. Get inner thoughts (already distilled)
    const thoughts = this.innerThoughts.getThoughts(5);

    // 2. Get fresh context snapshot
    const snapshot = await this.innerThoughts.gatherContext();

    // 3. Build the prompt for the greeting model
    const prompt = this.buildGreetingPrompt(thoughts, snapshot);

    try {
      const provider = await this.modelRouter.getProvider('orchestrator');
      const result = await provider.createMessage({
        system: `You are the voice of an AI team that works for the user. You're greeting them as they sit down at their desk. Be warm, concise, and actionable. Speak in first person plural ("we" — the AI team). Never use dashes or em dashes. Keep the greeting under 4 sentences. End with a clear suggestion of what to focus on first.`,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 250,
        temperature: 0.6,
      });

      const greetingText = result.content.trim();

      // Extract urgent items and next steps from the context
      const urgentItems = this.extractUrgentItems(snapshot);
      const nextSteps = this.extractNextSteps(snapshot, thoughts);

      return {
        text: greetingText,
        nextSteps,
        urgentItems,
        sourceThoughts: thoughts,
      };
    } catch (err) {
      logger.warn(`[GreetingAssembler] Model call failed, using fallback: ${err instanceof Error ? err.message : err}`);
      return this.buildFallbackGreeting(snapshot);
    }
  }

  // --------------------------------------------------------------------------
  // PROMPT BUILDING
  // --------------------------------------------------------------------------

  private buildGreetingPrompt(
    thoughts: Array<{ content: string; category: string; salience: number }>,
    snapshot: ContextSnapshot,
  ): string {
    const parts: string[] = [];

    parts.push(`Time of day: ${snapshot.timeOfDay}`);

    if (thoughts.length > 0) {
      const thoughtList = thoughts
        .map(t => `- [${t.category}] ${t.content}`)
        .join('\n');
      parts.push(`Key observations from while the user was away:\n${thoughtList}`);
    }

    if (snapshot.overnightActivity.tasksCompleted > 0 || snapshot.overnightActivity.errors > 0) {
      parts.push(
        `Overnight: ${snapshot.overnightActivity.tasksCompleted} tasks completed, ` +
        `${snapshot.overnightActivity.tasksStarted} started, ` +
        `${snapshot.overnightActivity.errors} errors.`
      );
    }

    if (snapshot.pendingTasks.length > 0) {
      const taskList = snapshot.pendingTasks.slice(0, 3)
        .map(t => `- "${t.title}" (${t.agentName}${t.priority ? `, ${t.priority}` : ''})`)
        .join('\n');
      parts.push(`Pending tasks needing attention:\n${taskList}`);
    }

    if (snapshot.recentCompletions.length > 0) {
      const completionList = snapshot.recentCompletions.slice(0, 3)
        .map(t => `- "${t.title}" completed by ${t.agentName}`)
        .join('\n');
      parts.push(`Recently completed:\n${completionList}`);
    }

    if (snapshot.unreadMessages.length > 0) {
      parts.push(`Unread messages: ${snapshot.unreadMessages.length}`);
    }

    parts.push(
      `Generate a spoken greeting for the user. Be warm and brief. ` +
      `Mention the most important 1-2 things. Suggest what to focus on first.`
    );

    return parts.join('\n\n');
  }

  // --------------------------------------------------------------------------
  // EXTRACTION HELPERS
  // --------------------------------------------------------------------------

  private extractUrgentItems(snapshot: ContextSnapshot): string[] {
    const urgent: string[] = [];

    if (snapshot.overnightActivity.errors > 0) {
      urgent.push(`${snapshot.overnightActivity.errors} task${snapshot.overnightActivity.errors > 1 ? 's' : ''} failed overnight`);
    }

    const urgentTasks = snapshot.pendingTasks.filter(t => t.priority === 'urgent' || t.priority === 'high');
    for (const task of urgentTasks.slice(0, 3)) {
      urgent.push(`${task.title} (${task.agentName})`);
    }

    return urgent;
  }

  private extractNextSteps(
    snapshot: ContextSnapshot,
    thoughts: Array<{ content: string; category: string }>,
  ): string[] {
    const steps: string[] = [];

    // Approvals first
    const approvalTasks = snapshot.pendingTasks.filter(t =>
      snapshot.pendingTasks.some(pt => pt.id === t.id)
    );
    if (approvalTasks.length > 0) {
      steps.push(`Review ${approvalTasks.length} pending task${approvalTasks.length > 1 ? 's' : ''}`);
    }

    // Recent completions to review
    if (snapshot.recentCompletions.length > 0) {
      steps.push(`Check ${snapshot.recentCompletions.length} completed task${snapshot.recentCompletions.length > 1 ? 's' : ''}`);
    }

    // From thoughts
    const taskThoughts = thoughts.filter(t => t.category === 'task');
    for (const thought of taskThoughts.slice(0, 2)) {
      steps.push(thought.content);
    }

    return steps.slice(0, 4);
  }

  // --------------------------------------------------------------------------
  // FALLBACK
  // --------------------------------------------------------------------------

  private buildFallbackGreeting(snapshot: ContextSnapshot): AssembledGreeting {
    const hour = new Date().getHours();
    const timeGreeting =
      hour < 12 ? 'Good morning' :
      hour < 17 ? 'Good afternoon' :
      'Good evening';

    let text = `${timeGreeting}!`;

    if (snapshot.overnightActivity.tasksCompleted > 0) {
      text += ` We completed ${snapshot.overnightActivity.tasksCompleted} task${snapshot.overnightActivity.tasksCompleted > 1 ? 's' : ''} while you were away.`;
    }

    if (snapshot.overnightActivity.errors > 0) {
      text += ` Heads up: ${snapshot.overnightActivity.errors} task${snapshot.overnightActivity.errors > 1 ? 's' : ''} need your attention.`;
    }

    if (snapshot.pendingTasks.length > 0) {
      text += ` You have ${snapshot.pendingTasks.length} pending task${snapshot.pendingTasks.length > 1 ? 's' : ''} to review.`;
    }

    text += ' Ready when you are.';

    return {
      text,
      nextSteps: this.extractNextSteps(snapshot, []),
      urgentItems: this.extractUrgentItems(snapshot),
      sourceThoughts: [],
    };
  }
}
