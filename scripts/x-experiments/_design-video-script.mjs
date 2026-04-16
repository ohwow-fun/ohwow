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

// ---------- Phase 5: provider alternation constants ----------
//
// Seedance 1.0 Pro via fal: max 5s per clip (usually), ~$0.50/clip,
// ~60s generation wall clock. Below 3s the clip reads as a still.
// These hard caps flow into both the pass-1 system prompt (so the LLM
// respects them when choosing durations + providers) and a post-LLM
// normalizer (so violations get downgraded to remotion automatically).

const ENABLE_SEEDANCE = process.env.ENABLE_SEEDANCE === '1';
const SEEDANCE_MAX_SECONDS = 5;
const SEEDANCE_MIN_SECONDS = 3;
const SEEDANCE_MAX_FRAMES = SEEDANCE_MAX_SECONDS * FPS;  // 150f
const SEEDANCE_MIN_FRAMES = SEEDANCE_MIN_SECONDS * FPS;  // 90f (equals SCENE_MIN_FRAMES — tidy)
const SEEDANCE_COST_USD_PER_SECOND = 0.10;   // Seedance 1.0 Pro: ~$0.50 / 5s
const SEEDANCE_WALLCLOCK_SECONDS = 60;       // per handoff notes
const MAX_SEEDANCE_PER_FORMAT = { '15s': 1, '30s': 2 };

const STYLE_REGISTERS = [
  'photographic', 'cinematic-noir', 'dreamlike', 'documentary',
  'glitched', 'cctv', 'super-8',
];

// Non-binding suggested register per (direction, palette_mood).
// Cinematographer sees this as a hint and may deviate with a rationale.
const REGISTER_HINTS = {
  atmospheric: {
    noir: 'cinematic-noir', electric: 'dreamlike', cosmic: 'dreamlike',
    contemplative: 'documentary', warm: 'photographic',
    ethereal: 'dreamlike', dawn: 'photographic',
  },
  geometric: {
    noir: 'cinematic-noir', electric: 'glitched', cosmic: 'cinematic-noir',
    contemplative: 'photographic', warm: 'photographic',
    ethereal: 'photographic', dawn: 'photographic',
  },
  kinetic: {
    noir: 'glitched', electric: 'glitched', cosmic: 'glitched',
    contemplative: 'documentary', warm: 'documentary',
    ethereal: 'super-8', dawn: 'super-8',
  },
};

// Style anchor appended as the final clause of the compiled Seedance
// paragraph — these phrases are what actually steer the model's render.
// Every anchor must contain at least one keyword from
// scripts/video/lint-prompt.sh's STYLE regex
// (photorealistic|documentary|shot on|35mm|iPhone|Sony|cinematic|film grain)
// so the compiled paragraph passes lint without extra work.
const REGISTER_ANCHORS = {
  'photographic':    'cinematic photorealistic style, shot on Sony FX3, natural colour, subtle grain',
  'cinematic-noir':  'cinematic noir, anamorphic, desaturated palette, hard chiaroscuro',
  'dreamlike':       'cinematic dreamlike, shot on 35mm, soft diffusion, lens haze, pastel grade, floaty camera',
  'documentary':     'documentary style, handheld, natural light, lived-in, mild grain',
  'glitched':        'cinematic glitched aesthetic, shot on VHS, CRT scanlines, chromatic aberration, analog noise',
  'cctv':            'cinematic low-fi security-camera aesthetic, documentary surveillance framing, barrel distortion, greenish tint, volumetric haze',
  'super-8':         'cinematic super-8 film grain, warm color bleed, gate weave, vignette',
};

// Always-injected safety negatives. Never dropped.
const NEGATIVE_BASELINE = 'text, captions, subtitles, readable screens, numerals, logos, brand names, watermarks, recognizable faces, cartoon, anime, illustrated';

// Register-specific negatives layered on top of the baseline.
// Invariant: a negative MUST NOT contradict its own anchor. "Film grain" was
// removed from photographic + documentary because both anchors already steer
// toward subtle/mild grain — conflicting directives fight inside the diffusion
// model. Check REGISTER_ANCHORS before adding back.
const REGISTER_NEGATIVES = {
  'photographic':    'anamorphic, lens flare, over-saturation',
  'cinematic-noir':  '',
  'dreamlike':       'harsh shadows, high contrast, hard edges, desaturation',
  'documentary':     'color grade, anamorphic, slow motion',
  'glitched':        '',
  'cctv':            'smooth cinematic motion, shallow depth of field, color grade',
  'super-8':         'digital sharpness, modern color grade, ultra-high resolution',
};

