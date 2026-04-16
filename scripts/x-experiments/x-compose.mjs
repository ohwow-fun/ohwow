#!/usr/bin/env node
/**
 * x-compose — original post drafter. Reads recent x-intel history +
 * emerging patterns from the workspace, and drafts original X posts in
 * the workspace's voice. Proposes each via _approvals as
 * kind='x_outbound_post'; DRY=1 writes per-draft briefs only.
 *
 * The goal isn't volume — it's voice. Three drafts per run, each one
 * picking the shape that fits its seed material (tactical-tip,
 * observation, opinion, question, story-from-the-trenches). Skips
 * shapes that require facts we can't back up.
 *
 * Env:
 *   DRY=1 (default)          draft only, no approval writes
 *   MAX_DRAFTS=3             how many posts to attempt per run
 *   HISTORY_DAYS=5           how far back to pull emerging patterns
 *   SHAPES=...               csv allowlist of shape names (default: all)
 *
 * Design note: we intentionally do NOT auto-post. The live Chrome post
 * path is a separate iteration. This script is the draft-and-eyeball
 * loop — we run it, read the drafts, tune the prompt, repeat. Once
 * drafts clear the eyeball bar across 20+ runs, we lift the guardrails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOhwow, llm, extractJson } from './_ohwow.mjs';
import { propose } from './_approvals.mjs';

const DRY = process.env.DRY !== '0';
const MAX_DRAFTS = Number(process.env.MAX_DRAFTS || 3);
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 5);
const SHAPES = new Set((process.env.SHAPES || 'tactical_tip,observation,opinion,question,story,humor').split(',').map(s => s.trim()).filter(Boolean));

function workspaceConfigPath(ws) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'x-config.json');
}
function historyPath(ws) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'x-intel-history.jsonl');
}

function loadHistory(ws, daysBack) {
  const p = historyPath(ws);
  if (!fs.existsSync(p)) return [];
  const cutoff = Date.now() - daysBack * 86400_000;
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.date && new Date(r.date + 'T00:00:00Z').getTime() >= cutoff);
}

/**
 * Pick seed material for a draft: an emerging_pattern from a recent
 * brief, with the bucket it came from. Returns null if nothing worth
 * writing about.
 */
function pickSeed(historyRows, usedPatterns = new Set(), usedBuckets = new Set()) {
  const candidates = [];
  for (const row of historyRows) {
    for (const p of row.emerging_patterns || []) {
      const key = `${row.bucket}::${p}`;
      if (usedPatterns.has(key)) continue;
      candidates.push({ bucket: row.bucket, pattern: p, date: row.date, headline: row.headline });
    }
  }
  if (!candidates.length) return null;
  // Diversify: prefer candidates from buckets we haven't drafted from
  // yet this run, then freshest date. Keeps all 3 drafts from piling
  // into 'advancements' when other buckets have fresh material.
  candidates.sort((a, b) => {
    const au = usedBuckets.has(a.bucket) ? 1 : 0;
    const bu = usedBuckets.has(b.bucket) ? 1 : 0;
    if (au !== bu) return au - bu;
    return b.date.localeCompare(a.date);
  });
  return candidates[0];
}

