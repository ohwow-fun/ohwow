/**
 * Lead-qualification rubric runner.
 *
 * Two stages:
 *
 *   1. freeGates(rubric, row)  → { decision: 'pass' | 'reject', reason }
 *      Zero-cost filter over ledger-row data: score floor, engagement
 *      minimums, bucket allowlist, touches threshold, engager-source
 *      boost (reply-on-own-post lowers the score floor).
 *
 *   2. classifyIntent(row, rubric, llmFn) → { intent, confidence, reason }
 *      One LLM call (purpose='simple_classification') per author that
 *      passed freeGates. Returns buyer_intent | builder_curiosity |
 *      adjacent_noise with a confidence 0..1.
 *
 * The rubric is plain data loaded from the workspace's
 * lead-gen-config.json (or the generic example). Functions are pure
 * except classifyIntent which takes an injected llmFn for testability.
 */

export function loadLeadGenConfig(workspace, { fs, os, path, logger = console }) {
  const priv = path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'lead-gen-config.json');
  if (fs.existsSync(priv)) return JSON.parse(fs.readFileSync(priv, 'utf8'));
  const example = path.resolve('scripts/x-experiments/lead-gen-config.example.json');
  logger.warn?.(`[lead-gen] no private config at ${priv}, falling back to example (placeholders!)`);
  return JSON.parse(fs.readFileSync(example, 'utf8'));
}

/**
 * Pure free-gate cascade. Returns {decision, reason} where decision is
 * 'pass' (author is eligible for paid intent classification) or 'reject'.
 */
export function freeGates(rubric, row) {
  const gates = rubric?.freeGates || {};
  const engagerBoost = gates.engagerBoost || {};
  const sources = row.sources || [];
  const isEngager = sources.some(s =>
    s === 'dm' || (typeof s === 'string' && s.startsWith('engager:'))
  );

  const baseMinScore = typeof gates.minScore === 'number' ? gates.minScore : 0;
  const boostedMinScore = isEngager && typeof engagerBoost.ownPostReplyReducesMinScoreTo === 'number'
    ? Math.min(baseMinScore, engagerBoost.ownPostReplyReducesMinScoreTo)
    : baseMinScore;

  if ((row.score ?? 0) < boostedMinScore) {
    return { decision: 'reject', reason: `score ${row.score ?? 0} < ${boostedMinScore}` };
  }

  if (typeof gates.minReplies === 'number' && (row.replies ?? 0) < gates.minReplies) {
    return { decision: 'reject', reason: `replies ${row.replies ?? 0} < ${gates.minReplies}` };
  }

  if (typeof gates.minLikes === 'number' && (row.likes ?? 0) < gates.minLikes) {
    return { decision: 'reject', reason: `likes ${row.likes ?? 0} < ${gates.minLikes}` };
  }

  if (typeof gates.minTouches === 'number' && (row.touches ?? 0) < gates.minTouches) {
    return { decision: 'reject', reason: `touches ${row.touches ?? 0} < ${gates.minTouches}` };
  }

  if (Array.isArray(gates.allowedBuckets) && gates.allowedBuckets.length > 0) {
    if (!row.bucket || !gates.allowedBuckets.includes(row.bucket)) {
      return { decision: 'reject', reason: `bucket ${row.bucket} not in allowlist` };
    }
  }

  return { decision: 'pass', reason: isEngager ? 'engager-boost' : 'free-gates-pass' };
}

/**
 * Ask the model whether an author is a buyer, a curious builder, or
 * noise. Returns { intent, confidence, reason } where intent is one of
 * the rubric's accepted classes or 'adjacent_noise'.
 *
 * The caller is expected to have already decided via freeGates() that
 * this call is worth spending.
 *
 * **Row MUST carry `post_text`** (the contact's actual tweet body, from
 * ohwow_fetch_x_post / fetch-tweet) for a meaningful classification. When
 * it's missing, this function returns `adjacent_noise` with
 * reason='no_post_text' WITHOUT calling the LLM — because with only
 * handle + tags + bucket the model has nothing to ground on and will
 * hallucinate a buyer_intent reason that matches the ICP blurb. That was
 * the 11th-pass Shann³ misqualification: classifier returned "Builder
 * mentions tired of Zapier..." for a post that was actually about AI
 * knowledge layers; the "Zapier" language came from the ICP description,
 * not her words.
 *
 * Author business_label (from `user.highlighted_label.description` on
 * the syndication payload — e.g. "Lunar Strategy") is included in the
 * prompt when present. The model is instructed to route agency/firm
 * labels through the disqualifier path directly, because they're a
 * stronger signal than any post text tone.
 */