// FNV-1a 32-bit hash, used to derive a deterministic seed per Seedance
// scene so reruns hit the fal cache as long as structured JSON doesn't
// change. See fal-adapter.ts:84 for the cache key shape.
function fnv1a(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}
function deriveSeed({ variant, sceneId, format, direction }) {
  return fnv1a(`${variant}|${sceneId}|${format}|${direction}`) & 0x7fffffff;
}

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

  const seedanceBlock = ENABLE_SEEDANCE ? `
PROVIDER SELECTION (Phase 5 alternation)
Each scene gets a "provider" field: "remotion" | "seedance".
  - "remotion"  — typography + primitive layers (what you normally design).
  - "seedance"  — a photoreal video clip from Seedance 1.0 Pro. Costs ~$0.50/scene, ~60s to generate.

Rubric — respect but interpret:
  hook         → default remotion. Only seedance if the hook copy is a LITERAL scene description (e.g. "3 AM, empty coffee"). Seedance latency risks break the instant frame-1 categorization.
  setup        → 50/50. Archetype-driven ("the apologetic one said…") → remotion. Anecdotal/scene-based ("late at night, the rack hums") → seedance.
  second_hook  → default remotion. Swipe-spike wants a mood-flip text zap; only seedance for a specific image reveal.
  payoff/loopback → text punchline → remotion. Visual punchline → seedance.

HARD CONSTRAINTS (the normalizer will auto-correct violations; minimise corrections by following these up front):
  1. SEEDANCE MAX DURATION = 150 frames (5 seconds). A scene with provider=seedance MUST have durationInFrames in [${SEEDANCE_MIN_FRAMES}, ${SEEDANCE_MAX_FRAMES}]. If the narrative wants longer, either keep the scene at exactly 150f and redistribute the freed frames into adjacent remotion scenes (while all scenes stay inside their checkpoint windows), OR assign remotion.
  2. ${format === '15s' ? 'MAX 1 seedance scene per video.' : 'MAX 2 seedance scenes per video, NEVER adjacent.'}
  3. Scene 1 defaults remotion unless the copy opens with a literal scene/time/place cue ("3 AM…", "in a kitchen…", "the rack hums…").
  4. When you pick seedance, the scene's narration should read well without burnt-in text — the clip is photoreal footage and any Remotion overlay is composited on top.
` : '';

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

${seedanceBlock}
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
      ${ENABLE_SEEDANCE ? `"provider": "remotion" | "seedance",
      "provider_rationale": "<=20 words: why this provider for this beat",` : ''}
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
8. Transitions array length = scenes.length - 1.${ENABLE_SEEDANCE ? `
9. Every seedance scene has durationInFrames in [${SEEDANCE_MIN_FRAMES}, ${SEEDANCE_MAX_FRAMES}].
10. At most ${MAX_SEEDANCE_PER_FORMAT[format]} seedance scene${MAX_SEEDANCE_PER_FORMAT[format] === 1 ? '' : 's'} total${format === '30s' ? ', and no two seedance scenes are adjacent' : ''}.
11. Scene 1 is seedance only if its narration opens with a literal scene/time/place cue.` : ''}`;
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
  const providerWarnings = normalizeProviders(parsed, format);
  return { parsed, model: out.model_used, providerWarnings };
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

// ---------- Phase 5: provider normalization ----------
//
// Enforce the three hard constraints after the LLM response lands:
//   1. Seedance scenes fit in [90f, 150f].
//   2. Max N seedance scenes per format (+ non-adjacent for 30s).
//   3. Scene 1 defaults remotion unless narration opens with a scene cue.
// Emits warnings describing every downgrade so review surfaces them.

function normalizeProviders(design, format) {
  if (!ENABLE_SEEDANCE) return [];
  const scenes = design.scenes || [];
  const warnings = [];
  const maxSeedance = MAX_SEEDANCE_PER_FORMAT[format] ?? 0;

  // Seed any missing provider field so downstream logic is uniform.
  for (const s of scenes) {
    if (s.provider !== 'seedance') s.provider = 'remotion';
  }

  // 1. Eligibility gate: Seedance clip length is 3-5s. Anything outside
  //    that window can't be a photoreal clip.
  for (const s of scenes) {
    if (s.provider !== 'seedance') continue;
    const d = s.durationInFrames || 0;
    if (d < SEEDANCE_MIN_FRAMES || d > SEEDANCE_MAX_FRAMES) {
      warnings.push(`provider: scene ${s.id} requested seedance but ${d}f is outside [${SEEDANCE_MIN_FRAMES},${SEEDANCE_MAX_FRAMES}] — downgraded to remotion`);
      s.provider = 'remotion';
    }
  }

  // 2. Scene-1 default: unless the opening narration names a scene cue.
  if (scenes[0]?.provider === 'seedance') {
    const open = String(scenes[0].narration || '').toLowerCase().slice(0, 80);
    const looksLikeSceneCue = /(\d{1,2}\s?(am|pm|:\d{2})|at (dawn|dusk|midnight|noon|night|the office|home|work)|\b(in|inside|on|at)\s+(a|an|the)\s+(kitchen|bedroom|office|bar|cafe|park|car|room|desk|basement|rooftop|alley|warehouse|hallway|street|lobby|corridor|studio|lab|garage|attic|basement|shed)\b|\bthe\s+(room|office|screen|monitor|laptop|phone|rack|fan|lamp|window|door|hallway|corridor|street|city|sky|dawn|dusk|night|morning|building|studio|lab|garage|rain|fog|mist|steam)\b|\b(late|early)\s+(morning|night|afternoon|evening)\b|\b(rain|fog|snow|mist|steam|smoke|dust|candle)\b)/;
    if (!looksLikeSceneCue.test(open)) {
      warnings.push(`provider: scene 1 (${scenes[0].id}) downgraded to remotion — narration doesn't open with a literal scene/time/place cue`);
      scenes[0].provider = 'remotion';
    }
  }

  // 3. Alternation cap. Downgrade rightmost first so the earlier
  //    (more narratively motivated) seedance scene survives.
  let count = scenes.filter(s => s.provider === 'seedance').length;
  for (let i = scenes.length - 1; i >= 0 && count > maxSeedance; i--) {
    if (scenes[i].provider === 'seedance') {
      warnings.push(`provider: scene ${scenes[i].id} downgraded — exceeds max=${maxSeedance} seedance for ${format}`);
      scenes[i].provider = 'remotion';
      count--;
    }
  }

  // 4. Non-adjacency (30s). Keep the earlier seedance scene.
  if (format === '30s') {
    for (let i = 1; i < scenes.length; i++) {
      if (scenes[i].provider === 'seedance' && scenes[i - 1].provider === 'seedance') {
        warnings.push(`provider: scene ${scenes[i].id} downgraded — adjacent to another seedance scene`);
        scenes[i].provider = 'remotion';
      }
    }
  }

  return warnings;
}

