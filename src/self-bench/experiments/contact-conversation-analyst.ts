/**
 * ContactConversationAnalyst — turns inbound DMs into actionable next-steps.
 *
 * The pipeline only generates revenue if something happens after a
 * contact talks to us. This probe reads each contact's recent DM
 * thread + contact-event history, asks an LLM to categorize what the
 * human actually needs, and writes a structured `next_step` event per
 * extracted item. A separate dispatcher experiment then routes each
 * event into the loop — bug reports become proposal briefs for the
 * patch author, follow-ups become tasks for The Voice, questions
 * become draft replies. This class does not take any action on its
 * own; it only produces next_step events so the rest of the loop has
 * something concrete to chew on.
 *
 * Skip policy
 * -----------
 * - Only analyzes contacts whose DM thread has new inbound messages
 *   since `custom_fields.last_analyzed_at`.
 * - Caps per-tick contact count to bound LLM burn (default 5).
 * - Skips contacts with no message history at all (rare, but happens
 *   when a thread was ingested with no body reads yet).
 *
 * Verdict
 * -------
 * - pass: no contact needed analysis OR all analyses produced no actionable step
 * - warning: one or more next_step events emitted this tick
 * - fail: LLM call errored for >= half the contacts we tried
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';
import {
  BusinessExperiment,
  type BusinessExperimentOptions,
} from '../business-experiment.js';
import type {
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const MINUTE_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 10 * MINUTE_MS;
const DEFAULT_CONTACTS_PER_TICK = 5;
const MESSAGE_WINDOW_HOURS = 72;

export type NextStepType =
  | 'bug_report'
  | 'feature_request'
  | 'question'
  | 'follow_up'
  | 'sentiment'
  | 'nothing';

export type NextStepUrgency = 'high' | 'medium' | 'low';
export type NextStepStatus = 'open' | 'dispatched' | 'shipped' | 'ignored';

export interface NextStepPayload {
  step_type: NextStepType;
  urgency: NextStepUrgency;
  text: string;
  /** High-level action the loop should take. Instruction-style: "Send
   * a follow-up asking about the beat they lost." NOT a DM body. */
  suggested_action: string;
  /** Actual first-person message ready to send as a DM to the contact.
   * Empty string for non-reply step types (bug_report, nothing, etc.). */
  draft_reply?: string;
  status: NextStepStatus;
  source_message_ids?: string[];
}

interface AnalystCandidate {
  contactId: string;
  contactName: string;
  contactCustomFields: Record<string, unknown>;
  conversationPair: string;
  lastInboundAt: string;
  lastAnalyzedAt: string | null;
  messages: Array<{ id: string; direction: string; text: string | null; observedAt: string }>;
  recentEventKinds: string[];
}

export class ContactConversationAnalystExperiment extends BusinessExperiment {
  id = 'contact-conversation-analyst';
  name = 'Contact conversation analyst';
  category: ExperimentCategory = 'dm_intel';
  hypothesis =
    'Inbound DMs contain actionable asks (bug reports, feature requests, '
    + 'follow-up needs) that the autonomous loop can only act on if they are '
    + 'extracted into structured next_step events. Running an LLM pass per '
    + 'contact with new messages produces those events idempotently.';
  cadence: ExperimentCadence = {
    everyMs: DEFAULT_INTERVAL_MS,
    runOnBoot: true,
  };

  private readonly maxContactsPerTick: number;