async function draftPost({ brandVoice, workspaceDesc, seed, allowedShapes, priorDrafts = [] }) {
  const dontDo = (brandVoice?.dont_do || []).map(d => `  - ${d}`).join('\n') || '  (none)';
  const sys = `You draft original X posts for this team (context — DO NOT regurgitate this as post content):
${workspaceDesc}

Positioning: ${brandVoice?.positioning || 'local-first AI runtime'}
Tone: ${brandVoice?.tone || 'warm, direct, builder-to-builder'}
Hard rules:
${dontDo}
  - Every post MUST stand alone. A reader who never heard of us should LEARN something or FEEL something — not be told what we are.
  - Banned filler phrases (instant skip if any appear in the post): "our daemon", "our runtime", "our local runtime", "our stack", "our platform", "our system", "mcp-first", "local-first" as an adjective, "multi-workspace", "keys and machines", "routing through", "on your machine, on your schedule". These read like product spec and kill engagement.
  - It's fine to say "we" when sharing an experience. Not fine when what follows is a feature list.
  - No hype. No "future of X". No "AI will change everything". No em-dashes. No hashtags. Lowercase ok. Plain text only.
  - Max 260 chars. Most should land 120-200.

Allowed shapes (pick ONE that fits the seed, or skip):
  - tactical_tip: a how-to so concrete another dev could reproduce it. Include a number, named tool, or specific action. NOT a feature description.
  - observation: "here's the pattern we keep seeing" — cite one concrete instance, not a category.
  - opinion: a sharp take we'd defend in a thread. Must include the reason it matters in ONE sentence.
  - question: a real question we'd pay for a good answer to. No "what do you think" bait.
  - story: 1-2 sentences, past tense, something that happened to us last week. Not a metaphor.
  - humor: a subtle joke about AI / the state of the art / the agent ecosystem. See humor rules below.

Humor rules (when shape='humor'):
  - Subtle over loud. The reader earns the laugh, not gets punched by it.
  - Smart over silly. Punchlines come from a real tension you noticed in the craft (agent hallucinations, prompt fiddling, eval theater, vibecoded demos, context-window anxieties). Inside jokes for builders who ship.
  - CLARITY before cleverness. If a reader has to re-read to get it, skip. If the premise requires a logic leap that isn't obvious in one pass, skip.
  - Banned meme templates (instant skip): "the new X does everything. except Y", "X but Y", "X walks into a Y", "nobody: / me:", "POV:", "plot twist:", "that moment when", "tell me you X without telling me".
  - NO dad jokes. NO puns on "agent" / "LLM" / "GPT" / "AI". NO VC-LinkedIn-isms. NO setup-punchline format. NO emojis.
  - NO hashtags, NO em-dashes, NO exclamation marks. No question marks unless genuinely rhetorical.
  - Under 200 chars. Most should land 60-140 chars. Brevity IS the joke.
  - Never at someone's expense. Never about a specific person, company, or model by name. Punch at the genre, not the players.
  - Don't force "we"/"i" framing when the subject IS the agent/model/tool. Let the funnier subject lead the sentence.
  - Each joke should punch at a DIFFERENT craft-tension: eval theater, hallucination, prompt fragility, latency, context loss, tool-use miss, context-switching, demo-vs-production gap, etc. Don't reuse the same punchline shape twice in a batch.
  - Think: a short aside a senior builder mumbles while debugging. Not a standup bit. Not a tweet template. Not a riff on an example you've already written.
  - If you can't write one this good, skip. Mediocre humor is worse than none. Humor is the ONE shape where the skip bar is highest — it's safer to post nothing.

Test each draft against: would a builder who doesn't know us read this and learn, agree, disagree, save it, or (for humor) smile-nod? If none of those, skip.

Output STRICT JSON:
{
  "shape": "tactical_tip|observation|opinion|question|story|skip",
  "seed_used": "<=30 words — which pattern from the brief you're drawing on",
  "post": "<=260 chars — the actual post. '' if skip.",
  "confidence": 0..1,
  "reason": "<=25 words — why this post adds value, or why you're skipping"
}

Skip (shape='skip', post='', confidence=0) when:
- The seed is too generic to say anything specific.
- The natural post would be a pitch or hype.
- The claim would need evidence we don't have.`;
  const priorBlock = priorDrafts.length
    ? `\nDrafts already written in THIS batch (do NOT repeat the angle, punchline shape, or subject — pick a different craft-tension):\n${priorDrafts.map((d, i) => `  ${i + 1}. [${d.shape}] ${d.post}`).join('\n')}\n`
    : '';
  const prompt = `Recent intelligence brief seed:
  bucket: ${seed.bucket}
  date: ${seed.date}
  headline: ${seed.headline || '(none)'}
  emerging_pattern: ${seed.pattern}
${priorBlock}
Allowed shapes this run: ${[...allowedShapes].join(', ')}

Draft ONE post.`;
  const out = await llm({ purpose: 'generation', system: sys, prompt });
  const parsed = extractJson(out.text);
  return {
    shape: String(parsed.shape || 'skip'),
    seed_used: String(parsed.seed_used || '').slice(0, 200),
    post: String(parsed.post || '').slice(0, 280),
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    reason: String(parsed.reason || '').slice(0, 200),
    model: out.model_used,
  };
}