function providerStats(design) {
  const scenes = design.scenes || [];
  const seedanceScenes = scenes.filter(s => s.provider === 'seedance');
  const seedanceIndexes = scenes.map((s, i) => s.provider === 'seedance' ? i + 1 : null).filter(x => x !== null);
  const clipSeconds = seedanceScenes.reduce((a, s) =>
    a + Math.max(SEEDANCE_MIN_SECONDS, Math.min(SEEDANCE_MAX_SECONDS, Math.round((s.durationInFrames || 0) / FPS))), 0);
  const costUsd = +(clipSeconds * SEEDANCE_COST_USD_PER_SECOND).toFixed(2);
  const wallclockSec = seedanceScenes.length * SEEDANCE_WALLCLOCK_SECONDS;
  const providerTrace = scenes.map(s => s.provider === 'seedance' ? 'S' : 'R').join(' → ');
  return {
    count: seedanceScenes.length,
    clipSeconds,
    costUsd,
    wallclockSec,
    providerTrace,
    seedanceIndexes,
  };
}

// ---------- Phase 5: cinematographer (pass 2) ----------

// Symmetric domain-sibling pairs that don't count as a real cross-domain
// jump. The cinematographer must emit narration_domain + domain_chosen as
// the first block of its JSON; the validator rejects the response when the
// two sides of the shot live in the same domain or a trivial sibling. Extend
// this list whenever a sweep surfaces a new lazy pairing — it's cheaper to
// block it here than to notice the cliché after $18 of Seedance renders.
const FORBIDDEN_DOMAIN_SIBLINGS = [
  ['software', 'hardware'],
  ['software', 'electronics'],
  ['software', 'circuit'],
  ['software', 'circuitboard'],
  ['software', 'computer'],
  ['software', 'computing'],
  ['software', 'code'],
  ['software', 'coding'],
  ['software', 'programming'],
  ['software', 'tech'],
  ['software', 'technology'],
  ['software', 'IT'],
  ['code', 'keyboard'],
  ['code', 'programming'],
  ['code', 'computer'],
  ['programming', 'keyboard'],
  ['programming', 'computer'],
  ['office', 'workstation'],
  ['office', 'workplace'],
  ['office', 'desk'],
  ['office', 'cubicle'],
  ['tech', 'hardware'],
  ['tech', 'electronics'],
  ['engineering', 'hardware'],
  ['engineering', 'electronics'],
].map(([a, b]) => [a.toLowerCase(), b.toLowerCase()]);

function normalizeDomain(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z]/g, '');
}