  constructor(opts: BusinessExperimentOptions & { maxContactsPerTick?: number } = {}) {
    super(opts);
    this.maxContactsPerTick = opts.maxContactsPerTick ?? DEFAULT_CONTACTS_PER_TICK;
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    if (!ctx.engine?.modelRouter) {
      return {
        subject: 'analyst',
        summary: 'skipped: model router unavailable',
        evidence: { skipped_reason: 'no_model_router' },
      };
    }

    const candidates = await this.pickCandidates(ctx.db, ctx.workspaceId);
    if (candidates.length === 0) {
      return {
        subject: 'analyst',
        summary: 'no contacts with fresh inbound messages to analyze',
        evidence: { analyzed: 0, skipped: 0, steps_emitted: 0 },
      };
    }

    let analyzed = 0;
    let llmErrors = 0;
    let stepsEmitted = 0;
    const perContact: Array<{
      contactId: string;
      contactName: string;
      stepsEmitted: number;
      stepTypes: string[];
      error?: string;
    }> = [];

    for (const candidate of candidates) {
      const outcome = await this.analyzeContact(ctx, candidate);
      analyzed++;
      if (outcome.error) {
        llmErrors++;
        perContact.push({ contactId: candidate.contactId, contactName: candidate.contactName, stepsEmitted: 0, stepTypes: [], error: outcome.error });
      } else {
        stepsEmitted += outcome.stepsEmitted;
        perContact.push({
          contactId: candidate.contactId,
          contactName: candidate.contactName,
          stepsEmitted: outcome.stepsEmitted,
          stepTypes: outcome.stepTypes,
        });
      }
      // Stamp last_analyzed_at regardless — if we failed, we don't
      // retry this tick. The contact will re-qualify when a new
      // inbound message arrives.
      try {
        await this.stampLastAnalyzed(ctx.db, candidate);
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : err, contactId: candidate.contactId },
          '[contact-conversation-analyst] stamp failed',
        );
      }
    }

    return {
      subject: 'analyst',
      summary:
        `analyzed ${analyzed} contact${analyzed === 1 ? '' : 's'}; emitted ${stepsEmitted} next_step event${stepsEmitted === 1 ? '' : 's'}`
        + (llmErrors > 0 ? ` (${llmErrors} llm error${llmErrors === 1 ? '' : 's'})` : ''),
      evidence: {
        analyzed,
        steps_emitted: stepsEmitted,
        llm_errors: llmErrors,
        per_contact: perContact,
      },
    };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as { analyzed?: number; steps_emitted?: number; llm_errors?: number };
    const analyzed = ev.analyzed ?? 0;
    const errors = ev.llm_errors ?? 0;
    const steps = ev.steps_emitted ?? 0;
    if (analyzed > 0 && errors * 2 >= analyzed) return 'fail';
    if (steps > 0) return 'warning';
    return 'pass';
  }

  /**
   * Pick contacts whose DM thread has inbound activity since the last
   * analysis. Keyed by custom_fields.last_analyzed_at so re-analysis
   * is strictly idempotent per message delta.
   */
  private async pickCandidates(db: DatabaseAdapter, workspaceId: string): Promise<AnalystCandidate[]> {
    const rows = await this.loadCandidateRows(db, workspaceId);
    logger.info({ rowCount: rows.length, workspaceId }, '[contact-conversation-analyst] loaded contact rows');
    const candidates: AnalystCandidate[] = [];
    for (const row of rows) {
      if (candidates.length >= this.maxContactsPerTick) break;
      const customFields = parseJson(row.custom_fields);
      const lastAnalyzedAt = typeof customFields.last_analyzed_at === 'string'
        ? customFields.last_analyzed_at
        : null;
      const conversationPair = typeof customFields.x_conversation_pair === 'string'
        ? customFields.x_conversation_pair
        : null;
      if (!conversationPair) {
        logger.info({ contactId: row.id, contactName: row.name }, '[contact-conversation-analyst] skip: no x_conversation_pair');
        continue;
      }

      const lastInboundAt = await this.latestInboundTs(db, workspaceId, conversationPair);
      if (!lastInboundAt) {
        logger.info({ contactId: row.id, conversationPair }, '[contact-conversation-analyst] skip: no inbound messages');
        continue;
      }
      if (lastAnalyzedAt && lastAnalyzedAt >= lastInboundAt) {
        logger.info({ contactId: row.id, lastInboundAt, lastAnalyzedAt }, '[contact-conversation-analyst] skip: already analyzed');
        continue;
      }

      const messages = await this.loadMessages(db, workspaceId, conversationPair);
      if (messages.length === 0) {
        logger.info({ contactId: row.id, conversationPair }, '[contact-conversation-analyst] skip: no recent messages in window');
        continue;
      }
      logger.info({ contactId: row.id, name: row.name, messageCount: messages.length }, '[contact-conversation-analyst] picked');

      const recentEventKinds = await this.loadRecentEventKinds(db, workspaceId, row.id);

      candidates.push({
        contactId: row.id,
        contactName: row.name,
        contactCustomFields: customFields,
        conversationPair,
        lastInboundAt,
        lastAnalyzedAt,
        messages,
        recentEventKinds,
      });
    }
    return candidates;
  }

  private async loadCandidateRows(
    db: DatabaseAdapter,
    workspaceId: string,
  ): Promise<Array<{ id: string; name: string; custom_fields: string | null }>> {
    const { data } = await db
      .from<{ id: string; name: string; custom_fields: string | null }>('agent_workforce_contacts')
      .select('id, name, custom_fields')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(50);
    return (data as Array<{ id: string; name: string; custom_fields: string | null }> | null) ?? [];
  }

  private async latestInboundTs(
    db: DatabaseAdapter,
    workspaceId: string,
    conversationPair: string,
  ): Promise<string | null> {
    try {
      const { data } = await db
        .from<{ observed_at: string }>('x_dm_messages')
        .select('observed_at')
        .eq('workspace_id', workspaceId)
        .eq('conversation_pair', conversationPair)
        .eq('direction', 'inbound')
        .order('observed_at', { ascending: false })
        .limit(1);
      const rows = data as Array<{ observed_at: string }> | null;
      return rows && rows.length > 0 ? rows[0].observed_at : null;
    } catch {
      return null;
    }
  }

  private async loadMessages(
    db: DatabaseAdapter,
    workspaceId: string,
    conversationPair: string,
  ): Promise<Array<{ id: string; direction: string; text: string | null; observedAt: string }>> {
    const sinceIso = new Date(Date.now() - MESSAGE_WINDOW_HOURS * 60 * MINUTE_MS).toISOString();
    const { data } = await db
      .from<{ id: string; direction: string; text: string | null; observed_at: string }>('x_dm_messages')
      .select('id, direction, text, observed_at')
      .eq('workspace_id', workspaceId)
      .eq('conversation_pair', conversationPair)
      .gte('observed_at', sinceIso)
      .order('observed_at', { ascending: true })
      .limit(80);
    const rows = data as Array<{ id: string; direction: string; text: string | null; observed_at: string }> | null;
    return (rows ?? []).map(r => ({ id: r.id, direction: r.direction, text: r.text, observedAt: r.observed_at }));
  }

  private async loadRecentEventKinds(
    db: DatabaseAdapter,
    workspaceId: string,
    contactId: string,
  ): Promise<string[]> {
    try {
      const { data } = await db
        .from<{ kind: string | null }>('agent_workforce_contact_events')
        .select('kind')
        .eq('workspace_id', workspaceId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(10);
      const rows = data as Array<{ kind: string | null }> | null;
      return (rows ?? [])
        .map(r => r.kind)
        .filter((k): k is string => !!k);
    } catch {
      return [];
    }
  }

  private async analyzeContact(
    ctx: ExperimentContext,
    candidate: AnalystCandidate,
  ): Promise<{ stepsEmitted: number; stepTypes: string[]; error?: string }> {
    const prompt = renderAnalystPrompt(candidate);
    const imageUrls = collectImageUrls(candidate.messages);

    // Build the LLM call. When the contact shared screenshots, hand the
    // images to a vision-capable model alongside the text so the
    // analyst can understand bugs the user demonstrated visually (e.g.
    // a broken dashboard render) rather than only what they typed.
    const callInput: Parameters<typeof runLlmCall>[1] = imageUrls.length === 0
      ? {
          purpose: 'extraction',
          system: ANALYST_SYSTEM_PROMPT,
          prompt,
          max_tokens: 1200,
          temperature: 0,
        }
      : {
          purpose: 'extraction',
          system: ANALYST_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...imageUrls.slice(0, 4).map(url => ({ type: 'image_url' as const, image_url: { url } })),
              ],
            },
          ],
          max_tokens: 1400,
          temperature: 0,
        };

    const llm = await runLlmCall(
      {
        modelRouter: ctx.engine.modelRouter!,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        experimentId: this.id,
        // Gap 13: contact-conversation-analyst fires on the autonomous
        // experiment-runner cadence. Enroll in the per-workspace daily
        // cap so vision + extraction spend counts toward the operator
        // toasts.
        budget: ctx.engine.getAutonomousBudgetDeps?.(),
      },
      callInput,
    );

    if (!llm.ok) {
      return { stepsEmitted: 0, stepTypes: [], error: llm.error };
    }

    const parsed = parseAnalystJson(llm.data.text);
    if (!parsed.ok) {
      return { stepsEmitted: 0, stepTypes: [], error: parsed.error };
    }

    let emitted = 0;
    const types: string[] = [];
    for (const step of parsed.steps) {
      if (step.step_type === 'nothing') continue;
      // Deduplicate: if an identical open next_step already exists for
      // this contact, don't emit another. Keeps the dispatcher's
      // workload bounded when the analyst runs on overlapping inputs.
      if (await this.hasOpenMatching(ctx.db, ctx.workspaceId, candidate.contactId, step)) continue;
      try {
        await ctx.db.from('agent_workforce_contact_events').insert({
          workspace_id: ctx.workspaceId,
          contact_id: candidate.contactId,
          event_type: 'next_step',
          kind: 'next_step',
          source: 'conversation-analyst',
          title: stepTitle(step),
          description: step.text.slice(0, 500),
          occurred_at: new Date().toISOString(),
          payload: JSON.stringify({
            step_type: step.step_type,
            urgency: step.urgency,
            text: step.text,
            suggested_action: step.suggested_action,
            draft_reply: step.draft_reply,
            status: 'open',
            source_message_ids: step.source_message_ids ?? [],
          } satisfies NextStepPayload),
        });
        emitted++;
        types.push(step.step_type);
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : err, contactId: candidate.contactId, stepType: step.step_type },
          '[contact-conversation-analyst] insert failed',
        );
      }
    }

    return { stepsEmitted: emitted, stepTypes: types };
  }

  private async hasOpenMatching(
    db: DatabaseAdapter,
    workspaceId: string,
    contactId: string,
    step: ParsedStep,
  ): Promise<boolean> {
    try {
      const { data } = await db
        .from<{ payload: string | null }>('agent_workforce_contact_events')
        .select('payload')
        .eq('workspace_id', workspaceId)
        .eq('contact_id', contactId)
        .eq('kind', 'next_step')
        .order('created_at', { ascending: false })
        .limit(20);
      const rows = (data as Array<{ payload: string | null }> | null) ?? [];
      for (const row of rows) {
        const payload = parseJson(row.payload) as Partial<NextStepPayload>;
        if (!payload) continue;
        if (payload.status && payload.status !== 'open' && payload.status !== 'dispatched') continue;
        if (payload.step_type === step.step_type
            && typeof payload.text === 'string'
            && payload.text.slice(0, 60).toLowerCase() === step.text.slice(0, 60).toLowerCase()) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private async stampLastAnalyzed(db: DatabaseAdapter, candidate: AnalystCandidate): Promise<void> {
    const merged = { ...candidate.contactCustomFields, last_analyzed_at: new Date().toISOString() };
    await db.from('agent_workforce_contacts').update({ custom_fields: JSON.stringify(merged) }).eq('id', candidate.contactId);
  }
}

// ---- prompt helpers -----------------------------------------------------

const ANALYST_SYSTEM_PROMPT = `You are a CRM conversation analyst for ohwow.fun (an AI runtime). You read a recent DM thread with a user and extract zero or more actionable next-steps for the ohwow team.

Output a JSON object only (no prose) with shape:
{
  "steps": [
    {
      "step_type": "bug_report" | "feature_request" | "question" | "follow_up" | "sentiment" | "nothing",
      "urgency": "high" | "medium" | "low",
      "text": "<concise summary of what the user said / needs, 1 sentence>",
      "suggested_action": "<one concrete thing ohwow should do, 1 sentence>",
      "draft_reply": "<actual DM-ready message we would send, first person, conversational, <= 280 chars>",
      "source_message_ids": ["<message id 1>", ...]
    }
  ]
}

Rules:
- Extract at most 3 steps. Prefer quality over quantity.
- "bug_report": user reports something broken in ohwow.fun (UI, API, agents, builds). suggested_action names the symptom + probable surface area. draft_reply acknowledges the report + says we're looking at it.
- "feature_request": user asks for capability we don't have. suggested_action proposes a small first step. draft_reply acknowledges + asks one clarifying question if needed.
- "question": user asks us something. suggested_action is the internal plan. draft_reply IS the answer we'd send them.
- "follow_up": conversation went quiet and a nudge would help. suggested_action = "nudge about X". draft_reply IS the nudge (warm, not pushy, references their last topic).
- "sentiment": pure emotion / praise / complaint with no action. draft_reply is a short human acknowledgment (or empty if no reply needed).
- "nothing": the conversation is noise or already resolved. draft_reply MUST be empty string.
- Never invent bugs or features the user did not actually describe.
- text <= 220 chars; suggested_action <= 220 chars; draft_reply <= 280 chars.

draft_reply voice:
- First person from the ohwow team. No "the team will...". Just "I'll take a look" or "Looking into it now."
- Reference something specific the user said — proves you read them.
- No em dashes. No exclamation marks unless they used one. No pitch CTAs ("book a demo", "jump on a call"). No em dashes. Plain language.
- If urgency=high, be explicit that we're on it; if low, keep it casual.`;

function renderAnalystPrompt(c: AnalystCandidate): string {
  const images = collectImageUrls(c.messages);
  const lines = [
    `Contact: ${c.contactName}`,
    `Prior events: ${c.recentEventKinds.length ? c.recentEventKinds.join(', ') : 'none'}`,
    images.length > 0
      ? `Attachments: ${images.length} image(s) attached to this prompt — treat them as part of the conversation (likely screenshots demonstrating a bug or the surface they're using).`
      : ``,
    ``,
    `<messages>`,
    ...c.messages.map(m => {
      const when = m.observedAt;
      const dir = m.direction === 'inbound' ? '→ them' : m.direction === 'outbound' ? '← us' : '?';
      const text = (m.text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 400);
      return `[${m.id}] ${dir} ${when}\n${text}`;
    }),
    `</messages>`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Pulls image URLs out of the poller's "<body>\n[image: url1, url2]"
 * text-column encoding. Keeps the contract text-only so no migration
 * is needed. Audio/video attachments ("[other: ...]") are ignored —
 * vision models can't do anything with them today.
 */
function collectImageUrls(messages: AnalystCandidate['messages']): string[] {
  const urls: string[] = [];
  const re = /\[image:\s*([^\]]+)\]/gi;
  for (const m of messages) {
    if (!m.text) continue;
    let match: RegExpExecArray | null;
    while ((match = re.exec(m.text)) !== null) {
      const list = match[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const u of list) {
        if (!urls.includes(u)) urls.push(u);
      }
    }
    re.lastIndex = 0;
  }
  return urls;
}

interface ParsedStep {
  step_type: NextStepType;
  urgency: NextStepUrgency;
  text: string;
  suggested_action: string;
  draft_reply: string;
  source_message_ids?: string[];
}

function parseAnalystJson(raw: string): { ok: true; steps: ParsedStep[] } | { ok: false; error: string } {
  const trimmed = raw.trim();
  // Some models wrap in fences; strip them.
  const jsonText = extractJsonBlock(trimmed);
  if (!jsonText) return { ok: false, error: 'no JSON block found in output' };
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: `json parse failed: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray((obj as { steps?: unknown }).steps)) {
    return { ok: false, error: 'missing steps array' };
  }
  const rawSteps = (obj as { steps: unknown[] }).steps;
  const steps: ParsedStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const stepType = s.step_type;
    const urgency = s.urgency;
    const text = s.text;
    const action = s.suggested_action;
    const draft = s.draft_reply;
    if (!isNextStepType(stepType)) continue;
    if (!isUrgency(urgency)) continue;
    if (typeof text !== 'string' || text.length === 0) continue;
    if (typeof action !== 'string') continue;
    const ids = Array.isArray(s.source_message_ids)
      ? s.source_message_ids.filter((x): x is string => typeof x === 'string')
      : undefined;
    steps.push({
      step_type: stepType,
      urgency,
      text: text.slice(0, 220),
      suggested_action: action.slice(0, 220),
      draft_reply: typeof draft === 'string' ? draft.slice(0, 280) : '',
      source_message_ids: ids,
    });
  }
  return { ok: true, steps };
}

function extractJsonBlock(s: string): string | null {
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return null;
}

function isNextStepType(v: unknown): v is NextStepType {
  return v === 'bug_report' || v === 'feature_request' || v === 'question'
    || v === 'follow_up' || v === 'sentiment' || v === 'nothing';
}

function isUrgency(v: unknown): v is NextStepUrgency {
  return v === 'high' || v === 'medium' || v === 'low';
}

function parseJson(s: unknown): Record<string, unknown> {
  if (!s) return {};
  // The sqlite adapter auto-deserializes JSON-shaped TEXT columns on
  // SELECT — so callers can hand us either the raw string or an
  // already-parsed object. Normalize both to a plain record.
  if (typeof s === 'object') return s as Record<string, unknown>;
  if (typeof s !== 'string') return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stepTitle(step: ParsedStep): string {
  const type = step.step_type.replace(/_/g, ' ');
  const prefix = step.urgency === 'high' ? '!' : step.urgency === 'medium' ? '·' : ' ';
  return `${prefix} ${type}: ${step.text.slice(0, 80)}`;
}
