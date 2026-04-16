#!/usr/bin/env node
/**
 * _design-video-script.mjs — Phase 4 visual designer pass.
 *
 * Takes a lean copy draft (narration + beat-mood per scene) and runs a
 * DESIGNER LLM pass that expands it into a full VideoSpec: scene kinds,
 * visual layer stacks, text animation + font + position, transitions,
 * palette — plus a human-readable markdown breakdown with pre-render
 * alignment checks. No TTS, no render. Validate the design BEFORE
 * burning compute.
 *
 * Inputs: /tmp/copy-variants/<variant>.json (produced by
 *         _test-copy-variants.mjs — has scenes[].{narration,mood}).
 *
 * Outputs: /tmp/design-video-script/
 *   <variant>-<format>-<direction>.json  — full VideoSpec
 *   <variant>-<format>.md                — 3 directions side-by-side +
 *                                          alignment + loop-back audit
 *
 * Env:
 *   COPY_DIR=/tmp/copy-variants
 *   COPY_VARIANTS=voicemail,therapy
 *   FORMATS=15s,30s         (both by default)
 *   DIRECTIONS=atmospheric,geometric,kinetic
 */
import fs from 'node:fs';
import path from 'node:path';
import { llm, extractJson } from './_ohwow.mjs';

const COPY_DIR = process.env.COPY_DIR || '/tmp/copy-variants';
const OUT_DIR = '/tmp/design-video-script';
const COPY_VARIANTS = (process.env.COPY_VARIANTS || 'voicemail,therapy').split(',').filter(Boolean);
const FORMATS = (process.env.FORMATS || '15s,30s').split(',').filter(Boolean);
const DIRECTIONS = (process.env.DIRECTIONS || 'atmospheric,geometric,kinetic').split(',').filter(Boolean);

// Shared constants — mirror yt-compose.mjs so specs drop into the render path.
const VOICE_LEAD_FRAMES = 5;
const VOICE_TAIL_FRAMES = 20;
const SCENE_MIN_FRAMES = 90;
const FPS = 30;
const WORDS_PER_SECOND = 2.0; // onyx TTS observed pace

const SCENE_KINDS = ['text-typewriter', 'quote-card', 'composable'];
const MOODS = ['contemplative', 'electric', 'warm', 'cosmic', 'ethereal', 'noir', 'dawn'];
const VISUAL_PRIMITIVES = [
  'aurora', 'bokeh', 'light-rays', 'constellation', 'waveform',
  'geometric', 'vignette', 'ripple', 'glow-orb', 'flow-field',
  'film-grain', 'scan-line',
];

// Three distinct visual directions. Each seeds the designer with a
// different primitive palette and transition grammar so design variants
// feel genuinely different, not just shuffled. Kept short so the LLM
// can internalise them without drifting.
const DIRECTION_BRIEFS = {
  atmospheric: {
    tagline: 'soft layered atmosphere, emotional, slow',
    base: ['aurora', 'flow-field'],
    mid: ['bokeh', 'light-rays', 'glow-orb'],
    top: ['film-grain', 'vignette'],
    transitions: ['fade'],
    transitionFrames: [15, 20],
    notes: 'Slow gradients, organic motion, softer edges. Scene feels like a mood first, text second. Favor contemplative, warm, ethereal, dawn.',
  },
  geometric: {
    tagline: 'structural, architectural, graphic',
    base: ['constellation', 'geometric'],
    mid: ['light-rays', 'waveform'],
    top: ['vignette', 'scan-line'],
    transitions: ['slide', 'wipe'],
    transitionFrames: [10, 14],
    notes: 'Crisp lines, deliberate composition, grid-adjacent. Text sits on architecture, not mist. Favor noir, electric, cosmic.',
  },
  kinetic: {
    tagline: 'moving, chaotic, performative',
    base: ['flow-field'],
    mid: ['waveform', 'ripple', 'glow-orb'],
    top: ['scan-line', 'film-grain'],
    transitions: ['wipe', 'fade'],
    transitionFrames: [8, 12],
    notes: 'High motion, overlapping rhythm, the screen never sits still. Mood shifts feel abrupt. Favor electric, noir, cosmic.',
  },
};