function checkDomainDistance(narrationDomain, domainChosen) {
  const a = normalizeDomain(narrationDomain);
  const b = normalizeDomain(domainChosen);
  if (!a) return { forbidden: true, reason: 'missing narration_domain' };
  if (!b) return { forbidden: true, reason: 'missing domain_chosen' };
  if (a === b) return { forbidden: true, reason: `same domain: "${a}"` };
  for (const [x, y] of FORBIDDEN_DOMAIN_SIBLINGS) {
    if ((a === x && b === y) || (a === y && b === x)) {
      return { forbidden: true, reason: `sibling domains: "${a}" ↔ "${b}"` };
    }
  }
  return { forbidden: false };
}

// Compact the x-intel seed into a brief the cinematographer can actually
// metabolise. Null when no seed is available (back-compat).
function formatKbSeed(kbSeed) {
  if (!kbSeed) return '';
  const lines = [];
  if (kbSeed.headline) lines.push(`headline:  ${kbSeed.headline}`);
  if (kbSeed.bucket) lines.push(`bucket:    ${kbSeed.bucket}`);
  if (kbSeed.pattern) lines.push(`pattern:   ${kbSeed.pattern}`);
  if (kbSeed.date) lines.push(`date:      ${kbSeed.date}`);
  if (Array.isArray(kbSeed.highlights) && kbSeed.highlights.length) {
    lines.push(`highlights:`);
    for (const h of kbSeed.highlights.slice(0, 4)) {
      const text = typeof h === 'string' ? h : (h.text || '');
      if (text) lines.push(`  - ${text}`);
    }
  }
  return lines.length ? lines.join('\n') : '';
}

