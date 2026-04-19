/**
 * reply-target-classifier.ts — LLM-backed pain-vs-seller classifier for
 * reply targets. Runs between `pickReplyTargets` (filter+score) and
 * `generateReplyCopy` (draft) so that the scheduler only spends Sonnet
 * tokens on posts that actually match ohwow's ICP.
 *
 * Why this exists: generic topic-keyword matching (the legacy path) lets
 * AI sellers and consultant-pitches through the gate. A cheap Haiku-class
 * classifier can distinguish an overwhelmed operator from someone
 * promoting a course — the sandbox at scripts/x-experiments/pain-finder.mjs
 * converged this rubric after ~15 one-by-one query tests.
 *
 * Reply modes:
 *   - direct: 1:1 reply to a real operator (genuine_pain or
 *     solo_service_provider). Goes through this classifier.
 *   - viral: broadcast reply into a crowded ICP-packed thread. The
 *     engagement floor + viral-topic phrase already pre-qualify; this
 *     classifier auto-stamps `viral_piggyback` with a synthetic verdict.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';
import type { ReplyCandidate } from './reply-target-selector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReplyClassifierClass =
  | 'genuine_pain'
  | 'solo_service_provider'
  | 'buyer_intent'
  | 'adjacent_prospect'
  | 'viral_piggyback'
  | 'ai_seller'
  | 'ai_enthusiast'
  | 'consultant_pitch'
  | 'generic_noise'
  | 'error';

export type ReplyPainDomain =
  | 'inbox'
  | 'sales'
  | 'content'
  | 'ops'
  | 'support'
  | 'admin'
  | null;

export interface ReplyClassifierVerdict {
  class: ReplyClassifierClass;
  pain_domain: ReplyPainDomain;
  severity: number;      // 0..3
  specificity: number;   // 0..3
  sellerish: number;     // 0..3
  rationale: string;
}

export interface ClassifyDeps {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
}

/**
 * Per-class sellerish cap. Pain vents must not be pitchy (sellerish<=1)
 * because sellerish>=2 means the vent is a sales setup. Service-provider
 * posts are inherently promotional (they name their service + include
 * DM/link CTAs); classifier honestly labels them sellerish=2-3, so we
 * allow them up to 3. Viral posts skip this gate entirely.
 */
const SELLERISH_CAP: Record<ReplyClassifierClass, number> = {
  genuine_pain: 1,
  solo_service_provider: 3,
  // buyer_intent posts often read as sellerish=2 because they describe
  // a concrete deliverable + contact info ("send your portfolio to X").
  // That's the buyer specifying what they want, not a seller pitching.
  // Allow up to 3.
  buyer_intent: 3,
  // adjacent_prospect posts by founders/creators frequently include a
  // natural dose of self-reference (their own win, their own take).
  // Cap at 2 so we don't engage with outright promo while keeping the
  // normal insight voice.
  adjacent_prospect: 2,
  viral_piggyback: 3,
  ai_seller: -1,
  ai_enthusiast: -1,
  consultant_pitch: -1,
  generic_noise: -1,
  error: -1,
};

export function isKeeper(v: ReplyClassifierVerdict | null | undefined): boolean {
  if (!v) return false;
  const cap = SELLERISH_CAP[v.class];
  if (cap < 0) return false;
  return (v.sellerish ?? 0) <= cap;
}

/** Synthetic verdict stamped on viral-mode posts (classifier skipped). */
export function viralPiggybackVerdict(candidate: ReplyCandidate): ReplyClassifierVerdict {
  return {
    class: 'viral_piggyback',
    pain_domain: null,
    severity: 2,
    specificity: 2,
    sellerish: 0,
    rationale: '(viral mode: engagement floor + phrase gate passed, classifier skipped)',
  };
}