// ---------- estimate TTS pacing ----------

function wordCount(text) {
  return (text || '').split(/\s+/).filter(Boolean).length;
}
function estSeconds(text) {
  return wordCount(text) / WORDS_PER_SECOND;
}

function formatSpec(format) {
  if (format === '15s') {
    return {
      totalFramesMin: 360, totalFramesMax: 450,
      sceneCount: [2, 3],
      narrationMin: 30, narrationMax: 45,
      checkpoints: [
        { id: 'hook',      startF:   0, endF: 120, role: 'hook — text visible frame 1, big font, <=6 words' },
        { id: 'turn',      startF: 120, endF: 360, role: 'turn — mood MUST contrast scene 1' },
        { id: 'loopback',  startF: 360, endF: 450, role: 'optional coda/loop-back — recontextualize the hook' },
      ],
    };
  }
  return {
    totalFramesMin: 750, totalFramesMax: 900,
    sceneCount: [4, 4],
    narrationMin: 55, narrationMax: 75,
    checkpoints: [
      { id: 'hook',         startF:   0, endF:  90, role: 'hook — curiosity gap, text from frame 1, retention gate' },
      { id: 'setup',        startF:  90, endF: 300, role: 'setup — specifics, escalation, viewer deciding if worth 30s' },
      { id: 'second_hook',  startF: 300, endF: 540, role: 'second hook — swipe-temptation spike, harder turn or counter-claim' },
      { id: 'payoff',       startF: 540, endF: 900, role: 'payoff + loop — recontextualize hook so rewatch lands again' },
    ],
  };
}

// ---------- designer prompt ----------