export async function classifyIntent(row, rubric, llmFn, { extractJson } = {}) {
  const icp = rubric?.icp || {};
  const postText = typeof row?.post_text === 'string' ? row.post_text.trim() : '';
  const businessLabel = typeof row?.business_label === 'string' && row.business_label.length > 0
    ? row.business_label
    : null;

  // Without post text we can't responsibly classify. Return adjacent_noise
  // with a named reason so the upstream classifier audit log records the
  // miss — re-qualification can retry once post text is fetchable.
  if (!postText) {
    return {
      intent: 'adjacent_noise',
      confidence: 0,
      reason: 'no_post_text: classifier needs the tweet body to avoid hallucinating an ICP match',
    };
  }

  const prompt = [
    `You classify buyer intent for inbound outreach.`,
    ``,
    `Who we sell to:`,
    `${icp.description || 'builders and founders shipping AI-adjacent products'}`,
    ``,
    icp.disqualifiers?.length ? `Hard disqualifiers (route these to adjacent_noise regardless of post tone): ${icp.disqualifiers.join('; ')}` : '',
    ``,
    businessLabel ? `This account's X business-label is "${businessLabel}". If that label names an agency, growth firm, services shop, or any org that sells to our ICP rather than being our ICP, return adjacent_noise with reason='agency_or_vendor: <label>'.` : '',
    ``,
    `Classify the X author below into exactly one of:`,
    `- buyer_intent: this specific post contains a pain / problem / "I wish there was" signal aligned with our ICP. Quote the exact phrase from the post in the reason.`,
    `- builder_curiosity: the post shows engagement with our space but is not a buying signal (teaching, hot take, general musing).`,
    `- adjacent_noise: off-ICP, content-marketing / thought-leadership voice, agency / vendor account, bot, low-signal, or hits a disqualifier.`,
    ``,
    `CRITICAL: base the decision on what the author WROTE in the post below. Do NOT infer pain from the ICP description or tags. If the post doesn't literally contain an ICP-pain phrase, it is not buyer_intent.`,
    ``,
    `Author:`,
    `  handle: ${row.handle}`,
    `  display_name: ${row.display_name || '(none)'}`,
    businessLabel ? `  business_label: ${businessLabel}` : '',
    `  bucket: ${row.bucket || '(none)'}`,
    `  score: ${row.score ?? 0}`,
    `  replies observed: ${row.replies ?? 0}`,
    `  likes observed: ${row.likes ?? 0}`,
    `  tags: ${(row.tags || []).join(', ') || '(none)'}`,
    `  sources: ${(row.sources || []).join(', ') || '(none)'}`,
    ``,
    `Post (verbatim):`,
    `"""`,
    postText,
    `"""`,
    ``,
    `Reply with strict JSON: {"intent":"buyer_intent|builder_curiosity|adjacent_noise","confidence":0..1,"reason":"<=25 words; for buyer_intent include an exact quoted phrase from the post"}`,
  ].filter(Boolean).join('\n');

  const out = await llmFn({ purpose: 'simple_classification', prompt });
  const text = typeof out === 'string' ? out : (out?.text ?? out?.output ?? '');
  const parsed = extractJson ? extractJson(text) : JSON.parse(text);
  const intent = ['buyer_intent', 'builder_curiosity', 'adjacent_noise'].includes(parsed.intent)
    ? parsed.intent
    : 'adjacent_noise';
  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;
  return { intent, confidence, reason: String(parsed.reason || '').slice(0, 200) };
}

/**
 * Does the intent classifier's verdict pass the rubric's acceptance
 * threshold? Pure, for testability.
 */
export function acceptsIntent(intent, rubric) {
  const ic = rubric?.intentClassifier || {};
  const acceptClasses = Array.isArray(ic.acceptClasses) && ic.acceptClasses.length > 0
    ? ic.acceptClasses
    : ['buyer_intent'];
  const minConfidence = typeof ic.minConfidence === 'number' ? ic.minConfidence : 0.7;
  return acceptClasses.includes(intent.intent) && intent.confidence >= minConfidence;
}

