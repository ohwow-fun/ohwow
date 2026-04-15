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
    s === 'engager:own-post' || s === 'engager:competitor' || s === 'dm'
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
 */
export async function classifyIntent(row, rubric, llmFn, { extractJson } = {}) {
  const icp = rubric?.icp || {};
  const prompt = [
    `You classify buyer intent for inbound outreach.`,
    ``,
    `Who we sell to:`,
    `${icp.description || 'builders and founders shipping AI-adjacent products'}`,
    ``,
    icp.disqualifiers?.length ? `Hard disqualifiers: ${icp.disqualifiers.join(', ')}` : '',
    ``,
    `Classify the X author below into exactly one of:`,
    `- buyer_intent: likely to buy/try our product soon`,
    `- builder_curiosity: engaged builder, not actively in-market`,
    `- adjacent_noise: off-ICP, bot, low-signal, or disqualified`,
    ``,
    `Author:`,
    `  handle: ${row.handle}`,
    `  display_name: ${row.display_name || '(none)'}`,
    `  bucket: ${row.bucket || '(none)'}`,
    `  score: ${row.score ?? 0}`,
    `  replies observed: ${row.replies ?? 0}`,
    `  likes observed: ${row.likes ?? 0}`,
    `  tags: ${(row.tags || []).join(', ') || '(none)'}`,
    `  sources: ${(row.sources || []).join(', ') || '(none)'}`,
    ``,
    `Reply with strict JSON: {"intent":"buyer_intent|builder_curiosity|adjacent_noise","confidence":0..1,"reason":"<=25 words"}`,
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