function designerSystemPrompt({ format, direction, copy }) {
  const fmt = formatSpec(format);
  const dir = DIRECTION_BRIEFS[direction];
  const checkpointLines = fmt.checkpoints.map(c =>
    `  - ${c.id} (${c.startF}-${c.endF}f / ${(c.startF/FPS).toFixed(1)}-${(c.endF/FPS).toFixed(1)}s): ${c.role}`
  ).join('\n');

  return `You are a VISUAL DESIGNER for a ${format} YouTube Short. The copy has already been written and APPROVED. Your job is to translate beat-mood + narration into a concrete VideoSpec: scene kinds, visual layer stacks, text animations, fonts, positions, transitions, palette.

DO NOT rewrite the narration wording. Treat it as fixed.

FORMAT: ${format}.
Scene count: ${fmt.sceneCount[0] === fmt.sceneCount[1] ? fmt.sceneCount[0] : fmt.sceneCount.join('-')}.
Total frames: ${fmt.totalFramesMin}-${fmt.totalFramesMax} @ ${FPS}fps.
Per-scene minimum: ${SCENE_MIN_FRAMES} frames (3.0s) — never go below this even for short loopback scenes.
Checkpoints (scene durationInFrames MUST land a scene inside each checkpoint's window):
${checkpointLines}

${format === '30s' ? `30s-ADAPT RULE: the source copy has ${copy.scenes.length} scenes and ${wordCount(copy.narration_full)} words.
You MUST output exactly 4 scenes mapped to the checkpoints above. Do it by:
(a) splitting ONE source scene's narration at a natural comma/period into two scenes, keeping total words IDENTICAL to the source — preferred, and
(b) if (a) is impossible, set "needs_more_copy": true at the top level and explain in "downgrade_note" — still emit your best 4-scene attempt, but flag it.
Never invent new words. The copy is locked.` : `15s-ADAPT RULE: use the source scenes as-is. Assign scene ids to match the checkpoint ids (hook, turn, and optionally loopback).`}

DIRECTION: "${direction}" — ${dir.tagline}.
Primitive palette (stay inside this vocabulary):
  base layer (always include 1): ${dir.base.join(', ')}
  mid accent (1-2): ${dir.mid.join(', ')}
  top texture (0-1): ${dir.top.join(', ')}
Transitions: ${dir.transitions.join(' or ')} (${dir.transitionFrames[0]}-${dir.transitionFrames[1]} frames).
${dir.notes}

MOOD MAPPING: copy beat-moods are emotional (e.g. "casual", "chaotic", "confessional", "amused"). Translate each to ONE palette mood from: ${MOODS.join(', ')}. Scene 1 and scene 2 MUST use DIFFERENT palette moods (mood contrast is mandatory).

SCENE KINDS: ${SCENE_KINDS.join(', ')}.
- text-typewriter: simple. Use for short punchy beats.
  params: { text, fontSize (48-64 short, 40-52 long), typingSpeed (1.0-2.0), mood, variation (0-5) }
- quote-card: framed quotation. Use when a scene is a literal quoted line.
  params: { quote, fontSize (40-60), mood, variation (0-3) }
- composable: layered visuals + text. DEFAULT choice for atmospheric/kinetic.
  params: { visualLayers: [{primitive, params}], text: {content, animation, fontSize, position, maxWidth 800}, mood }
  Text animations: typewriter, fade-in, word-by-word, letter-scatter.
    HARD: letter-scatter breaks mid-word when text wraps. Only use when scene text has <=8 words.
  Text positions: center, bottom-center, top-center.

FONT SIZE RULE: shorter text = bigger font.
  5-7 words  → fontSize 56-64
  8-12 words → fontSize 44-52
  13+ words  → fontSize 40-48 (composable only, maxWidth 800)

HOOK SCENE RULE: text visible from frame 1. Prefer kind=composable with animation=fade-in or word-by-word. If the hook text is <=6 words, letter-scatter is allowed.

Output STRICT JSON:
{
  "direction": "${direction}",
  "format": "${format}",
  "palette": { "seedHue": 0-360, "harmony": "analogous|complementary|triadic|split", "mood": "one of ${MOODS.join('/')}" },
  "scenes": [
    {
      "id": "hook" | "setup" | "second_hook" | "payoff" | "turn" | "loopback",
      "kind": "...",
      "durationInFrames": number (inside the checkpoint window),
      "narration": "exact copy narration for this scene",
      "mood_copy": "source beat-mood",
      "mood_palette": "mapped palette mood",
      "params": { ... per kind shape ... },
      "design_rationale": "<=20 words: why THIS kind + THESE layers + THIS animation for THIS beat"
    }
  ],
  "transitions": [{ "kind": "fade|slide|wipe", "durationInFrames": number, "direction": "from-left|from-right|from-top|from-bottom" (only for slide/wipe) }],
  "needs_more_copy": boolean,
  "downgrade_note": "<=25 words if needs_more_copy, else empty"
}

SELF-CHECK before outputting:
1. Scene count matches format requirement (${fmt.sceneCount[0] === fmt.sceneCount[1] ? fmt.sceneCount[0] : fmt.sceneCount.join(' or ')} for ${format}).
2. Each scene's durationInFrames falls inside its checkpoint's window.
3. Scene 1 and scene 2 have DIFFERENT mood_palette values.
4. letter-scatter only appears where word count <=8.
5. Font sizes obey the rule above.
6. Narration matches source EXACTLY (no rewording, only optional splits for 30s).
7. Every composable scene has 2-4 visualLayers with 1 base + 1-2 mid + 0-1 top primitives from the DIRECTION palette.
8. Transitions array length = scenes.length - 1.`;
}

