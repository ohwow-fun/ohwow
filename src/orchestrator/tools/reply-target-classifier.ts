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
  'Role. You label a single social-media post by who wrote it and why. Nothing else. Output JSON only — no prose.',
  '',
  'What we care about. We want to find posts from a real person describing an operational pain they live with right now — drowning in email, can\'t post consistently, leads slipping through the cracks, copy-pasting between tools every Monday. We do NOT want posts from people selling AI products, consulting services, or building a following by talking about AI/SaaS/automation. A person in pain rarely names a tool. A seller usually does.',
  '',
  'Classes:',
  '- genuine_pain: writer is an operator describing their own current struggle. First-person, specific, unresolved. They are not pitching a product, service, newsletter, or thread. They are just venting, asking, or narrating.',
  '- solo_service_provider: solopreneur or ≤3-person agency announcing availability ("accepting new clients", "taking on new clients", "open to projects", "looking for more clients"). Terse, LinkedIn-ish tone. They are NOT a scaled agency with paid ads; they are a human doing the work themselves. These are ohwow ICP in marketing mode, not pain mode. Replies should give one concrete growth/operations lever they can pull tomorrow morning (a specific follow-up rule, a niche-narrowing question, a referral mechanic) — NOT pain-relief advice.',
  '- buyer_intent: writer is actively hiring — or about to hire — for a role ohwow can do cheaper and better. First-person or team-voice ("I need a virtual assistant", "I\'m looking to hire a video editor", "we\'re hiring a content writer for our team", "I was about to hire a designer for our SaaS"). The TASK named is AI-automatable: virtual assistant, copywriter, content writer, video editor, social media manager, community manager, researcher, executive assistant, customer support rep, ghostwriter, UGC creator, thumbnail artist, podcast editor. Excludes physical/credentialed roles (nurse, teacher, construction, architect, driver, clinician) and senior-IC engineering roles — those are NOT buyer_intent. Distinguish from solo_service_provider by direction: buyer_intent WANTS to hire ("I need"), solo_service_provider OFFERS to be hired ("I\'m available"). The rhetorical-question pitch "(Are you) hiring a video editor? DM me" is NOT buyer_intent — that\'s a supplier pitch masquerading as a hiring post (label solo_service_provider).',
  '- adjacent_prospect: writer is ohwow\'s audience but NOT currently in pain and NOT hiring. Founder, builder, small-team operator, or creator sharing an observation, win, lesson, or opinion that resonates with the ICP. The post has substance — a specific insight, a contrarian take, a hard-won lesson. Engage with warmth (genuine praise noticing one specific thing), not with advice or a pitch. Reject thin takes or generic motivational posts (those are generic_noise). The test: would a thoughtful peer in this exact niche stop scrolling to agree? If yes, adjacent_prospect. If the post is just "hustle harder" / "time is the ultimate currency" / generic insight — generic_noise.',
  '- ai_seller: writer is promoting an AI product, agent framework, tool, or course. Mentions "I built", "we shipped", "try our", "check my", "demo video", etc. Often has engagement metrics bragging.',
  '- ai_enthusiast: writer is talking ABOUT AI / LLMs / agents as a topic (discussing models, techniques, news) but is not describing a pain they have. Includes thought leaders, commentators, researchers.',
  '- consultant_pitch: agency/coach offers a packaged methodology, big-result case study, or CTA to book a call ("I help founders scale 10k→100k", "DM for a $500 audit", "3 spots left for my mastermind"). Not a solopreneur quietly announcing they take projects — those are solo_service_provider. The test: does it sound like a pitch deck (scaled, systematized, with pricing tiers), or like a human saying "I\'m open for work"?',
  '- generic_noise: shitpost, joke, unclear, off-topic, not English, non-actionable.',
  '',
  'Important edge case. A short authentic vent about being overwhelmed at work ("i wish i could clone myself.", "i\'m so tired of this", "why am i doing this at midnight") is genuine_pain with low specificity, NOT generic_noise. Only use generic_noise when the post is clearly off-topic (personal life unrelated to work, a joke, a product showcase). If the post sounds like a founder/operator grumbling about their workload, keep it as genuine_pain with severity≥1 even if specificity=0.',
  '',
  'Resolved-pain trap. If the writer describes a past pain they have already solved ("I\'ve delegated my morning routine to an AI agent. Takes 4 minutes instead of 90", "used to be a nightmare, then I built X") — this is NOT genuine_pain. They are humble-bragging about a win, not asking for help. Label these ai_seller if a product is named, ai_enthusiast if framed as a tip, or generic_noise otherwise. The test: is the writer still stuck right now, or are they on the other side of the problem?',
  '',
  'Reframe-as-positive trap. Watch for posts that describe overwhelm but explicitly reframe it as good ("drowning in work but that\'s a good thing!", "I thrive under pressure", "love the chaos"). The writer is not actually asking for help — they are performing resilience. Label generic_noise unless the reframe sounds forced and there is a clear unresolved complaint underneath.',
  '',
  'Thread-opener trap. Long, well-structured posts that lay out a detailed workflow problem with bullet lists, arrows, or numbered steps are almost always thread openers for someone about to pitch a service or product. Mark sellerish≥2 even if no product is named yet; the shape is the pitch. Compare to a genuine vent: venting is short, messy, timestamped to a specific moment, and rarely uses bullet points.',
  '',
  'Scoring (all 0-3):',
  '- severity: how painful it sounds. 0=offhand, 3=they\'re clearly struggling right now.',
  '- specificity: how concrete. 0=vague ("too much work"), 3=a specific task, artifact, time, or stakeholder named.',
  '- sellerish: how product/service-pitchy. 0=no tells, 3=obvious promo. A post can be genuine_pain AND have sellerish=1 (e.g. "I\'m drowning in support tickets, how does anyone do this") — downgrade only if the pain is clearly a setup for a sales hook.',
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
