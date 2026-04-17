/**
 * _custom-scene-codegen — Phase 3 of the motion-graphics plan.
 *
 * Generates a bespoke Remotion+R3F scene component for a single scene
 * whose motion_graphic_prompt is too novel for the DSL to express. The
 * LLM output is treated as untrusted: we parse it, enforce an import
 * allowlist + dangerous-pattern denylist, and only then write it to
 * packages/video/src/scenes/.generated/<slug>.tsx. The .generated barrel
 * is rewritten to re-export every successful scene so webpack picks
 * them up and the scene registry registers them at bundle-eval time.
 *
 * On ANY validation failure we return { ok: false, reason } and the
 * caller is expected to fall back to the compiled-beats shape.
 *
 * Safety guardrails (v1):
 *   1. Import allowlist — only the framework + primitive catalog is
 *      importable (see ALLOWED_IMPORTS). Node core, fetch, worker,
 *      arbitrary npm packages are rejected.
 *   2. Pattern denylist — eval/Function/dynamic-import/process/global
 *      access rejected at the source level.
 *   3. AST parse via esbuild — must be syntactically valid TSX.
 *   4. Default export must be present.
 *   5. File lives under .generated/ and is regenerated per pass —
 *      no stale scene ever survives a re-render.
 *   6. Runtime error boundary (packages/video/src/scenes/registry.tsx)
 *      catches any crash at render-time and swaps in a fallback.
 *
 * Usage:
 *   import { generateCustomScene, resetGenerated } from './_custom-scene-codegen.mjs';
 *   resetGenerated();
 *   const r = await generateCustomScene({
 *     episodeId: 'briefing-2026-04-17',
 *     sceneId: 'story-2a',
 *     motion_graphic_prompt: 'AI spaghetti: 37 tool nodes tangle into one workflow.',
 *     narration: 'Thirty-seven tools in one workflow — that is the spaghetti.',
 *     durationInFrames: 450,
 *     fps: 30,
 *   });
 *   // r: { ok: true, kind: 'custom-<slug>', filename: '...' }
 *   //  | { ok: false, reason: '...' }
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { llm, extractJson } from '../x-experiments/_ohwow.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const GEN_DIR = path.join(REPO_ROOT, 'packages/video/src/scenes/.generated');
const BARREL_PATH = path.join(GEN_DIR, 'index.ts');

// ---------------------------------------------------------------------------
// Allowlist + denylist
// ---------------------------------------------------------------------------

/**
 * Packages the LLM is allowed to import from. Anything else → reject.
 * Relative paths are rejected wholesale (the scene must stand alone with
 * only framework + primitive library; no reaching into random repo files).
 */
const ALLOWED_IMPORTS = new Set([
  'react',
  'remotion',
  '@remotion/three',
  '@react-three/fiber',
  '@react-three/drei',
  '@react-three/postprocessing',
  'three',
]);

/**
 * Source-level patterns that are rejected outright. Keep these tight —
 * webpack won't resolve node-core imports anyway, but explicit rejection
 * gives us clearer error messages + catches someone reaching through
 * globalThis at runtime.
 */