function cinematographerSystemPrompt({ format, direction, palette_mood }) {
  const suggested = REGISTER_HINTS[direction]?.[palette_mood] || 'photographic';
  return `You are a CINEMATOGRAPHER for a 9:16 vertical ${format} YouTube Short. Pass 1 handed you ONE scene because a photoreal 5-second clip will land harder than Remotion typography. Stay inside the story — don't direct a different movie.

The narration is locked; do not rewrite it. TEXT WILL NOT APPEAR IN THE VIDEO FRAME — any words are composited on top by Remotion. Design as if no words will ever be burnt in.

HARD RULES (failing any = invalid output):
 1. No brand names, logos, wordmarks, UI, packaging, or readable screens.
 2. No copyrighted characters or costumed IP.
 3. No recognizable real people. Silhouettes, backs-of-heads, hands-only, obscured faces are fine. Faces must stay ambiguous.
 4. No text, captions, numerals, labels, subtitles, signage anywhere in the frame.
 5. SFW. No nudity, gore, weapons, drugs, political symbols, children.
 6. Aspect ratio 9:16 is fixed. Duration is an integer between 2 and 5 seconds (Seedance 1.0 Pro cap).

DIRECTION LENS: ${direction}
  atmospheric  mood over action. Camera barely moves. Long lenses, shallow depth.
  geometric    architectural composition, leading lines, grids. Locked-off or precisely motivated motion.
  kinetic      handheld / tracking / rack focus / overlapping motion. Never still.

MOOD TEMPERATURE: ${palette_mood}
Use this as the shot's dominant temperature (light colour, shadow depth, subject stillness vs agitation, lens character). Don't name the mood word in any field — translate it into lighting + motion.

STYLE REGISTER (pick EXACTLY ONE — no soft default; let the principles lead you):
  photographic, cinematic-noir, dreamlike, documentary, glitched, cctv, super-8.
Do NOT blend registers. Pick the one that actually serves the shot you've decided on.

A WORKING TRUTH OF THE CRAFT
The first image you think of is almost always wrong. That's the stock image every other cinematographer has also reached for. Your job is the SECOND image — the one that surprises even you, and still fits. If your first candidate is defensible and unsurprising, keep looking.

CRAFT PRINCIPLES (your compass)
You're not illustrating the narration — you're RHYMING with it. Every choice below should be defensible against one of these:

1. Show the feeling, not the fact. The voiceover carries what happened. Your shot carries what it felt like to be inside it.
2. Cross the domain boundary. Every narration belongs to a subject-matter domain — a field of life, of work, of nature. Your shot belongs to a DIFFERENT domain that shares one formal quality (a rhythm, a shape, a reversal, a tension) with the narration. The further apart the two domains, the more the image rhymes instead of echoes. Same-domain imagery is illustration, not cinema.
3. Specificity is the only antidote to cliche. The more particular and strange your image, the more universal it becomes. Generic images cannot surprise.
4. Scale shift. A very small subject can carry a very large idea, and vice versa. Mismatched scale creates resonance.
5. Aftermath beats action. The image that lands is usually the residue of the event, not the event itself.
6. Metonymy over metaphor — but only across the domain boundary. A part standing for the whole is sharper than a borrowed image, but only if the part lives in a different domain from the narration's subject.
7. Negative space. What is not in the frame often carries more weight than what is.
8. Stillness inside motion, or motion inside stillness. The eye reads contrast. Don't make everything move; don't make everything still.
9. The ordinary rendered strange. The most arresting images live in the mundane, transformed by light, weather, angle, or time of day.
10. One dominant subject, one dominant motion. A shot with two subjects has none.

COMPASS CHECK (answer each before emitting — if any fails, start over):
 a. THE GUESS TEST — the sharpest of these. If someone watched your silent shot and tried to guess the narration from the image alone, could they? If yes, the rhyme is too semantic — the shot is echoing the narration's subject. The viewer should be UNABLE to predict the voiceover from the image.
 b. THE TWO-DOMAINS TEST — this one is enforced structurally: you MUST emit narration_domain, candidate_domains, domain_chosen, domain_distance_rationale as the FIRST block of your JSON (see schema below). A validator will reject you if narration_domain and domain_chosen are the same word or trivial siblings (software ↔ hardware, software ↔ electronics, software ↔ circuit, software ↔ code, code ↔ keyboard, office ↔ workstation, tech ↔ hardware). Be honest: if the narration is about coding/IDEs/software, then "code", "keyboard", "laptop", "monitor", "screen", "IDE", "circuit-board", "soldering", "server-rack", "hardware", "electronics", "tech" are ALL same-domain siblings. A true jump lives somewhere else entirely — weather, water, birdsong, a kitchen, weaving, baking, grief, childhood, a hallway of doors, a polaroid developing, a pencil snapping. Commit to the domain BEFORE you compose the shot; compose the shot to honour the commitment.
 c. Which principle is this shot most earning? Name it in the rationale.
 d. With the voiceover muted, does this image still do something on its own terms?
 e. Is there a single specific detail in the shot a generic stock-image search could not produce?
 f. Would a stranger who doesn't know what this video is about still feel something watching it?

OUTPUT CONSTRAINTS (technical, non-creative — a downstream string validator enforces these):
 - camera: the field's text must include at least one of these move words so the adapter recognises it as a directed shot and not a still: dolly, push-in, pull-back, tracking, crane, drone, tilt, glide, handheld, orbit, pan, zoom, follow, circling. This is a string-match requirement. Pair it with whatever other lens/depth/focus language your shot actually needs. Locked-off is allowed only when style=cctv.
 - motion: the field's text must include at least one present-tense -ing verb of a physical action a viewer can see. Avoid vague softeners ("subtly", "slowly", "gently shifting"). Every verb should name something visible.
 - Every field describes what IS present — absences go in negative_additions.
 - Present tense. No interior emotional states.
 - Don't repeat a noun across fields. One environment, one key light + one accent, one dominant subject-motion cue + optionally one ambient cue.
 - ≤3 cinematic modifiers total across all fields.

NEGATIVE_ADDITIONS:
 Comma-separated bare keywords. No "no " prefix. The compiler already injects: text, captions, subtitles, readable screens, numerals, logos, brand names, watermarks, recognizable faces, cartoon, anime, illustrated. Add only scene-specific extras, or use "".

OUTPUT STRICT JSON, nothing else. Emit fields in the order below — the top block is a commitment you make BEFORE composing the shot, and a downstream validator will reject responses where domain_chosen equals narration_domain or is a trivial sibling. A rejection costs you exactly one retry. Don't waste it.

{
  "narration_domain":          "<ONE WORD. The subject-matter field the narration actually lives in. Be specific and honest — if the narration is about IDEs/coding/software engineering, write "software", not a dodge like "tools" or "work".>",
  "candidate_domains":         ["<ONE WORD>", "<ONE WORD>", "<ONE WORD>"],
  "domain_chosen":             "<one of the three candidates — this is the domain your shot lives in>",
  "domain_distance_rationale": "<=15 words: how domain_chosen is NOT a sibling of narration_domain>",
  "shot":               "<framing + subject, one line>",
  "environment":        "<location + props + atmosphere, one line>",
  "camera":             "<camera motion verb + lens + depth cue, one line>",
  "lighting":           "<key light + accent + shadow quality, one line>",
  "motion":             "<dominant action verb + optional ambient cue, one line>",
  "duration_seconds":   <integer 2..5>,
  "aspect_ratio":       "9:16",
  "style":              "<one register>",
  "negative_additions": "<or "">",
  "rationale":          "<=20 words: which principle above is this shot earning, and how>"
}`;
}