/**
 * Read the approval queue and return a Set of lowercased handles that
 * already have an `x_contact_create` entry in a non-rejected state.
 * These handles should NOT be re-classified on a subsequent run:
 *
 *   - pending / approved / applied / auto_applied → the classifier
 *     already ran for this handle; re-classifying risks the model
 *     returning a different verdict for identical input (observed
 *     2026-04-16 with @analogdreamdev flipping buyer_intent→builder_
 *     curiosity 7 minutes apart). Re-running also burns one simple_
 *     classification LLM call per handle per hourly pass, which adds
 *     up across a stable audience.
 *   - rejected → skip the skip: the operator explicitly said no, so
 *     don't re-propose, but if their signal improves (bucket flip,
 *     score bump) the downstream free-gate + CRM-dedup gates are the
 *     right place to decide whether to reconsider, not this cache.
 *     Treating rejected as an auto-skip would permanently lock out
 *     anyone the operator once bounced.
 *
 * Asymmetric on purpose: cache positives, not negatives. Returns an
 * empty set on any read failure — this helper never wedges the loop.
 */
export function loadProposedHandles(workspace, { loadQueue } = {}) {
  if (typeof loadQueue !== 'function') return new Set();
  let queue;
  try {
    queue = loadQueue(workspace);
  } catch {
    return new Set();
  }
  const skipStatuses = new Set(['pending', 'approved', 'applied', 'auto_applied']);
  const out = new Set();
  for (const entry of queue || []) {
    if (!entry || entry.kind !== 'x_contact_create') continue;
    if (!skipStatuses.has(entry.status)) continue;
    const handle = entry.payload?.handle;
    if (typeof handle === 'string' && handle.length > 0) {
      out.add(handle.toLowerCase());
    }
  }
  return out;
}

/**
 * Auto-approve gate for x_contact_create proposals. Returns a function
 * that propose() invokes (only when its trust check passes) to decide
 * whether a candidate skips the human queue.
 *
 * Wired with `autoApproveAfter: 0` + `bucketBy: 'bucket'` +
 * `maxPriorRejected: 0`, so a single human rejection within a bucket
 * pauses auto-apply for that bucket until explicitly re-approved.
 *
 * Reads `rubric.autoApprove`:
 *   - enabled (default true if block exists, else gate always returns
 *     false — opt-in via config)
 *   - minConfidence (default 0.85)
 *   - minScore (default 0.7)
 *   - allowedBuckets (default ['market_signal'])
 *   - acceptIntents (default ['buyer_intent'])
 *   - dailyCap (default 5) — counts cross-run via the queue snapshot
 *
 * runState: { thisRunAutoApplied: number } — caller increments after
 * each propose() returns auto_applied. Pure-ish: gate reads but does
 * not mutate runState, keeping the side-effect at the call site.
 */
export function buildAutoApproveGate(rubric, workspace, runState, {
  loadQueue,
  now = Date.now,
} = {}) {
  const auto = rubric?.autoApprove;
  if (!auto || auto.enabled === false) {
    return () => false;
  }

  const minConfidence = typeof auto.minConfidence === 'number' ? auto.minConfidence : 0.85;
  const minScore = typeof auto.minScore === 'number' ? auto.minScore : 0.7;
  const allowedBuckets = Array.isArray(auto.allowedBuckets) && auto.allowedBuckets.length > 0
    ? auto.allowedBuckets
    : ['market_signal'];
  const acceptIntents = Array.isArray(auto.acceptIntents) && auto.acceptIntents.length > 0
    ? auto.acceptIntents
    : ['buyer_intent'];
  const dailyCap = typeof auto.dailyCap === 'number' ? auto.dailyCap : 5;

  // Cross-run baseline: today's already-auto-applied x_contact_create
  // entries from the queue. Snapshot once at gate construction.
  const today = new Date(now()).toISOString().slice(0, 10);
  let todayCount = 0;
  if (typeof loadQueue === 'function') {
    try {
      const queue = loadQueue(workspace);
      todayCount = queue.filter(e =>
        e?.kind === 'x_contact_create' &&
        e?.status === 'auto_applied' &&
        typeof e?.ts === 'string' &&
        e.ts.slice(0, 10) === today
      ).length;
    } catch {
      todayCount = 0;
    }
  }

  return (_kind, payload) => {
    if (!payload) return false;
    if (!acceptIntents.includes(payload.intent)) return false;
    if (!allowedBuckets.includes(payload.bucket)) return false;
    if ((payload.confidence ?? 0) < minConfidence) return false;
    if ((payload.score ?? 0) < minScore) return false;
    const used = todayCount + (runState?.thisRunAutoApplied ?? 0);
    if (used >= dailyCap) return false;
    return true;
  };
}