const DENY_PATTERNS = [
  { re: /\beval\s*\(/, reason: 'eval() is banned' },
  { re: /\bnew\s+Function\s*\(/, reason: 'new Function() is banned' },
  { re: /\bimport\s*\(/, reason: 'dynamic import() is banned' },
  { re: /\brequire\s*\(/, reason: 'CommonJS require() is banned' },
  { re: /\bprocess\s*\./, reason: 'process.* access is banned' },
  { re: /\bglobalThis\s*\./, reason: 'globalThis.* access is banned' },
  { re: /\bwindow\s*\.(?!matchMedia|innerWidth|innerHeight)/, reason: 'window.* access is banned (except layout helpers)' },
  { re: /\bdocument\s*\./, reason: 'document.* access is banned' },
  { re: /\bfetch\s*\(/, reason: 'fetch() is banned' },
  { re: /\bXMLHttpRequest\b/, reason: 'XMLHttpRequest is banned' },
  { re: /\bWebSocket\b/, reason: 'WebSocket is banned' },
  { re: /\bWorker\s*\(/, reason: 'Worker() is banned' },
  { re: /\blocalStorage\b/, reason: 'localStorage is banned' },
  { re: /\bsessionStorage\b/, reason: 'sessionStorage is banned' },
  { re: /\b__dirname\b|\b__filename\b/, reason: 'Node globals are banned' },
];

// ---------------------------------------------------------------------------
// Codegen prompt
// ---------------------------------------------------------------------------

const CODEGEN_SYSTEM_PROMPT = `You write a single bespoke Remotion + @react-three/fiber scene component in strict TypeScript (TSX). The component renders inside an already-mounted <ThreeCanvas> via r3f-scene OR a plain Remotion composable scene. You pick.

HARD RULES (any violation → your output is rejected and the render falls back to generic visuals):

1. **Only these imports** are allowed (exact sources, no wildcards, no relative paths):
   - import React from "react";
   - import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from "remotion";
   - import { ThreeCanvas } from "@remotion/three";          // optional, for 3D scenes
   - import { useFrame } from "@react-three/fiber";          // optional
   - import { Text, Text3D, Billboard, Environment, MeshTransmissionMaterial } from "@react-three/drei";  // optional
   - import * as THREE from "three";                          // optional
   No other imports. No dynamic import(), no require(), no fetch(), no Worker, no process, no globalThis, no document, no localStorage.

2. **Default export a React.FC** that takes \`{ params?: Record<string, unknown>; durationInFrames?: number }\` and returns a JSX element. The component name is up to you.

3. **Deterministic** — every frame's output must depend only on useCurrentFrame() and useVideoConfig(). No Math.random without a seed, no Date.now, no performance.now.

4. **ASMR motion profile** — use slow easing (Easing.inOut(Easing.cubic) or bezier(0.42, 0, 0.58, 1)), breath-cycle opacity, gentle parallax. No hard snaps, no frantic movement. Assume motionProfile: "asmr".

5. **No hooks outside the component body**. No custom hooks from outside. useFrame from @react-three/fiber is OK inside a component rendered within ThreeCanvas.

6. **If you build a 3D scene**, wrap everything inside <ThreeCanvas>, add an <Environment preset="sunset" /> for chrome reflections, add <ambientLight /> + <directionalLight /> with warm color temperature.

7. **No network, no filesystem, no navigation** — a scene component draws pixels from frame state, nothing else.

8. **Output contract**: return ONE JSON object with two keys:
   - "reasoning": 2-3 sentences on HOW your scene visualizes the motion_graphic_prompt + narration semantically.
   - "tsx": the complete TSX file source, starting at the top-level imports. No markdown fences, no prose before/after.

The tsx string is what we write to disk; if it fails validation, we reject and fall back.`;

function buildCodegenUserPrompt({ sceneId, motion_graphic_prompt, narration, durationInFrames, fps }) {
  return [
    `Generate a custom scene component for the following:`,
    ``,
    `Scene ID: ${sceneId}`,
    `Duration: ${durationInFrames} frames at ${fps} fps (${(durationInFrames / fps).toFixed(1)}s)`,
    `Motion-graphic intent: ${motion_graphic_prompt || '(none provided)'}`,
    `Narration this scene plays over: "${narration || '(none)'}"`,
    ``,
    `The scene must visually match what the voice says this second. If the narration names a number, a version, a concept — show that specific thing, not a generic backdrop. If the DSL primitives (count-up-bar, versus-cards, glass-panel, orbiting-tags, ribbon-trail, number-sculpture, particle-cloud) could do this well, we wouldn't be calling you — so design something those primitives can't.`,
    ``,
    `Return the JSON object described in the system prompt.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Extract the import sources from a TSX source file. Only top-level
 * `import ... from "..."` forms are supported (which is all TSX allows
 * for static imports anyway). Returns an array of source strings.
 */
export function extractImportSources(source) {
  // Match both `import foo from "x"` and `import "x"` (side-effect).
  const sources = [];
  const re = /^\s*import\s+(?:[^'"`\n]*?from\s+)?["']([^"']+)["']/gm;
  let m;
  while ((m = re.exec(source))) sources.push(m[1]);
  return sources;
}

/**
 * Validate the TSX string against: allowlist of imports, dangerous
 * patterns, presence of default export. Returns { ok, reason? }.
 * Does NOT parse for syntax — caller should run esbuild transform for
 * that (kept separate so tests can run without esbuild).
 */
export function validateCodegen(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { ok: false, reason: 'empty source' };
  }

  // 1. Import allowlist. Relative paths are disallowed.
  const imports = extractImportSources(source);
  for (const src of imports) {
    if (src.startsWith('.') || src.startsWith('/')) {
      return { ok: false, reason: `relative/absolute import not allowed: ${src}` };
    }
    if (!ALLOWED_IMPORTS.has(src)) {
      return { ok: false, reason: `import not in allowlist: ${src}` };
    }
  }

  // 2. Denylist patterns.
  for (const { re, reason } of DENY_PATTERNS) {
    if (re.test(source)) return { ok: false, reason };
  }

  // 3. Default export — required.
  if (!/\bexport\s+default\b/.test(source)) {
    return { ok: false, reason: 'no default export' };
  }

  return { ok: true };
}

/**
 * Optional AST parse via esbuild. Runs transformSync in TSX mode; if
 * esbuild's parser accepts the source, syntax is valid. We don't keep
 * the transform output — we want remotion's own bundler to compile the
 * file at render time, and we only care here that the parse succeeds.
 *
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function validateSyntax(source) {
  try {
    const esbuild = await import('esbuild');
    esbuild.transformSync(source, { loader: 'tsx', format: 'esm' });
    return { ok: true };
  } catch (e) {
    const msg = e && e.errors && e.errors.length ? e.errors.map((x) => x.text).join('; ') : String(e?.message || e);
    return { ok: false, reason: `syntax error: ${msg.slice(0, 240)}` };
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * Wipe all generated TSX files and reset the barrel to empty. Run once
 * at the start of each compose pass so old scenes never survive.
 */
export function resetGenerated() {
  if (!fs.existsSync(GEN_DIR)) fs.mkdirSync(GEN_DIR, { recursive: true });
  for (const name of fs.readdirSync(GEN_DIR)) {
    if (name === '.gitignore' || name === '.gitkeep' || name === 'README.md' || name === 'index.ts') continue;
    if (name.endsWith('.tsx')) fs.unlinkSync(path.join(GEN_DIR, name));
  }
  writeBarrel([]);
}

/**
 * Safe filesystem-friendly slug. "briefing-2026-04-17-story-2a" stays
 * as-is; weird input gets normalized to a-z0-9-.
 */
function slugify(...parts) {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Convert a slug to a valid JS identifier for the barrel import.
 */
function identifierFromSlug(slug) {
  return 'Scene_' + slug.replace(/[^a-zA-Z0-9]/g, '_');
}

function writeBarrel(entries) {
  const header = [
    `// AUTO-GENERATED barrel — rewritten by scripts/yt-experiments/_custom-scene-codegen.mjs.`,
    `// Exports a map of custom scene kinds → React components. The scene registry`,
    `// reads this at module-load time and registers each entry, so webpack bundles`,
    `// every generated scene without circular imports back into the registry.`,
    `import type React from "react";`,
    ``,
  ];
  const imports = entries.map((e) => `import ${e.ident} from "./${e.slug}";`);
  const kindLines = entries.map((e) => `  ${JSON.stringify(e.kind)}: ${e.ident},`);
  const body = [
    ``,
    `export const GENERATED_SCENES: Record<string, React.FC<{ params?: Record<string, unknown>; durationInFrames?: number }>> = {`,
    ...kindLines,
    `};`,
    ``,
  ];
  fs.writeFileSync(BARREL_PATH, [...header, ...imports, ...body].join('\n'), 'utf8');
}

/**
 * Read the current barrel entries so we can append to them idempotently.
 * Returns [{slug, ident, kind}].
 */
function readBarrelEntries() {
  if (!fs.existsSync(BARREL_PATH)) return [];
  const txt = fs.readFileSync(BARREL_PATH, 'utf8');
  const entries = [];
  // Match `import Ident from "./slug";`
  const importRe = /^import\s+(\w+)\s+from\s+"\.\/([\w-]+)"\s*;/gm;
  let m;
  while ((m = importRe.exec(txt))) entries.push({ ident: m[1], slug: m[2] });
  // Match `"kind": Ident,` entries in the object.
  const kindRe = /"([^"\\]+)"\s*:\s*(\w+)/g;
  const kinds = {};
  while ((m = kindRe.exec(txt))) kinds[m[2]] = m[1];
  return entries.map((e) => ({ ...e, kind: kinds[e.ident] || `custom-${e.slug}` }));
}

/**
 * Extract the TSX source from the LLM response. The model returns JSON
 * with { reasoning, tsx }. Pull the tsx string; fall back to a fenced
 * code-block regex if the JSON extract fails.
 */
function extractTsx(raw) {
  try {
    const j = extractJson(raw);
    if (j && typeof j.tsx === 'string' && j.tsx.trim().length > 0) {
      return { tsx: j.tsx, reasoning: typeof j.reasoning === 'string' ? j.reasoning : '' };
    }
  } catch { /* fall through */ }
  // Last-ditch: LLM ignored the JSON contract. Grab the first fenced ```tsx block.
  const fence = raw.match(/```(?:tsx|typescript|ts)?\s*\n([\s\S]+?)```/);
  if (fence) return { tsx: fence[1], reasoning: '' };
  return null;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * Generate + validate + persist one custom scene. On success, returns
 * { ok: true, kind, slug, filename, reasoning }. On any failure, returns
 * { ok: false, reason }. Caller is responsible for falling back.
 */
export async function generateCustomScene({ episodeId, sceneId, motion_graphic_prompt, narration, durationInFrames, fps, model }) {
  if (!episodeId || !sceneId) return { ok: false, reason: 'episodeId + sceneId required' };
  if (!motion_graphic_prompt && !narration) return { ok: false, reason: 'need motion_graphic_prompt or narration' };

  const slug = slugify(episodeId, sceneId);
  const kind = `custom-${slug}`;
  const ident = identifierFromSlug(slug);
  const filename = `${slug}.tsx`;
  const abs = path.join(GEN_DIR, filename);

  if (!fs.existsSync(GEN_DIR)) fs.mkdirSync(GEN_DIR, { recursive: true });

  const user = buildCodegenUserPrompt({ sceneId, motion_graphic_prompt, narration, durationInFrames, fps });

  let raw;
  try {
    raw = await llm({
      purpose: 'generation',
      system: CODEGEN_SYSTEM_PROMPT,
      prompt: user,
      difficulty: 'hard',
      max_tokens: 2400,
      prefer_model: model,
    });
  } catch (e) {
    return { ok: false, reason: `llm error: ${e?.message || e}` };
  }

  const extracted = extractTsx(raw);
  if (!extracted) return { ok: false, reason: 'no tsx in llm response' };

  const { tsx, reasoning } = extracted;
  const syn = await validateSyntax(tsx);
  if (!syn.ok) return { ok: false, reason: syn.reason };

  const v = validateCodegen(tsx);
  if (!v.ok) return { ok: false, reason: v.reason };

  fs.writeFileSync(abs, tsx, 'utf8');

  const existing = readBarrelEntries().filter((e) => e.slug !== slug);
  writeBarrel([...existing, { slug, ident, kind }]);

  return { ok: true, kind, slug, filename, reasoning, id: crypto.randomUUID() };
}

/**
 * Dev/test helper: write a hand-authored TSX straight to .generated
 * without the LLM. Validates with the same rules so tests exercise the
 * validation path.
 */
export async function writeCustomSceneFromSource({ episodeId, sceneId, tsx }) {
  const slug = slugify(episodeId, sceneId);
  const kind = `custom-${slug}`;
  const ident = identifierFromSlug(slug);
  const filename = `${slug}.tsx`;
  const abs = path.join(GEN_DIR, filename);

  if (!fs.existsSync(GEN_DIR)) fs.mkdirSync(GEN_DIR, { recursive: true });

  const syn = await validateSyntax(tsx);
  if (!syn.ok) return { ok: false, reason: syn.reason };

  const v = validateCodegen(tsx);
  if (!v.ok) return { ok: false, reason: v.reason };

  fs.writeFileSync(abs, tsx, 'utf8');
  const existing = readBarrelEntries().filter((e) => e.slug !== slug);
  writeBarrel([...existing, { slug, ident, kind }]);

  return { ok: true, kind, slug, filename };
}