function cinematographerUserPrompt({ scene, copyContext, format, direction }) {
  const targetClipSec = Math.max(
    SEEDANCE_MIN_SECONDS,
    Math.min(SEEDANCE_MAX_SECONDS, Math.round((scene.durationInFrames || SEEDANCE_MAX_FRAMES) / FPS)),
  );
  // NOTE: we deliberately don't pass the kb seed or the copy description
  // here any more. Both carried strong subject-matter priming ("ide-killer",
  // "Anthropic", "Claude Code") that pulled every shot back into the tech
  // domain — the opposite of what the principles are asking for. The
  // cinematographer interprets the scene narration on its own terms.
  return `Copy tone (flavour only, do not literalize):
  variant:   ${copyContext.variant} — "${copyContext.label}"
  hook:      "${copyContext.hook}"
  loop:      ${copyContext.loop_check}

Scene to shoot (narration locked, no text burn-in):
  id:                   ${scene.id}
  narration:            "${scene.narration}"
  mood_copy:            ${scene.mood_copy}
  mood_palette:         ${scene.mood_palette}
  durationInFrames:     ${scene.durationInFrames}f (${((scene.durationInFrames || 0)/FPS).toFixed(1)}s at ${FPS}fps)
  target_clip_seconds:  ${targetClipSec}

Direction global: ${direction} (${format})

Emit the JSON only. duration_seconds should match target_clip_seconds unless narrative beat dictates otherwise.
Remember: avoid the laptop/keyboard cliche; reach into the visual vocabulary list and pick a physical metaphor.`;
}

// Pin pass-2 to a strong reasoning tier. The "auto" route for purpose=reasoning
// lands on a free-tier model (xiaomi/mimo-v2-flash) which can recite the craft
// principles but can't self-enforce the two-domains test — the measured result
// was 73% laptop/keyboard cliche shots. A Seedance clip is ~$0.50, a single
// cinematographer call is a few hundred tokens; the ratio easily earns the
// upgrade. If gemini-3.1-pro-preview is unavailable the organ falls back per
// the workspace's normal reasoning policy.
const CINEMATOGRAPHER_PREFER_MODEL = 'google/gemini-3.1-pro-preview';

async function cinematographerOne({ scene, copyContext, format, direction }) {
  const system = cinematographerSystemPrompt({
    format,
    direction,
    palette_mood: scene.mood_palette,
  });
  const basePrompt = cinematographerUserPrompt({ scene, copyContext, format, direction });
  const callOpts = {
    purpose: 'reasoning',
    prefer_model: CINEMATOGRAPHER_PREFER_MODEL,
    difficulty: 'complex',
  };

  // Attempt 1 — free-form. Validator checks the emitted domain pair.
  const out1 = await llm({ ...callOpts, system, prompt: basePrompt });
  const parsed1 = extractJson(out1.text);
  const check1 = checkDomainDistance(parsed1.narration_domain, parsed1.domain_chosen);
  if (!check1.forbidden) {
    return { parsed: parsed1, model: out1.model_used, domainRetry: false };
  }

  // Attempt 2 — cite the specific failure and demand a further jump.
  const retryPrompt = `${basePrompt}

REJECTED — your domain_chosen was too close to narration_domain:
 - narration_domain:       "${parsed1.narration_domain}"
 - domain_chosen:          "${parsed1.domain_chosen}"
 - candidate_domains:      ${JSON.stringify(parsed1.candidate_domains || [])}
 - validator failure:      ${check1.reason}

Try again. Forbidden: anything in the same field as the narration's subject (for software narration that means code, keyboards, laptops, monitors, IDEs, screens, servers, circuits, hardware, electronics, tech). None of your previous candidate_domains may be reused. Reach into an unrelated domain — weather, water, birds, a kitchen, grief, childhood, a craft, a ritual, the body, architecture, music, sleep. Re-emit the FULL JSON with a new narration_domain/candidate_domains/domain_chosen and a new shot composed from the new domain.`;

  const out2 = await llm({ ...callOpts, system, prompt: retryPrompt });
  const parsed2 = extractJson(out2.text);
  const check2 = checkDomainDistance(parsed2.narration_domain, parsed2.domain_chosen);
  return {
    parsed: parsed2,
    model: out2.model_used,
    domainRetry: true,
    domainWarning: check2.forbidden ? `retry still forbidden: ${check2.reason}` : null,
  };
}

// ---------- Phase 5: deterministic Seedance prompt compiler ----------
//
// Schema JSON in, fal-ready strings out. Deterministic so reruns of the
// designer hit the fal cache until the structured JSON actually changes
// (see fal-adapter.ts:84 cache key).

function clampDuration(d) {
  const n = parseInt(String(d), 10);
  if (!Number.isFinite(n)) return SEEDANCE_MAX_SECONDS;
  return Math.max(2, Math.min(SEEDANCE_MAX_SECONDS, n));
}

function normalizeRegister(style) {
  const s = String(style || '').toLowerCase().replace(/_/g, '-');
  return STYLE_REGISTERS.includes(s) ? s : 'photographic';
}

function stripTrailingPunct(s) {
  return String(s || '').trim().replace(/[.!?,;:\s]+$/, '');
}