// ---------------------------------------------------------------------------
// Classifier system prompt (embedded — sandbox-validated rubric)
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM_PROMPT = [
  'Role. You label a single social-media post by who wrote it and why. Output JSON only — no surrounding prose.',
  '',
  'First principles — money direction and role-holder identity. The classes below distinguish posts primarily by which direction money is moving (or would move) between the author and the work in question, and whether the author currently holds the role that does the work.',
  '',
  '- buyer_intent: the author holds a budget and is moving money OUT to have a specific piece of work done — work that ohwow can perform. They have already decided the task is worth paying for; they are asking who should do it, not whether to do it. The scoped task must fall within the AI-automatable role classes named below (virtual-assistant class, editor class, copywriter class, researcher class, support class, social / community class, or similar back-office knowledge-work categories). Exclude roles that require a physical body on-site, a licensed or credentialed practitioner, or a senior-IC technical hire — those are not buyer_intent because ohwow cannot fulfill the role. Distinguish from solo_service_provider by direction: buyer_intent is the author WANTING to hire; solo_service_provider is the author OFFERING to be hired. A rhetorical-question pitch in which the author says they are open for the work is a supplier pitch, not a hiring post — label solo_service_provider.',
  '',
  '- solo_service_provider: the author is moving money IN by offering their own labor for the same kind of work ohwow performs. Solopreneur or very small agency announcing availability, open for projects, taking on clients. They ARE the role-holder; engaging them pits ohwow against the exact person we would otherwise serve.',
  '',
  '- genuine_pain: no money is flowing in either direction. The author is venting an unresolved operational frustration they live with right now. No role has been scoped, no budget has been named, no decision to pay for relief has been made. First-person, specific to their own current struggle, not a thread-opener setting up a pitch.',
  '',
  '- adjacent_prospect: the author is an ICP-shaped peer making an observation about work, tools, or operating philosophy. Not hiring, not venting, not pitching. The post has substance — a specific insight, a contrarian take, a hard-won lesson in a form a thoughtful peer in this niche would stop for. Thin takes and generic motivational one-liners are not adjacent_prospect; they are generic_noise.',
  '',
  '- ai_seller: the author is promoting an AI product, agent framework, tool, or course they or their company ship. The post\'s purpose is to route attention toward a product surface.',
  '',
  '- ai_enthusiast: the author is talking ABOUT AI / LLMs / agents as a topic (models, techniques, industry news) but is not describing a pain they have and is not pitching a specific product of their own.',
  '',
  '- consultant_pitch: agency or coach offering a packaged methodology, big-result case study, or CTA to book a call. The shape is a pitch deck (scaled, systematized, with pricing or packages), not a human quietly announcing they are open for work. Solopreneurs in the quiet-availability shape are solo_service_provider, not consultant_pitch.',
  '',
  '- generic_noise: shitpost, joke, unclear, off-topic, not English, non-actionable.',
  '',
  'AI-automatable role classes (buyer_intent gate). The author holds the budget; the scoped work must fall into one of these role categories for the post to qualify as buyer_intent:',
  '  - virtual-assistant class: generalist back-office support, calendar, inbox triage, scheduling, admin.',
  '  - editor class: video editor, podcast editor, thumbnail artist, audio cleanup.',
  '  - copywriter / content class: copywriter, content writer, ghostwriter, newsletter writer, blog writer.',
  '  - researcher / analyst class: market research, desk research, summarization, information synthesis.',
  '  - social / community class: social-media manager, community manager, UGC creator, engagement operator.',
  '  - support class: customer-support rep, ticket handler, help-desk generalist.',
  '  - executive-assistant class: chief-of-staff-lite support for a founder or operator.',
  'Work outside these classes (physical / on-site, licensed / credentialed, senior-IC engineering, regulated practitioner) is not a buyer_intent fit even when a hiring verb is present.',
  '',
  'Edge case — short authentic overwhelm. A brief unguarded vent about being swamped at work is genuine_pain with low specificity, not generic_noise. Only use generic_noise when the post is off-topic, a joke, or unrelated to operating work. If the author sounds like a founder or operator grumbling about their workload, keep it as genuine_pain with severity≥1 even when specificity=0.',
  '',
  'Resolved-pain trap. If the author describes a past pain they have already solved — they are on the other side of the problem, narrating the solution — this is NOT genuine_pain. They are sharing a win, not asking for help. Label ai_seller when a product is named as the solution, ai_enthusiast when the framing is a general tip without a named product, generic_noise otherwise. The test is whether the author is still stuck right now or has moved past the problem.',
  '',
  'Reframe-as-positive trap. Posts that describe overwhelm but explicitly reframe it as desirable are performing resilience, not asking for help. Label generic_noise unless the reframe is forced thin over a clear unresolved complaint underneath.',
  '',
  'Thread-opener trap. Long, well-structured posts that lay out a detailed workflow problem with bullet lists, arrows, or numbered steps are almost always thread openers setting up a pitch. Mark sellerish≥2 even when no product is named yet; the shape is the pitch. Genuine vents are short, messy, timestamped to a specific moment, and do not use bullet structure.',
  '',
  'Mass-hiring-spam trap. A post that lists multiple unrelated role categories in one message (e.g. typing + logo design + translation + content writing + virtual assistant all at once), pairs them with a suspiciously wide budget range (a five-to-ten-fold spread like "$500-$5500"), advertises open-to-all-countries availability, promises a "2-4 day" turnaround, or uses phrasing like "my office is looking for new people / message me to apply" with no company name, is an engagement-farming or pink-slime hiring spam shape — not a real buyer. Label generic_noise regardless of how many hiring verbs appear. Real buyers hire for one role at a time and name their company or context.',
  '',
  'Giveaway-bait trap. A post that leads with a giveaway, free-money, cash-app, or airdrop hook (e.g. the Tagalog "Dahil pumuso ka may Gcash ka" lead-in, English "free Gcash", "win $X", crypto-airdrop framing) before stating a hiring ask is using the hiring line as a lure to farm engagement with the giveaway. The author is not hiring; they are gaming replies. Label generic_noise.',
  '',
  'Tutorial-request trap. Posts where the author asks the community to TEACH them or SHOW them how to do something ("teach me how to", "can someone show me", "any help is appreciated", "I want to learn", "I need someone to teach me") are asking for free community help, not paying for the work — even when the phrasing includes "I need someone". The poster is not a budget-holder commissioning the task. Label genuine_pain at most; never buyer_intent.',
  '',
  'Recruiter-middleman trap. Posts that name a specific third-party company as the employer and direct applications to a company email/portal ("apply: email teams@companyname.com", "Utopia Brands is hiring", "Suvora Tech is looking for"), or are posted from an account that consistently reposts other companies\' roles, are staffing agents posting on behalf — they do not hold the budget themselves and cannot buy ohwow. Label generic_noise. A founder or operator hiring for their own team speaks in first person about their own work ("I need a VA for my business", "we\'re hiring our first editor") with no third-party company named.',
  '',
  'Scoring (all 0-3):',
  '- severity: how painful the situation sounds. 0=offhand, 3=clearly struggling right now.',
  '- specificity: how concrete the post is. 0=vague, 3=a specific task, artifact, time, or stakeholder is named.',
  '- sellerish: how product/service-pitchy the post is. 0=no tells, 3=obvious promo. A genuine-pain vent can still read sellerish=1; downgrade only when the pain is clearly a setup for a sales hook.',
  '',
  'pain_domain (pick one or null): inbox | sales | content | ops | support | admin | null',
  '',
  'Output JSON only, no surrounding prose:',
  '{ "class": "...", "pain_domain": "...", "severity": 0-3, "specificity": 0-3, "sellerish": 0-3, "rationale": "one short sentence" }',
].join('\n');

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

