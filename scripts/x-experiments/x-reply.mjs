#!/usr/bin/env node
/**
 * x-reply — prototype smart-reply drafter for strategic X posts.
 *
 * Flow:
 *   1. Read today's x-posts-<date>.jsonl sidecar (written by x-intel).
 *   2. Filter to strategic buckets (market_signal, competitors) and a
 *      minimum score; dedup against a per-workspace replied ledger
 *      (x-replied.jsonl) so we never draft twice on the same permalink.
 *   3. For each candidate, draft a warm builder-to-builder reply using
 *      the workspace's brand_voice (from x-config.json).
 *   4. Propose via _approvals as kind='x_outbound_reply' (threshold 8,
 *      gated by _outbound-gate's forecast-accuracy floor → auto-apply
 *      only after rolling 30d accuracy ≥ 0.55 per bucket).
 *   5. DRY=1 (default) writes per-candidate briefs to /tmp; DRY=0
 *      would navigate Chrome + click reply + type + submit. The live
 *      write path is NOT wired yet — this prototype is draft-only so
 *      we can eyeball reply quality before letting it touch Chrome.
 *
 * Env:
 *   DRY=1 (default) — draft-only, no approval-queue writes, no Chrome.
 *   DRY=0 — propose via _approvals.
 *   MAX_REPLIES_PER_RUN=5 — cap candidates to keep LLM spend predictable.
 *   REPLY_BUCKETS=market_signal,competitors — which buckets to target.
 *   REPLY_MIN_SCORE=0.55 — post score floor.
 *
 * NOTE: This is an experimental script. When the reply quality passes
 * the eyeball test across 20+ drafts, we lift the guardrails (wire the
 * live Chrome path) and move the deterministic pieces into a proper
 * scheduler entry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOhwow, llm, extractJson } from './_ohwow.mjs';
import { propose } from './_approvals.mjs';
import { buildOutboundGate } from './_outbound-gate.mjs';
import { replyToPost } from './_x-harvest.mjs';
import { ensureXReady } from './_x-browser.mjs';

const DRY = process.env.DRY !== '0';
// 1-2 replies per run. Rapid-fire replies from the same account look
// bot-like. The scheduler cadence (every 3h) provides natural spacing.
const MAX_REPLIES_PER_RUN = Number(process.env.MAX_REPLIES_PER_RUN || 2);
// Reply strategy: the brand shows up in genuinely interesting builder
// conversations (hacks, advancements, inspiration) — not just in-market
// complaints about competitors. Audiences discover us by stumbling into
// a thread where we said something worth saving. Buying-intent buckets
// are included, but they are not the primary surface.
const REPLY_BUCKETS = new Set((process.env.REPLY_BUCKETS || 'hacks,advancements,inspiration,market_signal,competitors').split(',').map(s => s.trim()).filter(Boolean));
const REPLY_MIN_SCORE = Number(process.env.REPLY_MIN_SCORE || 0.55);

// Deterministic post-filter: small models sneak pitchy phrases past the
// system-prompt ban list. Catching them here is cheaper than smarter
// prompting. Each match downgrades the draft to a skip.
const BANNED_PHRASES = [
  'with your keys',
  'on your machine',
  'on your schedule',
  'local agent workspaces',
  'our agent workspaces',
  'agent workspaces',
  'across workspaces',
  'our local runtime',
  'our runtime',
  'our daemon',
  'the daemon',
  'our stack',
  'what we do',
  'what we built',
  'what we run',
  'mcp-first',
  'multi-workspace',
];
function detectBanned(text) {
  const t = (text || '').toLowerCase();
  return BANNED_PHRASES.filter(p => t.includes(p));
}

function today() { return new Date().toISOString().slice(0, 10); }
function postsSidecar(workspace, date) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, `x-posts-${date}.jsonl`);
}
function repliedLedgerPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-replied.jsonl');
}
function workspaceConfigPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-config.json');
}

function loadReplied(workspace) {
  const p = repliedLedgerPath(workspace);
  if (!fs.existsSync(p)) return new Set();
  return new Set(
    fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l).permalink; } catch { return null; } })
      .filter(Boolean),
  );
}

function appendReplied(workspace, record) {
  const p = repliedLedgerPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(record) + '\n');
}

async function draftReply({ brandVoice, workspaceDesc, post }) {
  const dontDo = (brandVoice?.dont_do || []).map(d => `  - ${d}`).join('\n') || '  (none)';
  const sys = `You draft replies on X. Context on who we are (DO NOT pitch this unprompted):
${workspaceDesc}
Positioning: ${brandVoice?.positioning || 'local-first AI runtime'}

Tone: ${brandVoice?.tone || 'warm, direct, builder-to-builder'}

Strategy: we show up in genuinely interesting builder conversations so our audience finds us in unexpected places. Curiosity-first, not conversion-first. A great reply teaches, disagrees, or deepens the thread — it does NOT direct anyone back to us. Audiences discover us by saving something smart we said.

Hard rules:
${dontDo}
  - Never start with "we built" / "we're building" / "check out" / "try X". Those are pitches.
  - Never mention our product name unless the post is a direct, unambiguous ask ("what tools do people use for Y", "anyone running Z locally"). Even then, once, briefly.
  - Banned phrases (instant skip if they appear as "connective tissue" to tie the reply back to us): "in local agent workspaces", "our agent workspaces", "our local runtime", "our daemon", "our stack", "local-first" as an adjective, "mcp-first", "multi-workspace", "on your machine, on your schedule", "with your keys". These are pitch-shortcuts disguised as context.
  - Never claim domain experience we don't have. We ship a local AI runtime + agent orchestration. We do NOT run bioinformatics, legal work, medicine, fintech, education, or any specific vertical. If the post is in a vertical, speak from the general builder/runtime angle or skip — never fake domain expertise.
  - "helped me" + feature description = pitch disguised as advice. Skip or rewrite without the feature description.
  - Do not hunt competitor-frustration posts looking to swoop in. If someone vents about zapier, shared-pain is fine; selling is not.
  - Don't post generic "great thread" / "this is huge" / "love this" filler.
  - Aggregator / news-bot / hype-spammer accounts (GitTrend, ai news, retweet bots): SKIP. Replying there is noise.

Good reply shapes (pick the ONE that fits this post, or skip):
  a) specific observation: add a concrete detail from your own experience that extends the post's claim.
  b) sharp question: ask something the author would want to answer — not a softball.
  c) counter-point: respectful disagreement rooted in a specific case where the post's claim breaks down.
  d) shared-pain: if the author is venting about a known problem we also feel, acknowledge the specific pain without pitching.
  e) curiosity-branch: pick up a side-thread the post mentions but doesn't develop, and push it one step further with something non-obvious. Used when the post is "interesting" even if not on our ICP.

Output STRICT JSON:
{
  "shape": "observation|question|counter|shared-pain|curiosity-branch|skip",
  "angle": "<=12 words — what you're adding to the conversation",
  "reply": "<=220 chars — the actual reply text. Plain text, no hashtags, no em-dashes. Lowercase ok. '' if skip.",
  "confidence": 0..1,
  "reason": "<=25 words — why this reply helps THIS author, or why you're skipping"
}

Skip (shape='skip', reply='', confidence=0) when:
- The post is itself a pitch, ad, or service offering.
- Political, nsfw, off-domain.
- You can't write a reply without mentioning our product unnaturally.
- Account is aggregator / bot / hype-spammer.
- The natural response is pure acknowledgement.`;

  const prompt = `Post by @${post.author}${post.display_name ? ` (${post.display_name})` : ''}:
${post.text}

Bucket: ${post.bucket} · score: ${post.score ?? '?'} · tags: ${(post.tags || []).join(', ') || 'none'}
Engagement: ${post.likes} likes · ${post.replies} replies

Draft the reply.`;

  const out = await llm({ purpose: 'generation', system: sys, prompt });
  const parsed = extractJson(out.text);
  return {
    angle: String(parsed.angle || '').slice(0, 120),
    reply: String(parsed.reply || '').slice(0, 280),
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    reason: String(parsed.reason || '').slice(0, 200),
    model: out.model_used,
  };
}

async function main() {
  const t0 = Date.now();
  const { workspace } = resolveOhwow();
  const cfg = JSON.parse(fs.readFileSync(workspaceConfigPath(workspace), 'utf8'));

  const postsPath = postsSidecar(workspace, today());
  if (!fs.existsSync(postsPath)) {
    console.log(`[x-reply] no posts sidecar at ${postsPath}; run x-intel first`);
    process.exit(0);
  }
  const posts = fs.readFileSync(postsPath, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const replied = loadReplied(workspace);
  const gate = buildOutboundGate(workspace);

  // Candidate selection: strategic buckets, score floor, dedup.
  const candidates = posts
    .filter(p => REPLY_BUCKETS.has(p.bucket))
    .filter(p => (p.score ?? 0) >= REPLY_MIN_SCORE)
    .filter(p => !replied.has(p.permalink))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, MAX_REPLIES_PER_RUN);

  console.log(`[x-reply] ${posts.length} posts in sidecar → ${candidates.length} candidates (buckets=${[...REPLY_BUCKETS].join(',')}, minScore=${REPLY_MIN_SCORE})`);
  if (!candidates.length) { console.log('[x-reply] nothing to draft'); return; }

  const briefDir = `/tmp/x-reply-${Date.now()}`;
  fs.mkdirSync(briefDir, { recursive: true });

  const drafted = [];
  let llmSpendEstimate = 0;
  for (const post of candidates) {
    let draft;
    try {
      draft = await draftReply({ brandVoice: cfg.brand_voice, workspaceDesc: cfg.workspace_description, post });
      llmSpendEstimate += 0.001; // reasoning/generation call, rough estimate
    } catch (e) {
      console.log(`  @${post.author} DRAFT FAILED: ${e.message}`);
      continue;
    }
    const offenders = detectBanned(draft.reply);
    if (offenders.length) {
      console.log(`  @${post.author} filtered: banned phrase '${offenders[0]}' — downgraded to skip`);
      draft = { ...draft, shape: 'skip', reply: '', confidence: 0, reason: `auto-skip: banned phrase '${offenders[0]}'` };
    }

    const record = {
      permalink: post.permalink,
      author: post.author,
      bucket: post.bucket,
      post_text: post.text,
      post_score: post.score,
      draft,
      proposed: false,
      ts: new Date().toISOString(),
    };
    console.log(`\n  @${post.author} · bucket=${post.bucket} · score=${post.score?.toFixed(2) ?? '?'} · draft_conf=${draft.confidence.toFixed(2)}`);
    console.log(`    post: ${post.text.slice(0, 120).replace(/\n/g, ' ')}…`);
    console.log(`    reply: ${draft.reply}`);
    console.log(`    reason: ${draft.reason}`);

    if (!DRY && draft.reply && draft.confidence >= 0.5) {
      const entry = propose({
        kind: 'x_outbound_reply',
        summary: `reply to @${post.author} (${post.bucket}): ${draft.angle}`,
        payload: {
          permalink: post.permalink,
          bucket: post.bucket,
          reply_text: draft.reply,
          post_text: post.text,
          confidence: draft.confidence,
          reason: draft.reason,
        },
        autoApproveAfter: 8,
        gate,
      });
      record.proposed = true;
      record.approval_id = entry.id;
      record.approval_status = entry.status;
      console.log(`    approval ${entry.status} (id=${entry.id.slice(0, 8)})`);
      if (entry.status === 'auto_applied') {
        try {
          const { browser, page } = await ensureXReady();
          await replyToPost(page, post.permalink, draft.reply);
          browser.close();
          record.posted = true;
          appendReplied(workspace, { permalink: post.permalink, ts: new Date().toISOString() });
          console.log(`    posted reply live via Chrome`);
        } catch (e) {
          console.log(`    reply post failed: ${e.message}`);
          record.posted = false;
          record.post_error = e.message;
        }
      }
    }

    drafted.push(record);
    fs.writeFileSync(path.join(briefDir, `${post.permalink.replace(/[^\w-]/g, '_')}.json`), JSON.stringify(record, null, 2));
  }

  const report = {
    ts: new Date().toISOString(),
    workspace,
    dry: DRY,
    durationMs: Date.now() - t0,
    postsInSidecar: posts.length,
    candidates: candidates.length,
    drafted: drafted.length,
    llmSpendUsdEstimate: +llmSpendEstimate.toFixed(4),
    briefDir,
  };
  fs.writeFileSync(path.join(briefDir, '_run.json'), JSON.stringify(report, null, 2));
  console.log(`\n[x-reply] report → ${briefDir}/_run.json`);
  console.log(`[x-reply] spend~$${report.llmSpendUsdEstimate} over ${drafted.length} drafts`);
}

main().catch(e => { console.error(e); process.exit(1); });