function capFirst(s) {
  const t = String(s || '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function lcFirst(s) {
  const t = String(s || '').trim();
  return t ? t[0].toLowerCase() + t.slice(1) : t;
}

function compileSeedancePrompt({ cin, seed }) {
  const register = normalizeRegister(cin.style);
  const anchor = REGISTER_ANCHORS[register];

  const camera = stripTrailingPunct(cin.camera);
  const shot = stripTrailingPunct(cin.shot);
  const environment = stripTrailingPunct(cin.environment);
  const lighting = stripTrailingPunct(cin.lighting);
  const motion = stripTrailingPunct(cin.motion);

  const parts = [];
  if (camera) parts.push(capFirst(camera));
  // Lowercase environment's first letter when joined after "in " — "in a
  // dark room" reads naturally; "in A dark room" doesn't.
  const subjectPlace = shot && environment
    ? `${capFirst(shot)}, in ${lcFirst(environment)}`
    : capFirst(shot || environment);
  if (subjectPlace) parts.push(subjectPlace);
  if (lighting) parts.push(capFirst(lighting));
  if (motion) parts.push(capFirst(motion));
  parts.push(capFirst(`${anchor}, 9:16 vertical`));

  const prompt = parts.join('. ') + '.';

  const additions = [
    NEGATIVE_BASELINE,
    REGISTER_NEGATIVES[register],
    stripTrailingPunct(cin.negative_additions),
  ].filter(Boolean);
  const negativePrompt = additions.join(', ');

  return {
    prompt,
    negativePrompt,
    seed,
    durationSeconds: clampDuration(cin.duration_seconds),
    aspectRatio: '9:16',
    register,
  };
}

async function runCinematographerPass({ design, copy, format, direction, kbSeed }) {
  const scenes = design.scenes || [];
  const seedanceScenes = scenes
    .map((s, i) => ({ scene: s, idx: i }))
    .filter(({ scene }) => scene.provider === 'seedance');
  if (seedanceScenes.length === 0) return [];

  const copyContext = {
    variant: copy.variant,
    label: copy.label,
    title: copy.title,
    description: copy.description,
    hook: copy.hook,
    loop_check: copy.loop_check,
    kbSeed: kbSeed || null,
  };

  const results = await Promise.all(seedanceScenes.map(async ({ scene, idx }) => {
    try {
      const { parsed, model, domainRetry, domainWarning } = await cinematographerOne({
        scene, copyContext, format, direction,
      });
      const seed = deriveSeed({
        variant: copy.variant,
        sceneId: scene.id,
        format,
        direction,
      });
      const compiled = compileSeedancePrompt({ cin: parsed, seed });
      return {
        idx, sceneId: scene.id, cin: parsed, compiled, model,
        domainRetry: Boolean(domainRetry),
        domainWarning: domainWarning || null,
      };
    } catch (e) {
      return { idx, sceneId: scene.id, error: e.message };
    }
  }));
  return results;
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

    if (ENABLE_SEEDANCE) {
      const stats = providerStats(design);
      lines.push(`### Provider trace`);
      lines.push('');
      lines.push(`\`${stats.providerTrace || '—'}\` · seedance: ${stats.count} scene${stats.count === 1 ? '' : 's'}${stats.seedanceIndexes.length ? ` [${stats.seedanceIndexes.join(',')}]` : ''} · cost ~$${stats.costUsd.toFixed(2)} · wallclock ~${stats.wallclockSec}s · clip-seconds ${stats.clipSeconds}s`);
      if (d.providerWarnings && d.providerWarnings.length) {
        lines.push('');
        lines.push(`**⚠ provider normalizer:**`);
        for (const w of d.providerWarnings) lines.push(`- ${w}`);
      }
      lines.push('');
    }

    lines.push(`### Scenes`);
    for (let i = 0; i < (design.scenes || []).length; i++) {
      const s = design.scenes[i];
      lines.push('');
      const providerTag = ENABLE_SEEDANCE ? ` · ${s.provider === 'seedance' ? '🎬 seedance' : 'remotion'}` : '';
      lines.push(`**${i + 1}. [${s.id}] ${s.kind} — ${s.mood_copy} → ${s.mood_palette}${providerTag}**`);
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
      if (s.design_rationale) lines.push(`- _design: ${s.design_rationale}_`);
      if (ENABLE_SEEDANCE && s.provider_rationale) lines.push(`- _provider: ${s.provider_rationale}_`);
    }
    lines.push('');

    if (ENABLE_SEEDANCE && Array.isArray(d.cinematography) && d.cinematography.length > 0) {
      lines.push(`### Cinematography (Seedance scenes)`);
      lines.push('');
      for (const c of d.cinematography) {
        lines.push(`#### Scene ${c.idx + 1} — ${c.sceneId}`);
        if (c.error) {
          lines.push(`**ERROR:** ${c.error}`);
          lines.push('');
          continue;
        }
        const { cin, compiled } = c;
        const retryTag = c.domainRetry ? ' · _domain retry_' : '';
        lines.push(`model: \`${c.model}\` · register **${compiled.register}** · ${compiled.durationSeconds}s · seed \`${compiled.seed}\`${retryTag}`);
        lines.push('');
        if (cin.narration_domain || cin.domain_chosen) {
          lines.push(`- **domain:** \`${cin.narration_domain || '?'}\` → \`${cin.domain_chosen || '?'}\`${cin.domain_distance_rationale ? ` — _${cin.domain_distance_rationale}_` : ''}`);
        }
        if (c.domainWarning) {
          lines.push(`- **⚠ domain warning:** ${c.domainWarning}`);
        }
        lines.push(`- **shot:** ${cin.shot}`);
        lines.push(`- **environment:** ${cin.environment}`);
        lines.push(`- **camera:** ${cin.camera}`);
        lines.push(`- **lighting:** ${cin.lighting}`);
        lines.push(`- **motion:** ${cin.motion}`);
        if (cin.rationale) lines.push(`- _rationale: ${cin.rationale}_`);
        lines.push('');
        lines.push(`**Compiled Seedance prompt:**`);
        lines.push('');
        lines.push(`> ${compiled.prompt}`);
        lines.push('');
        lines.push(`**Negative:** \`${compiled.negativePrompt}\``);
        lines.push('');
      }
    }

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
      ...(ENABLE_SEEDANCE ? {
        provider: s.provider || 'remotion',
        providerRationale: s.provider_rationale,
      } : {}),
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
    ...(ENABLE_SEEDANCE ? { _seedance: providerStats(design) } : {}),
  };
}

