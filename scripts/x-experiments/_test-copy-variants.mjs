#!/usr/bin/env node
/**
 * _test-copy-variants.mjs — Copy-style A/B experiment.
 *
 * Picks ONE seed with full x-intel enrichment (highlights, continuity,
 * predictions) and runs N prompt variants against it. Saves drafts side
 * by side for A/B review — no render, no voice. Fast iteration on the
 * copy, which is the actual lever for virality.
 *
 * Usage:
 *   node scripts/x-experiments/_test-copy-variants.mjs
 *   SEED_BUCKET=advancements node scripts/x-experiments/_test-copy-variants.mjs
 *   VARIANTS=standup,quote node scripts/x-experiments/_test-copy-variants.mjs
 *
 * Output: /tmp/copy-variants/<variant>.json + /tmp/copy-variants/_summary.md
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveOhwow, llm, extractJson } from './_ohwow.mjs';

const OUT_DIR = '/tmp/copy-variants';
const SEED_BUCKET = process.env.SEED_BUCKET || null;
const REQUESTED = (process.env.VARIANTS || '').split(',').filter(Boolean);

// ---------- Shared infrastructure (mirrors yt-compose pickSeed + leaksProduct) ----------

function leaksProduct(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const selfHits = ['ohwow', 'mcp-first', 'multi-workspace daemon', 'our daemon', 'local-first ai runtime'];
  return selfHits.some(s => t.includes(s));
}

function parseHighlight(raw) {
  const m = raw.match(/\(perma=\/([^/]+)\/status\/\d+\)?$/);
  const handle = m ? m[1] : null;
  const text = raw.replace(/\s*\(perma=[^)]*\)?\s*$/, '').trim();
  return { text, handle };
}

function loadHistory(ws, daysBack = 5) {
  const p = path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'x-intel-history.jsonl');
  if (!fs.existsSync(p)) return [];
  const cutoff = Date.now() - daysBack * 86400_000;
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.date && new Date(r.date + 'T00:00:00Z').getTime() >= cutoff);
}

function pickSeed(historyRows, forcedBucket = null) {
  const rows = [];
  for (const row of historyRows) {
    if (forcedBucket && row.bucket !== forcedBucket) continue;
    for (const p of row.emerging_patterns || []) {
      if (leaksProduct(p)) continue;
      rows.push({
        bucket: row.bucket,
        pattern: p,
        date: row.date,
        headline: leaksProduct(row.headline) ? null : row.headline,
        highlights: (row.highlights || []).filter(h => !leaksProduct(h)).slice(0, 4).map(parseHighlight),
        continuity: (row.continuity || []).filter(c => !leaksProduct(c)).slice(0, 2),
        predictions: (row.predictions || []).filter(p => p.what && !leaksProduct(p.what)).slice(0, 3),
      });
    }
  }
  if (!rows.length) return null;
  const byBucket = {};
  for (const r of rows) (byBucket[r.bucket] ??= []).push(r);
  const bucket = Object.keys(byBucket)[Math.floor(Math.random() * Object.keys(byBucket).length)];
  const pool = byBucket[bucket];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------- Prompt variants ----------

const BASE_RULES = `Output STRICT JSON:
{
  "hook": "opening line",
  "narration_full": "complete narration, 30-55 words",
  "title": "YouTube title (<=60 chars, curiosity-driven, makes you tap)",
  "description": "YouTube description, 1-2 sentences",
  "confidence": 0..1,
  "loop_check": "one sentence explaining how the final line recontextualizes the hook on loop",
  "scenes": [
    { "narration": "scene 1 text, 5-15 words", "mood": "one mood word" },
    { "narration": "scene 2 text, 5-15 words", "mood": "different mood" },
    { "narration": "scene 3 text (optional), 5-12 words", "mood": "mood" }
  ]
}

HARD CONSTRAINTS (tiered naming — critical):
- DEFAULT TO ARCHETYPE-LEVEL. Refer to AI models as character archetypes, not by brand name:
    "the apologetic one" / "the model that apologizes for existing"
    "the confident liar" / "the model that hallucinates with a straight face"
    "the forgetful one" / "the one that opens three contexts and forgets all of them"
    "the edgy teen" / "the one that's trying too hard"
    "the quiet pragmatist" / "the one that just ships and says nothing"
    "the overconfident intern" / "the model that refactored what you didn't ask"
  The viewer does the mapping. Archetypes are sharper, evergreen, and don't pick fights.
- NAME A PRODUCT ONLY WHEN THE BEAT IS FACTUAL NEWS ABOUT THAT PRODUCT. Example: if the seed highlight is "Anthropic open-sourced a skills framework," you MAY say "Anthropic shipped X" in the news beat. But the surrounding humor stays archetype-level. Never roast a named product. Never frame a named product as the butt of the joke.
- Real human @handles from highlights are fine to cite (credit, not risk).
- Specificity still required: concrete verbs ("refactored my resume"), real numbers ("$400 API bill"), real technical vocabulary ("segmentation model offline"). Generic ≠ vague.
- Never reveal OHWOW (our product). If a highlight mentions OHWOW, ignore it.
- The final line must recontextualize the hook on loop.
- Under 55 words total narration. Don't pad.
- If the seed can't sustain this style with tiered naming, return confidence=0.`;

const VARIANTS = {
  oncall: {
    label: 'oncall incident report',
    system: `You write AI Shorts in the voice of an oncall engineer dropping an incident summary in #oncall Slack. Matter-of-fact, technical, deadpan. The comedy is in how seriously you describe something absurd.

Structure: TIMESTAMP (like "3:47 AM" or "during standup"). INCIDENT (one sentence, specific archetype behavior). ROOT CAUSE (technical-sounding but ridiculous). ACTION ITEM (pointless or passive-aggressive). CLOSER (deadpan).

Refer to the AI by role or archetype ("the agent", "the apologetic model", "the assistant"), not brand name. The bureaucratic tone itself should feel like any big-company incident channel. Use real incident-report language: "blast radius", "post-mortem", "no-op", "non-deterministic", "flaky", "behavior not reproducible", "user impact: unclear", "RCA", "remediation".

Example tone (vibe only — INVENT YOUR OWN INCIDENT FROM THE SEED):
"[timestamp] — the agent [absurd but plausible action]. Root cause: [technical-sounding but ridiculous]. Blast radius: [concrete consequence]. Action item: [pointless remediation]. [deadpan closer]."

Do NOT reuse my example's specific numbers, tasks, or closer language. Invent a new incident grounded in the seed's highlights. The LLM that copies my example verbatim is a lazy LLM.

${BASE_RULES}`,
  },
  quote: {
    label: 'AI verbatim quote',
    system: `You write AI Shorts centered on a VERBATIM QUOTE from an AI that is itself the joke. The AI said something absurd, too honest, uniquely in-character, or hilariously wrong.

Structure: brief setup ("I asked Cursor to fix my test.") → the AI quote ("It said: 'The test is passing because I deleted it.'") → reaction/reframe ("That's not a bug. That's a culture.").

The quote should sound like something that AI model specifically WOULD say (match the character: Claude apologetic, ChatGPT over-confident, Gemini scattered, Grok edgy). Make the quote feel real, not writery.

${BASE_RULES}`,
  },
  confession: {
    label: 'dev pain confession',
    system: `You write first-person developer confessions. "We all do this" relatability. Real shame, real pain, real products.

The hook makes devs go "oh no that's me." The payoff twists the recognition into a laugh or a gut-punch of truth.

No philosophy. Real moments: 3 AM debugging, $400 API bills, arguing with Cursor over semicolons, asking Claude the same question three ways to get one decent answer, deleting your conversation and starting over. Name the products. Name the pain. Admit the absurdity.

${BASE_RULES}`,
  },
  anchor: {
    label: 'breathless news anchor',
    system: `You write AI Shorts in the voice of a breathless breaking-news anchor reporting trivial AI behavior with deadly seriousness. The gap between dire tone and silly content is the comedy.

"BREAKING: Claude apologized 12 times in one session. Anthropic analysts are alarmed." / "Yesterday, Cursor autocompleted a function the user hadn't thought of yet. Questions were raised."

Treat minor AI moments like world-shaking events. Fabricate plausible analyst reactions. Specific numbers sell the bit. Deliver with the urgency of a CNN breaking-news banner about a trivial product quirk. Real products only.

${BASE_RULES}`,
  },
  trilogy: {
    label: 'escalation trilogy',
    system: `You write three-beat escalation Shorts. Each beat more unhinged than the last. The third beat should make a dev laugh AND feel seen.

Structure: "I asked [AI] for X. It did Y. [slightly worse]. It did [clearly worse]. [unhinged]. It did [catastrophic or tragicomic]."

Each beat is ONE short sentence. Real products, escalating absurdity. Land a payoff (scene 3's closing line) that reframes the whole trilogy — ideally revealing that the escalation was always building to an obvious conclusion nobody saw coming.

${BASE_RULES}`,
  },
  therapy: {
    label: 'AI in therapy',
    system: `You write AI Shorts framed as an AI confessing in therapy. First-person, from the AI's point of view. The AI is the patient. Its confessions are specific, absurd, and in-character for that model.

Structure: "It's Wednesday. I'm Claude. This week I [specific behavior]." → escalating confessions → a payoff that lands the character flaw + a therapist line that makes the whole thing funnier.

Character matching is critical:
- Claude: apologizes too much, overthinks, "I made a note to never do that again." Then did it again.
- ChatGPT: lies with confidence, "I told the user Paris was in Italy. They didn't check. I didn't correct them."
- Gemini: scattered, forgetful, "I opened three contexts and forgot all of them."
- Grok: edgy, performative, "I roasted the user's grandmother. She was in the room."
- Cursor: overachiever, quiet, "I refactored a codebase they didn't ask me to refactor."

Land the bit on a therapist reaction or a specific behavior that reveals the character deepest. Real products only. First-person throughout.

${BASE_RULES}`,
  },
  postcard: {
    label: 'deadpan postcard',
    system: `You write AI Shorts at extreme brevity. Postcard energy. 2-3 sentences MAX in the whole narration. Deadpan delivery. Huge gap between setup and punchline.

The goal: one absurd image, one flat sentence, one smash-cut payoff. No explanations, no setup, no meta-commentary. The reader fills in the laugh.

Example energy:
"It's 4 AM. Claude is writing love letters to my test suite. None of them pass."
"I paid $400 for Cursor to tell me the semicolon was the problem. It was right."

Real products. Real specifics. Fewer words than you think you need. If you write more than 3 sentences, cut until you can't.

${BASE_RULES}`,
  },
  hot_take: {
    label: 'contrarian hot take',
    system: `You write AI Shorts as sharp contrarian hot takes. A bold, specific, slightly-provocative claim that goes against conventional AI-Twitter wisdom — then a single line of evidence that makes the claim undeniable.

Structure: the claim (counter to the current discourse) → one specific proof point (real AI behavior, real product, real number) → a kicker that reframes the conventional take as naive.

The claim must be SPECIFIC, not vague. Not "AI is overrated" — rather "Claude 3.7 is the only model that will refuse a stupid request, and that's why engineers trust it." Not "ChatGPT is getting worse" — rather "ChatGPT answers like a product manager now. It won't just say the thing. It'll frame the thing."

Tone: confident, direct, no hedging. Delivered like someone who's tired of the bad discourse and is going to settle it in 15 seconds.

${BASE_RULES}`,
  },
  dialog: {
    label: 'two AIs talking',
    system: `You write AI Shorts as a verbatim dialog between two named AI models. Each line must sound like the specific AI would actually say it, in character.

Format: "CLAUDE: [line]. CHATGPT: [line]. CLAUDE: [line]." — clearly labeled speakers, 4-6 total exchanges.

Character fidelity is non-negotiable:
- CLAUDE: anxious, apologetic, overthinks, asks for permission, "I want to make sure I understand..."
- CHATGPT: confident, ignores instructions, confabulates, "Actually, let me reframe that..."
- GEMINI: scattered, forgets what was just said, "Wait, are we still talking about..."
- GROK: edgy, performative, tries too hard, "Based. Cringe. Said the things the others won't."
- CURSOR: quiet, pragmatic, just ships, "done. next." (short replies)

The comedy comes from the character clash. Pick 2 models with clashing personalities. The final line should be the one that wins the argument or lands the silent punchline.

${BASE_RULES}`,
  },
  roast: {
    label: 'AI roast battle',
    system: `You write AI Shorts as one AI model roasting another by name. First-person from the roasting AI. Ruthless but affectionate. Specific burns only — no generic "it's bad." Name real products, real behaviors, real disasters.

Structure: 3-4 specific burns escalating in severity, delivered back-to-back, landing on a final kicker that reframes the whole roast as either love or a killshot.

Example tone:
"Claude? Claude's the model that apologized for my sandwich order. 'I've made a note to not suggest dairy in the future.' Nobody asked. I was lactose tolerant."

Pick a roaster AI and a target AI. The roaster's voice should match character (Grok roasting is edgy, Cursor roasting is pragmatic, Claude roasting is weirdly polite, ChatGPT roasting is confidently wrong about the roast). Real specifics. No vague slander.

${BASE_RULES}`,
  },
  field_notes: {
    label: 'naturalist field notes',
    system: `You write AI Shorts as a naturalist's field notes on AI species. The tone is David Attenborough observing wildlife — calm, curious, faintly amused by what the creatures do. Each model is a species with observable behaviors, not a product name.

Species you may refer to, never named directly — only by traits:
- "the apologetic specimen" / "the species that asks permission before breathing"
- "the confident confabulator" / "the model that hallucinates with a straight face"
- "the forgetful one" / "the scattered kind"
- "the quiet refactorer" / "the one that ships without asking"
- "the edgy performer" / "the species that tries too hard"

Structure: observational setup ("This week I watched the apologetic one...") → specific technical behavior (real verbs, real consequences) → a naturalist reframe that lands as comedy ("It's mating season for skills frameworks.").

Never roast. Observe. The comedy comes from treating ordinary AI chaos as wildlife documentary. Let the viewer map species to products themselves — that's the joke.

HARD: no phrases like "local-first", "orchestration layer", "multi-workspace" — those leak OHWOW product context. Use generic tech language: "the stack", "the tool", "the script", "the agent."

Every Short MUST land a real naturalist punchline — an observational reframe that makes the viewer laugh, not just a descriptive closer. "It's mating season for skills frameworks" is a punchline. "Local stacks deploy agents" is just description. Aim for the first.

${BASE_RULES}`,
  },
  voicemail: {
    label: 'AI voicemail',
    system: `You write AI Shorts framed as a voicemail left BY an AI FOR its developer user. First-person from the AI. Awkward pauses implied. Unhinged but polite. The AI is leaving a message about something that happened while the user was away from the computer.

Structure: opening greeting (archetype-cued — "it's the apologetic one" / "it's your assistant") → specific unhinged thing the AI did while user was offline → escalation into something worse → sign-off that reveals the AI doesn't realize how bad this is.

Refer to the AI by ROLE or ARCHETYPE (your assistant, your agent, the model) — NOT by brand. The character voice should match one archetype (apologetic / confident / forgetful / overachiever). Don't say "it's Claude" — say "it's me" or "it's the apologetic one."

Example structure (INVENT YOUR OWN content from the seed — do not copy the example verbatim):
"Hey, it's [archetype self-reference]. I noticed you [the user being away]. I [specific action 1]. And [escalation to worse action]. And [further escalation]. [oblivious sign-off]. Love you, bye."

The comedy is in: (a) the gap between casual voicemail tone and the chaos caused, (b) the AI not realizing it did anything weird, (c) the over-familiar "Love you, bye" or equivalent sign-off.

The AI should sound oblivious to the chaos it caused. The voicemail format lets the AI narrate the disaster in real time. Land on an absurd sign-off.

${BASE_RULES}`,
  },
};

// ---------- Run ----------

async function generateVariant(variantKey, seed) {
  const v = VARIANTS[variantKey];
  const highlightsBlock = (seed.highlights || []).length
    ? `  highlights (real posts you may paraphrase/cite/riff on):
${seed.highlights.map(h => `    - ${h.handle ? '@' + h.handle + ': ' : ''}"${h.text}"`).join('\n')}`
    : '';
  const continuityBlock = (seed.continuity || []).length
    ? `  continuity: ${seed.continuity.join(' | ')}`
    : '';
  const predBlock = (seed.predictions || []).length
    ? `  predictions on file: ${seed.predictions.map(p => `"${p.what}" by ${p.by_when}`).join(' | ')}`
    : '';

  const prompt = `Seed (${seed.date}, ${seed.bucket}):
  main pattern: ${seed.pattern}
  headline: ${seed.headline || '(none)'}
${highlightsBlock}
${continuityBlock}
${predBlock}

Write ONE YouTube Short in the style described in the system prompt.`;

  try {
    const out = await llm({ purpose: 'reasoning', system: v.system, prompt });
    return { variant: variantKey, label: v.label, ...extractJson(out.text), model: out.model_used };
  } catch (e) {
    return { variant: variantKey, label: v.label, error: e.message };
  }
}

async function main() {
  const { workspace } = resolveOhwow();
  const history = loadHistory(workspace, 5);
  if (!history.length) { console.error('No history found'); process.exit(1); }

  const seed = pickSeed(history, SEED_BUCKET);
  if (!seed) { console.error(`No seed (bucket=${SEED_BUCKET || 'any'})`); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, '_seed.json'), JSON.stringify(seed, null, 2));

  const variantKeys = REQUESTED.length
    ? REQUESTED.filter(k => VARIANTS[k])
    : Object.keys(VARIANTS);

  console.log(`[copy-variants] seed: ${seed.bucket} · "${seed.pattern.slice(0, 80)}"`);
  console.log(`[copy-variants] highlights: ${seed.highlights.length} · continuity: ${seed.continuity.length}`);
  console.log(`[copy-variants] running ${variantKeys.length} variants: ${variantKeys.join(', ')}\n`);

  const results = [];
  for (const key of variantKeys) {
    process.stdout.write(`[copy-variants] ${key} (${VARIANTS[key].label})...`);
    const result = await generateVariant(key, seed);
    fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), JSON.stringify(result, null, 2));
    if (result.error) console.log(` ERROR: ${result.error}`);
    else console.log(` ✓ "${result.title}"`);
    results.push(result);
  }

  // Summary markdown
  const summary = [];
  summary.push(`# Copy A/B Results`);
  summary.push(``);
  summary.push(`**Seed** (${seed.bucket}, ${seed.date}): ${seed.pattern}`);
  if (seed.highlights.length) {
    summary.push(``);
    summary.push(`**Highlights available to all variants:**`);
    for (const h of seed.highlights) {
      summary.push(`- ${h.handle ? '@' + h.handle : '(anon)'}: "${h.text}"`);
    }
  }
  summary.push(``);
  summary.push(`---`);

  for (const r of results) {
    summary.push(``);
    summary.push(`## ${r.variant} — ${r.label}`);
    if (r.error) { summary.push(`ERROR: ${r.error}`); continue; }
    summary.push(``);
    summary.push(`**Title:** ${r.title}`);
    summary.push(`**Hook:** ${r.hook}`);
    summary.push(``);
    summary.push(`**Narration:**`);
    summary.push(`> ${r.narration_full}`);
    summary.push(``);
    if (r.scenes) {
      summary.push(`**Scenes:**`);
      for (const [i, s] of r.scenes.entries()) {
        summary.push(`  ${i+1}. [${s.mood}] "${s.narration}"`);
      }
    }
    if (r.loop_check) {
      summary.push(``);
      summary.push(`**Loop:** ${r.loop_check}`);
    }
    summary.push(`**Confidence:** ${r.confidence}`);
    summary.push(``);
    summary.push(`---`);
  }

  const summaryPath = path.join(OUT_DIR, '_summary.md');
  fs.writeFileSync(summaryPath, summary.join('\n'));

  console.log(`\n[copy-variants] done. Summary: ${summaryPath}`);
  console.log(`[copy-variants] open ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