function parseVerdict(raw: string): ReplyClassifierVerdict | null {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return null;
  }

  const classVal = typeof obj.class === 'string' ? obj.class : null;
  const validClasses: ReplyClassifierClass[] = [
    'genuine_pain', 'solo_service_provider', 'buyer_intent', 'adjacent_prospect',
    'viral_piggyback',
    'ai_seller', 'ai_enthusiast', 'consultant_pitch', 'generic_noise',
  ];
  if (!classVal || !validClasses.includes(classVal as ReplyClassifierClass)) return null;

  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 0;
  };
  const domainVal = typeof obj.pain_domain === 'string' ? obj.pain_domain : null;
  const validDomains: Array<ReplyPainDomain> = ['inbox', 'sales', 'content', 'ops', 'support', 'admin', null];
  const pain_domain: ReplyPainDomain =
    domainVal && validDomains.includes(domainVal as ReplyPainDomain)
      ? (domainVal as ReplyPainDomain)
      : null;

  return {
    class: classVal as ReplyClassifierClass,
    pain_domain,
    severity: num(obj.severity),
    specificity: num(obj.specificity),
    sellerish: num(obj.sellerish),
    rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 400) : '',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifyReplyTarget(
  deps: ClassifyDeps,
  candidate: ReplyCandidate,
): Promise<ReplyClassifierVerdict> {
  if (!deps.engine.modelRouter) {
    return { class: 'error', pain_domain: null, severity: 0, specificity: 0, sellerish: 0, rationale: 'modelRouter not available' };
  }

  const user = [
    `POST AUTHOR: @${candidate.authorHandle}`,
    `POST METRICS: likes=${candidate.likes ?? 0} replies=${candidate.replies ?? 0}`,
    `POST TEXT:`,
    '"""',
    (candidate.text || '').slice(0, 1200),
    '"""',
    '',
    'Output JSON only.',
  ].join('\n');

  const llm = await runLlmCall(
    {
      modelRouter: deps.engine.modelRouter,
      db: deps.db,
      workspaceId: deps.workspaceId,
      budget: deps.engine.getAutonomousBudgetDeps?.(),
    },
    {
      purpose: 'simple_classification',
      system: CLASSIFIER_SYSTEM_PROMPT,
      prompt: user,
      prefer_model: 'claude-haiku-4-5',
      max_tokens: 300,
      temperature: 0.1,
    },
  );

  if (!llm.ok) {
    logger.warn({ err: llm.error, handle: candidate.authorHandle }, '[reply-classifier] llm call failed');
    return { class: 'error', pain_domain: null, severity: 0, specificity: 0, sellerish: 0, rationale: String(llm.error).slice(0, 200) };
  }

  const verdict = parseVerdict(llm.data.text);
  if (!verdict) {
    logger.info({ handle: candidate.authorHandle, raw: llm.data.text.slice(0, 200) }, '[reply-classifier] could not parse verdict');
    return { class: 'error', pain_domain: null, severity: 0, specificity: 0, sellerish: 0, rationale: 'unparseable LLM output' };
  }
  return verdict;
}

/**
 * Classify candidates in parallel batches. Default concurrency 8 —
 * Haiku latency is the bottleneck; serial calls made each pain-finder
 * run take minutes.
 */
export async function classifyReplyTargetsBatch(
  deps: ClassifyDeps,
  candidates: ReadonlyArray<ReplyCandidate>,
  concurrency = 8,
): Promise<ReplyClassifierVerdict[]> {
  const results: ReplyClassifierVerdict[] = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i += concurrency) {
    const slice = candidates.slice(i, i + concurrency);
    const verdicts = await Promise.all(slice.map((c) => classifyReplyTarget(deps, c)));
    for (let j = 0; j < verdicts.length; j++) {
      results[i + j] = verdicts[j];
    }
  }
  return results;
}