async function main() {
  const t0 = Date.now();
  const { workspace } = resolveOhwow();
  const cfg = JSON.parse(fs.readFileSync(workspaceConfigPath(workspace), 'utf8'));
  const history = loadHistory(workspace, HISTORY_DAYS);
  if (!history.length) {
    console.log(`[x-compose] no history at ${historyPath(workspace)} (need x-intel live run first)`);
    process.exit(0);
  }
  console.log(`[x-compose] workspace=${workspace} · history=${history.length} rows · target drafts=${MAX_DRAFTS} · dry=${DRY}`);

  const briefDir = `/tmp/x-compose-${Date.now()}`;
  fs.mkdirSync(briefDir, { recursive: true });

  const drafts = [];
  const used = new Set();
  const usedBuckets = new Set();
  let llmSpend = 0;
  for (let i = 0; i < MAX_DRAFTS; i++) {
    const seed = pickSeed(history, used, usedBuckets);
    if (!seed) { console.log('[x-compose] no more fresh seeds'); break; }
    used.add(`${seed.bucket}::${seed.pattern}`);
    usedBuckets.add(seed.bucket);

    let draft;
    // Dedup retry loop: small models happily repeat themselves across
    // consecutive drafts in a batch even when told not to. Reject a
    // draft whose post shares a long substring with any prior draft
    // and try again. Cap retries to stay within spend budget.
    const priorPosts = drafts.map(d => d.draft.post).filter(Boolean);
    const dupOf = (text) => {
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 120);
      const n = norm(text);
      for (const prev of priorPosts) {
        const p = norm(prev);
        if (!p || !n) continue;
        // Long common substring ≥ 30 chars → treat as duplicate.
        for (let k = 0; k <= p.length - 30; k++) {
          if (n.includes(p.slice(k, k + 30))) return prev;
        }
      }
      return null;
    };
    let attempts = 0;
    let extraHint = '';
    while (attempts < 3) {
      attempts++;
      try {
        draft = await draftPost({
          brandVoice: cfg.brand_voice,
          workspaceDesc: cfg.workspace_description,
          seed: { ...seed, pattern: seed.pattern + extraHint },
          allowedShapes: SHAPES,
          priorDrafts: drafts.map(d => ({ shape: d.draft.shape, post: d.draft.post })).filter(d => d.post),
        });
        llmSpend += 0.001;
      } catch (e) {
        console.log(`  [${i+1}] draft failed (attempt ${attempts}): ${e.message}`);
        break;
      }
      if (!draft.post || !dupOf(draft.post)) break;
      extraHint = ` (the previous attempt duplicated an earlier draft — pick a completely different craft-tension)`;
    }
    if (!draft) continue;
    const record = { seed, draft, proposed: false, ts: new Date().toISOString() };

    console.log(`\n  [${i+1}] shape=${draft.shape} · conf=${draft.confidence.toFixed(2)}`);
    console.log(`    seed: ${seed.bucket} · "${seed.pattern.slice(0, 80)}..."`);
    console.log(`    post: ${draft.post || '(skip)'}`);
    console.log(`    reason: ${draft.reason}`);

    if (!DRY && draft.post && draft.confidence >= 0.5) {
      const entry = propose({
        kind: 'x_outbound_post',
        summary: `${draft.shape} · ${draft.post.slice(0, 60)}`,
        payload: {
          post_text: draft.post,
          shape: draft.shape,
          seed_bucket: seed.bucket,
          seed_pattern: seed.pattern,
          confidence: draft.confidence,
        },
        autoApproveAfter: 10, // outbound-post trust bar is high; we
                              // want to eyeball many more before auto.
      });
      record.proposed = true;
      record.approval_status = entry.status;
      record.approval_id = entry.id;
      console.log(`    approval ${entry.status} · id=${entry.id.slice(0, 8)}`);
    }

    drafts.push(record);
    fs.writeFileSync(path.join(briefDir, `${i+1}.json`), JSON.stringify(record, null, 2));
  }

  const report = {
    ts: new Date().toISOString(),
    workspace,
    dry: DRY,
    durationMs: Date.now() - t0,
    drafts: drafts.length,
    shapesUsed: drafts.map(d => d.draft.shape),
    llmSpendUsdEstimate: +llmSpend.toFixed(4),
    briefDir,
  };
  fs.writeFileSync(path.join(briefDir, '_run.json'), JSON.stringify(report, null, 2));
  console.log(`\n[x-compose] report → ${briefDir}/_run.json`);
  console.log(`[x-compose] spend~$${report.llmSpendUsdEstimate} · shapes: ${report.shapesUsed.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