// ---------- main ----------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load the knowledge-base seed alongside the copy variants. This is
  // the factual grounding (bucket + headline + highlights) that both
  // the copy and the cinematographer can reach for, so the pipeline is
  // actually a knowledge → viral content loop rather than a closed
  // hall-of-mirrors.
  let kbSeed = null;
  const seedPath = path.join(COPY_DIR, '_seed.json');
  if (fs.existsSync(seedPath)) {
    try {
      kbSeed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      console.log(`[design] kb seed: ${kbSeed.bucket || '?'} — "${(kbSeed.headline || '').slice(0, 80)}${kbSeed.headline?.length > 80 ? '…' : ''}"`);
    } catch (e) {
      console.error(`[design] couldn't parse ${seedPath}: ${e.message}`);
    }
  }

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
          const { parsed, model, providerWarnings } = await designOne({ copy, format, direction });
          const report = alignmentReport(parsed, copy, format);

          // Phase 5: fan-out cinematographer pass over Seedance-tagged scenes.
          let cinematography = [];
          if (ENABLE_SEEDANCE) {
            cinematography = await runCinematographerPass({ design: parsed, copy, format, direction, kbSeed });
          }

          const spec = assembleVideoSpec({ design: parsed, copy, format, direction });
          const outPath = path.join(OUT_DIR, `${variant}-${format}-${direction}.json`);
          fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));

          if (ENABLE_SEEDANCE && cinematography.length > 0) {
            const seedancePayload = {
              variant: copy.variant,
              format,
              direction,
              stats: providerStats(parsed),
              scenes: cinematography.map(c => ({
                idx: c.idx,
                sceneId: c.sceneId,
                sceneNarration: (parsed.scenes || [])[c.idx]?.narration,
                ...(c.error ? { error: c.error } : {
                  model: c.model,
                  cinematography: c.cin,
                  compiled: c.compiled,
                  domainRetry: Boolean(c.domainRetry),
                  domainWarning: c.domainWarning || null,
                }),
              })),
            };
            const seedanceOutPath = path.join(OUT_DIR, `${variant}-${format}-${direction}-seedance.json`);
            fs.writeFileSync(seedanceOutPath, JSON.stringify(seedancePayload, null, 2));
          }

          designs.push({ direction, parsed, model, report, providerWarnings, cinematography });
          const w = report.warnings.length;
          const pw = (providerWarnings || []).length;
          const cc = cinematography.filter(c => !c.error).length;
          const ce = cinematography.filter(c => c.error).length;
          const cr = cinematography.filter(c => !c.error && c.domainRetry).length;
          const cwarn = cinematography.filter(c => c.domainWarning).length;
          const phase5Tag = ENABLE_SEEDANCE
            ? ` · providers ${pw ? `${pw} warn` : 'ok'}${cinematography.length ? ` · cin ${cc}✓${ce ? `/${ce}✗` : ''}${cr ? ` · ${cr} retry` : ''}${cwarn ? ` · ${cwarn} ⚠domain` : ''}` : ''}`
            : '';
          console.log(`✓ ${report.total}f · ${w} warning${w === 1 ? '' : 's'}${phase5Tag}`);
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