function userPrompt({ copy, format }) {
  const sceneLines = copy.scenes.map((s, i) =>
    `  scene ${i+1} [mood=${s.mood}, ${wordCount(s.narration)}w]: "${s.narration}"`
  ).join('\n');
  return `Source copy (LOCKED — do not reword):
  variant: ${copy.variant} (${copy.label})
  hook: "${copy.hook}"
  loop_check: ${copy.loop_check}
  narration_full (${wordCount(copy.narration_full)} words): "${copy.narration_full}"
  beats:
${sceneLines}

Design this as ${format}.`;
}

async function designOne({ copy, format, direction }) {
  const system = designerSystemPrompt({ format, direction, copy });
  const prompt = userPrompt({ copy, format });
  const out = await llm({ purpose: 'reasoning', system, prompt });
  const parsed = extractJson(out.text);
  return { parsed, model: out.model_used };
}

// ---------- alignment checks ----------

function alignmentReport(design, copy, format) {
  const fmt = formatSpec(format);
  const scenes = design.scenes || [];
  const total = scenes.reduce((a, s) => a + (s.durationInFrames || 0), 0);
  const warnings = [];

  // Scene count
  const [minC, maxC] = fmt.sceneCount;
  if (scenes.length < minC || scenes.length > maxC) {
    warnings.push(`scene count ${scenes.length}, expected ${minC === maxC ? minC : `${minC}-${maxC}`} for ${format}`);
  }

  // Total duration
  if (total < fmt.totalFramesMin) warnings.push(`total ${total}f under min ${fmt.totalFramesMin}f (${(total/FPS).toFixed(1)}s)`);
  if (total > fmt.totalFramesMax) warnings.push(`total ${total}f over max ${fmt.totalFramesMax}f (${(total/FPS).toFixed(1)}s)`);

  // Per-scene: compare allotted frames vs expected frames from word count
  const rows = [];
  let cursor = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const words = wordCount(s.narration);
    const estSec = words / WORDS_PER_SECOND;
    const expectedFrames = Math.ceil(estSec * FPS) + VOICE_LEAD_FRAMES + VOICE_TAIL_FRAMES;
    const allotted = s.durationInFrames || 0;
    const allottedSec = allotted / FPS;
    const checkpoint = fmt.checkpoints[i];
    const inWindow = checkpoint
      ? (allotted >= (checkpoint.endF - checkpoint.startF) * 0.5 && cursor + allotted <= checkpoint.endF + 30)
      : null;
    rows.push({
      idx: i + 1,
      id: s.id,
      words,
      estSec: +estSec.toFixed(1),
      allotted,
      allottedSec: +allottedSec.toFixed(1),
      expectedFrames,
      delta: allotted - expectedFrames,
      checkpoint: checkpoint?.id || '(none)',
      checkpointRange: checkpoint ? `${checkpoint.startF}-${checkpoint.endF}f` : '—',
      cursorStart: cursor,
      cursorEnd: cursor + allotted,
    });
    if (allotted < SCENE_MIN_FRAMES) warnings.push(`scene ${i+1} (${s.id}) ${allotted}f under SCENE_MIN_FRAMES ${SCENE_MIN_FRAMES}f`);
    if (checkpoint && (cursor > checkpoint.endF || cursor + allotted < checkpoint.startF)) {
      warnings.push(`scene ${i+1} (${s.id}) at ${cursor}-${cursor+allotted}f falls outside checkpoint ${checkpoint.id} ${checkpoint.startF}-${checkpoint.endF}f`);
    }
    // Font size sanity
    const fontSize = s.params?.fontSize ?? s.params?.text?.fontSize;
    if (fontSize) {
      if (words <= 7 && fontSize < 52) warnings.push(`scene ${i+1}: ${words}w wants fontSize 56-64, got ${fontSize}`);
      if (words >= 13 && fontSize > 50) warnings.push(`scene ${i+1}: ${words}w wants fontSize 40-48, got ${fontSize}`);
    }
    // letter-scatter word limit
    const anim = s.params?.text?.animation;
    if (anim === 'letter-scatter' && words > 8) warnings.push(`scene ${i+1}: letter-scatter with ${words} words (limit 8) — will break mid-word`);
    cursor += allotted;
  }

  // Mood contrast
  const m1 = scenes[0]?.mood_palette;
  const m2 = scenes[1]?.mood_palette;
  if (m1 && m2 && m1 === m2) warnings.push(`scene 1 and scene 2 share mood_palette=${m1} (mood contrast is mandatory)`);

  // Hook length
  const hookWords = wordCount(scenes[0]?.narration);
  if (hookWords > 8) warnings.push(`hook is ${hookWords} words (ideal <=6 for frame-1 visibility)`);

  // Transitions count
  const expectedTrans = Math.max(0, scenes.length - 1);
  const gotTrans = (design.transitions || []).length;
  if (gotTrans !== expectedTrans) warnings.push(`transitions count ${gotTrans}, expected ${expectedTrans}`);

  // Narration preservation: compare designer scene narrations to source
  // scene narrations (join). narration_full is the descriptive long-form
  // audio script; the per-scene narration tags are the canonical
  // designer input. For 30s designs, designer may legitimately add ONE
  // bridging scene (split or repaired from narration_full) — flag only
  // when the divergence is large.
  const srcSceneJoin = (copy.scenes || []).map(s => s.narration || '').join(' ').toLowerCase().replace(/[^a-z0-9\s']/g, '');
  const newSceneJoin = scenes.map(s => s.narration || '').join(' ').toLowerCase().replace(/[^a-z0-9\s']/g, '');
  const srcTokens = new Set(srcSceneJoin.split(/\s+/).filter(Boolean));
  const newTokens = newSceneJoin.split(/\s+/).filter(Boolean);
  const fromSource = newTokens.filter(t => srcTokens.has(t)).length;
  const fromOutside = newTokens.length - fromSource;
  // For 15s the designer should preserve scene text ~1:1 — flag anything noisy.
  // For 30s with 4 required scenes + 3-scene source, the designer may legitimately
  // pull from narration_full to bridge — allow some outside tokens.
  const allowedOutside = format === '30s' ? 8 : 2;
  if (fromOutside > allowedOutside) {
    warnings.push(`scene narration deviates from source: ${fromOutside} new tokens not in source scene text (cap=${allowedOutside} for ${format})`);
  }

  return { total, totalSec: +(total/FPS).toFixed(1), rows, warnings };
}

// ---------- markdown renderer ----------

function renderMarkdown({ copy, format, designs }) {
  const fmt = formatSpec(format);
  const lines = [];
  lines.push(`# Design — ${copy.variant} · ${format}`);
  lines.push('');
  lines.push(`**Hook:** ${copy.hook}`);
  lines.push(`**Title:** ${copy.title}`);
  lines.push(`**Loop check (from copy draft):** ${copy.loop_check}`);
  lines.push('');
  lines.push(`**Source narration (${wordCount(copy.narration_full)} words, est ${estSeconds(copy.narration_full).toFixed(1)}s @ ${WORDS_PER_SECOND}wps):**`);
  lines.push(`> ${copy.narration_full}`);
  lines.push('');
  lines.push(`**Format target:** ${fmt.totalFramesMin}-${fmt.totalFramesMax}f (${(fmt.totalFramesMin/FPS).toFixed(1)}-${(fmt.totalFramesMax/FPS).toFixed(1)}s), ${fmt.sceneCount[0] === fmt.sceneCount[1] ? fmt.sceneCount[0] : fmt.sceneCount.join('-')} scenes, ${fmt.narrationMin}-${fmt.narrationMax} narration words.`);
  const srcWords = wordCount(copy.narration_full);
  if (srcWords < fmt.narrationMin) {
    lines.push(`> **⚠ UNDER-FILLED for ${format}**: source is ${srcWords} words, need ${fmt.narrationMin}+. 30s designs will struggle or pad.`);
  }
  lines.push('');

  // Loop-back adjacency
  const hookLine = copy.scenes[0]?.narration;
  const finalLine = copy.scenes[copy.scenes.length - 1]?.narration;
  lines.push(`## Loop-back adjacency`);
  lines.push('```');
  lines.push(`hook  → "${hookLine}"`);
  lines.push(`final → "${finalLine}"`);
  lines.push('```');
  lines.push(`_Reviewer: read those two back-to-back. Does the hook now land differently?_`);
  lines.push('');

  for (const d of designs) {
    lines.push(`---`);
    lines.push('');
    lines.push(`## Direction: ${d.direction}`);
    if (d.error) { lines.push(`**ERROR:** ${d.error}`); lines.push(''); continue; }
    const design = d.parsed;
    const report = d.report;
    lines.push(`model: \`${d.model}\` · total ${report.total}f (${report.totalSec}s) · palette hue=${design.palette?.seedHue} ${design.palette?.harmony} mood=${design.palette?.mood}`);
    if (design.needs_more_copy) lines.push(`> **flagged:** ${design.downgrade_note || 'needs more copy'}`);
    lines.push('');

    lines.push(`### Alignment`);
    lines.push('');
    lines.push('| # | id | words | est_s | allotted_f | allotted_s | Δ(f) | cursor | checkpoint | window |');
    lines.push('|---|----|------:|------:|-----------:|-----------:|-----:|-------:|-----------|--------|');
    for (const r of report.rows) {
      lines.push(`| ${r.idx} | ${r.id} | ${r.words} | ${r.estSec} | ${r.allotted} | ${r.allottedSec} | ${r.delta >= 0 ? '+' : ''}${r.delta} | ${r.cursorStart}-${r.cursorEnd} | ${r.checkpoint} | ${r.checkpointRange} |`);
    }
    lines.push('');
    if (report.warnings.length) {
      lines.push(`**⚠ warnings**`);
      for (const w of report.warnings) lines.push(`- ${w}`);
      lines.push('');
    } else {
      lines.push(`**✓ no alignment warnings**`);
      lines.push('');
    }

    lines.push(`### Scenes`);
    for (let i = 0; i < (design.scenes || []).length; i++) {
      const s = design.scenes[i];
      lines.push('');
      lines.push(`**${i + 1}. [${s.id}] ${s.kind} — ${s.mood_copy} → ${s.mood_palette}**`);
      lines.push(`> "${s.narration}"`);
      lines.push('');
      if (s.kind === 'composable') {
        const layers = s.params?.visualLayers || [];
        lines.push(`- layers: ${layers.map(l => `\`${l.primitive}\``).join(' → ') || '(none)'}`);
        const t = s.params?.text;
        if (t) lines.push(`- text: \`${t.animation || '?'}\` · fontSize ${t.fontSize || '?'} · position ${t.position || '?'} · maxWidth ${t.maxWidth || '?'}`);
      } else if (s.kind === 'text-typewriter') {
        lines.push(`- fontSize ${s.params?.fontSize || '?'} · typingSpeed ${s.params?.typingSpeed || '?'} · variation ${s.params?.variation ?? '?'}`);
      } else if (s.kind === 'quote-card') {
        lines.push(`- fontSize ${s.params?.fontSize || '?'} · variation ${s.params?.variation ?? '?'}`);
      }
      lines.push(`- duration: ${s.durationInFrames}f (${(s.durationInFrames/FPS).toFixed(1)}s)`);
      if (s.design_rationale) lines.push(`- _${s.design_rationale}_`);
    }
    lines.push('');

    lines.push(`### Transitions`);
    const trans = design.transitions || [];
    for (let i = 0; i < trans.length; i++) {
      const t = trans[i];
      const dir = t.direction ? ` ${t.direction}` : '';
      lines.push(`- scene ${i+1} → ${i+2}: \`${t.kind}\`${dir} (${t.durationInFrames}f / ${(t.durationInFrames/FPS).toFixed(2)}s)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------- VideoSpec assembly (production-shaped) ----------

function assembleVideoSpec({ design, copy, format, direction }) {
  // Shape matches buildFullSpec in yt-compose.mjs so this spec could
  // flow into the existing renderer without further transformation.
  const ambientMoodMap = {
    contemplative: 'ambient-contemplative.mp3',
    cosmic:        'ambient-cosmic.mp3',
    electric:      'ambient-electric.mp3',
    dawn:          'ambient-electric.mp3',
    warm:          'ambient-warm.mp3',
    noir:          'ambient-noir.mp3',
    ethereal:      'ambient-cosmic.mp3',
  };
  const ambient = ambientMoodMap[design.palette?.mood] || 'ambient.mp3';

  return {
    id: `design-${copy.variant}-${format}-${direction}-${Date.now()}`,
    version: 1,
    fps: FPS,
    width: 1080,
    height: 1920,
    brand: {
      colors: {
        bg: '#0a0a0f', accent: '#f97316', text: '#e4e4e7',
        textMuted: '#71717a', textDim: 'rgba(255,255,255,0.4)',
      },
      fonts: {
        sans: 'Inter, system-ui, -apple-system, sans-serif',
        mono: 'JetBrains Mono, SF Mono, Menlo, monospace',
        display: "'Smooch Sans', system-ui, sans-serif",
      },
      glass: {
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        backdropFilter: 'blur(20px)',
      },
    },
    palette: design.palette,
    music: { src: `audio/${ambient}`, startFrame: 0, volume: 0.15 },
    voiceovers: [], // populated later by TTS pass
    transitions: design.transitions,
    scenes: design.scenes.map(s => ({
      id: s.id,
      kind: s.kind,
      durationInFrames: s.durationInFrames,
      params: s.params,
      narration: s.narration,
    })),
    // Designer-only metadata preserved for review (stripped before render)
    _design: {
      direction,
      format,
      sourceVariant: copy.variant,
      needsMoreCopy: design.needs_more_copy || false,
      downgradeNote: design.downgrade_note || '',
      perSceneRationale: design.scenes.map(s => ({ id: s.id, rationale: s.design_rationale })),
    },
  };
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const variant of COPY_VARIANTS) {
    const copyPath = path.join(COPY_DIR, `${variant}.json`);
    if (!fs.existsSync(copyPath)) {
      console.error(`[design] missing copy: ${copyPath} — skip`);
      continue;
    }
    const copy = JSON.parse(fs.readFileSync(copyPath, 'utf8'));
    console.log(`\n[design] copy: ${variant} — "${copy.title}" (${wordCount(copy.narration_full)}w)`);

    for (const format of FORMATS) {
      const designs = [];
      for (const direction of DIRECTIONS) {
        process.stdout.write(`[design]   ${format} · ${direction}... `);
        try {
          const { parsed, model } = await designOne({ copy, format, direction });
          const report = alignmentReport(parsed, copy, format);
          const spec = assembleVideoSpec({ design: parsed, copy, format, direction });
          const outPath = path.join(OUT_DIR, `${variant}-${format}-${direction}.json`);
          fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
          designs.push({ direction, parsed, model, report });
          const w = report.warnings.length;
          console.log(`✓ ${report.total}f · ${w} warning${w === 1 ? '' : 's'}`);
        } catch (e) {
          console.log(`ERROR: ${e.message.slice(0, 120)}`);
          designs.push({ direction, error: e.message });
        }
      }
      const md = renderMarkdown({ copy, format, designs });
      fs.writeFileSync(path.join(OUT_DIR, `${variant}-${format}.md`), md);
      console.log(`[design]   → ${variant}-${format}.md`);
    }
  }

  console.log(`\n[design] done. Open ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
