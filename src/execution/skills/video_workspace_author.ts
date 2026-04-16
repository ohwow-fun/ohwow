/**
 * Workspace-aware video authoring.
 *
 * Given a workspace, produce a VideoSpec with workspace-personalized
 * voiceovers (and later visuals). v1: keep the 5 generic scene visuals
 * but replace voice + auto-fit scene durations to voice length.
 *
 * Flow (single skill):
 *   1. gather workspace facts via SQLite
 *   2. LLM → 5 narration scripts matching the ohwow-demo scene themes
 *      but personalized with the facts
 *   3. TTS each script → content-addressed asset cache
 *   4. ffprobe each MP3 for duration; compute scene frame counts
 *   5. assemble VideoSpec (scenes = generic, voiceovers = cached paths)
 *   6. write spec to disk; return path for rendering
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { copyFile, writeFile, readFile, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir, platform } from 'node:os';

import { logger } from '../../lib/logger.js';
import { getOrCreate, type CacheModality } from '../../media/asset-cache.js';

const require = createRequire(import.meta.url);

const FPS = 30;
const VOICE_LEAD_FRAMES = 10;    // visual starts 10 frames before voice (matches existing demo)
const VOICE_TAIL_FRAMES = 15;    // let last word breathe
const SCENE_MIN_FRAMES = 90;
const TRANSITION_FRAMES = 20;

/**
 * Scene-kind catalog: the LLM uses this to decide which visuals fit each
 * beat of the story. New kinds can be registered at runtime; the catalog
 * is informational (for the prompt), not a hard constraint.
 */
/**
 * Scene-kind catalog. Each entry is a deterministic motion-graphics template.
 * The LLM picks from this catalog to build storyboards. Scenes can be mixed,
 * repeated, and reordered to create millions of unique combinations.
 *
 * Tier 1: shipped in @ohwow/video (React components exist).
 * Tier 2: can be composed from existing primitives; will be registered once
 *         their components land.
 *
 * When the registry lacks a component for a kind, the composition falls back
 * to `outcome-orbit` (the most versatile).
 */
export const SCENE_KIND_CATALOG: Array<{
  kind: string;
  name: string;
  fits: string;
  tier: 1 | 2;
  paramHints?: string;
}> = [
  // ── Tier 1: component exists ──
  { kind: 'prompts-grid', name: 'Rolling prompts', tier: 1,
    fits: 'Showing scattered AI chats, many tasks, overwhelming volume, a busy day.',
    paramHints: 'prompts[]{text,time,app}, stagger, scrollRange, appColors' },
  { kind: 'drop', name: 'Import / absorb', tier: 1,
    fits: 'Data flowing in: files, conversations, integrations. "Bring everything together."',
    paramHints: 'files[]{name,source,color,delay}, counters[]{to,label,startFrame}' },
  { kind: 'extraction', name: 'Extraction / processing', tier: 1,
    fits: 'Knowledge cards appearing from a processing orb. "Memories extracted, patterns found."',
    paramHints: 'cards[]{type,text,delay}, particleCount, counter{to,label,startFrame,durationFrames}' },
  { kind: 'outcome-orbit', name: 'Outcomes grid', tier: 1,
    fits: 'Grid of results, agent accomplishments, concrete wins. The most versatile scene.',
    paramHints: 'outcomes[]{text,color,icon,delay}' },
  { kind: 'cta-mesh', name: 'CTA / closing', tier: 1,
    fits: 'Laptop + phone frames, notifications, logo reveal, tagline. Best as a closing scene.',
    paramHints: 'notifications[]{text,icon,color,delay}, terminalLines[], cta{tagline,subline,logoSrc}' },

  // ── Tier 2: composable from primitives, component TBD ──
  // Until their component ships, the engine falls back to outcome-orbit with the same params.
  { kind: 'stats-counter', name: 'Big number counters', tier: 1,
    fits: 'Highlighting 2-4 key metrics: agent count, tasks completed, memories stored. Dramatic number reveals.',
    paramHints: 'counters[]{to,label,startFrame}, layout: "row"|"grid"' },
  { kind: 'terminal-log', name: 'Terminal / log scroll', tier: 1,
    fits: 'Live agent activity: terminal lines appearing in sequence. Shows "behind the scenes" work.',
    paramHints: 'lines[]{text,color,delay}, prompt: string' },
  { kind: 'before-after', name: 'Before / after split', tier: 1,
    fits: 'Split screen: left is "before" (chaos, manual), right is "after" (automated, calm). Transformation story.',
    paramHints: 'before{items[]}, after{items[]}, splitFrame: number' },
  { kind: 'agent-roster', name: 'Agent team roster', tier: 1,
    fits: 'Introduce 3-6 agents by name and role. Each card enters with its icon. "Meet your team."',
    paramHints: 'agents[]{name,role,icon,color,delay}' },
  { kind: 'timeline', name: 'Timeline / history', tier: 2,
    fits: 'Vertical timeline of milestones or tasks completed. Good for "what happened this week."',
    paramHints: 'events[]{text,date,icon,color,delay}' },
  { kind: 'notification-stack', name: 'Notification stack', tier: 1,
    fits: 'Phone-like notifications stacking: agent reports, task completions, messages. "While you were away."',
    paramHints: 'notifications[]{text,icon,color,delay}, deviceFrame: boolean' },
  { kind: 'knowledge-web', name: 'Knowledge graph / web', tier: 2,
    fits: 'Nodes and connections representing memories and relationships. "Everything connected."',
    paramHints: 'nodes[]{label,color,x,y}, edges[]{from,to}, pulseSpeed' },
  { kind: 'quote-card', name: 'Quote / testimonial', tier: 1,
    fits: 'A single powerful statement or customer quote. Large text, centered, minimal.',
    paramHints: 'quote: string, attribution?: string, accent: string' },
  { kind: 'comparison-table', name: 'Comparison table', tier: 2,
    fits: 'Two or three columns comparing approaches: manual vs. automated, or tool A vs. B.',
    paramHints: 'columns[]{header,rows[]}, highlightColumn: number' },
  { kind: 'workflow-steps', name: 'Workflow steps', tier: 1,
    fits: 'Animated step-by-step process: 1→2→3→done. Good for "how it works."',
    paramHints: 'steps[]{label,icon,description,delay}' },
  { kind: 'logo-reveal', name: 'Logo reveal', tier: 2,
    fits: 'Dramatic logo appearance with particles or glow. Branding moment.',
    paramHints: 'logoSrc: string, wordmark: string, subtitle?: string' },
  { kind: 'metric-chart', name: 'Animated chart', tier: 2,
    fits: 'Bar or line chart animating upward. Show growth: tasks/week, agents deployed, etc.',
    paramHints: 'bars[]{label,value,color}, yLabel, animationDelay' },
  { kind: 'text-typewriter', name: 'Typewriter text', tier: 1,
    fits: 'A single sentence typing itself onto a dark screen. Dramatic opening or closing.',
    paramHints: 'text: string, fontSize: number, typingSpeed: number' },
  { kind: 'split-cards', name: 'Card carousel', tier: 2,
    fits: 'Cards sliding in from sides. Each card = one fact, feature, or agent. 3-6 cards.',
    paramHints: 'cards[]{title,body,icon,color,delay}' },
  { kind: 'globe-connections', name: 'Globe / network', tier: 2,
    fits: 'Abstract globe or network mesh showing distributed nature. "Runs everywhere."',
    paramHints: 'connections: number, pulseColor: string, rotationSpeed: number' },
];

export interface WorkspaceFacts {
  workspaceName: string;
  businessName: string;
  businessDescription: string;
  founderFocus: string;
  growthStage: string;
  agentCount: number;
  activeAgentCount: number;
  agentNames: string[];            // up to 6 agent display names
  topAgentRoles: string[];         // up to 6 roles
  taskCount: number;
  completedTaskCount: number;
  recentTaskTitles: string[];       // up to 6, sanitized
  topIntegrations: string[];        // up to 4
  knowledgeDocs: number;
  memories: number;
  goals: string[];                  // up to 4 goal titles
}

export interface SceneScript {
  kind: string;
  script: string;           // narration (5-15s worth)
  caption?: string;         // single highlight sentence under 60 chars
  mood?: string;
  pacing?: string;
  visualLayers?: Array<{ primitive: string; [key: string]: unknown }>;
  text?: { content: string; animation?: string; position?: string; fontSize?: number };
}

export interface LlmStoryboard {
  palette?: { seedHue: number; harmony: string; mood: string };
  scenes: SceneScript[];
}

export interface SceneBrief {
  kind: string;
  theme: string;           // one-line theme for the LLM
  targetSeconds: number;    // suggested narration length
  targetWords?: number;
}

export const CLASSIC_DEMO_BRIEFS: SceneBrief[] = [
  { kind: 'prompts-grid', theme: 'The problem: AI chats scattered across apps, nothing remembers. Personal, frustrated tone.', targetSeconds: 5, targetWords: 14 },
  { kind: 'drop',          theme: 'Bringing every conversation in to one place.', targetSeconds: 3, targetWords: 8 },
  { kind: 'extraction',    theme: 'Memories, decisions and patterns extracted and structured.', targetSeconds: 10, targetWords: 26 },
  { kind: 'outcome-orbit', theme: 'Concrete moments of what the agents now do for you. Use 2 concrete examples from the facts.', targetSeconds: 9, targetWords: 24 },
  { kind: 'cta-mesh',       theme: 'Runs locally. Always on. End on a memorable tagline.', targetSeconds: 8, targetWords: 20 },
];

export const AGENT_SHOWCASE_BRIEFS: SceneBrief[] = [
  { kind: 'prompts-grid',  theme: 'Before: you tried to do everything yourself.', targetSeconds: 5, targetWords: 14 },
  { kind: 'outcome-orbit', theme: 'Introduce your agent team. Name 2-3 specific agents and their jobs.', targetSeconds: 10, targetWords: 26 },
  { kind: 'extraction',    theme: 'Everything they learn gets stored, compounds, stays yours.', targetSeconds: 8, targetWords: 22 },
  { kind: 'cta-mesh',       theme: 'What life looks like now. Tagline.', targetSeconds: 7, targetWords: 18 },
];

export const LAUNCH_TEASER_BRIEFS: SceneBrief[] = [
  { kind: 'drop',          theme: 'Hook: a single striking claim about what is now possible.', targetSeconds: 3, targetWords: 9 },
  { kind: 'outcome-orbit', theme: 'Three outcomes, fast.', targetSeconds: 7, targetWords: 18 },
  { kind: 'cta-mesh',       theme: 'Call to action.', targetSeconds: 5, targetWords: 12 },
];

export const BUILTIN_TEMPLATES: Record<string, SceneBrief[]> = {
  'classic-demo': CLASSIC_DEMO_BRIEFS,
  'agent-showcase': AGENT_SHOWCASE_BRIEFS,
  'launch-teaser': LAUNCH_TEASER_BRIEFS,
};

export interface WorkspaceVideoOptions {
  workspaceDataDir: string;       // ~/.ohwow/workspaces/<name>
  openRouterApiKey: string;       // for the copy (script) LLM
  openAiApiKey?: string;           // optional; unlocks OpenAI TTS
  copyModel?: string;              // default 'anthropic/claude-sonnet-4-5'
  /** Override provider selection (otherwise auto: kokoro > openai > say). */
  ttsProvider?: TtsProvider;
  voice?: string;                  // if omitted uses the provider default
  outputDir?: string;              // where to write the spec JSON
  packageDir: string;              // @ohwow/video package for ambient music path
  /** Template name OR explicit scene briefs. Default 'classic-demo'. */
  template?: keyof typeof BUILTIN_TEMPLATES;
  briefs?: SceneBrief[];
  /** Optional free-text brief to prepend to the system prompt. */
  extraBrief?: string;
  /** Stop after script generation (no TTS, no spec write). For previews. */
  scriptsOnly?: boolean;
}

export interface WorkspaceVideoAuthorResult {
  specPath: string;
  scripts: SceneScript[];
  voiceDurationsMs: number[];
  totalFrames: number;
  facts: WorkspaceFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Workspace facts

function openWorkspaceDb(workspaceDataDir: string): unknown {
  const Database = require('better-sqlite3');
  const dbPath = join(workspaceDataDir, 'runtime.db');
  return new Database(dbPath, { readonly: true });
}

function count(db: { prepare(sql: string): { get(): unknown } }, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { n?: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function pickStrings(
  db: { prepare(sql: string): { all(): unknown[] } },
  sql: string,
  key: string,
  limit: number,
): string[] {
  try {
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows
      .map(r => String(r[key] ?? ''))
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.length < 200)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function gatherWorkspaceFacts(workspaceDataDir: string): Promise<WorkspaceFacts> {
  const db = openWorkspaceDb(workspaceDataDir) as {
    prepare(sql: string): { get(): unknown; all(): unknown[] };
    close?(): void;
  };
  try {
    const row = db.prepare(
      'SELECT business_name, business_type, business_description, founder_focus, growth_stage FROM agent_workforce_workspaces LIMIT 1',
    ).get() as { business_name?: string; business_description?: string; founder_focus?: string; growth_stage?: string } | undefined;
    const businessName = (row?.business_name ?? '').trim() || 'your workspace';
    const businessDescription = (row?.business_description ?? '').trim();
    const founderFocus = (row?.founder_focus ?? '').trim();
    const growthStage = (row?.growth_stage ?? '').trim();

    const agentCount = count(db, 'SELECT COUNT(*) as n FROM agent_workforce_agents');
    const activeAgentCount = count(
      db,
      "SELECT COUNT(*) as n FROM agent_workforce_agents WHERE status IN ('active','working','running')",
    );
    const taskCount = count(db, 'SELECT COUNT(*) as n FROM agent_workforce_tasks');
    const completedTaskCount = count(
      db,
      "SELECT COUNT(*) as n FROM agent_workforce_tasks WHERE completed_at IS NOT NULL OR status IN ('completed','done','success')",
    );
    const agentNames = pickStrings(
      db,
      `SELECT name FROM agent_workforce_agents
         WHERE name IS NOT NULL AND LENGTH(name) BETWEEN 2 AND 60
         GROUP BY name ORDER BY MAX(created_at) DESC LIMIT 8`,
      'name',
      6,
    );
    const topAgentRoles = pickStrings(
      db,
      `SELECT DISTINCT role FROM agent_workforce_agents
         WHERE role IS NOT NULL AND LENGTH(role) BETWEEN 3 AND 60
         ORDER BY created_at DESC LIMIT 6`,
      'role',
      6,
    );
    // Strip "warmup" drill rows from narration candidates — they are internal.
    const recentTaskTitles = pickStrings(
      db,
      `SELECT title FROM agent_workforce_tasks
         WHERE title IS NOT NULL
           AND LENGTH(title) BETWEEN 6 AND 80
           AND title NOT LIKE 'Warmup%'
           AND title NOT LIKE '%warmup%'
         ORDER BY created_at DESC LIMIT 12`,
      'title',
      6,
    );
    const knowledgeDocs = count(db, 'SELECT COUNT(*) as n FROM agent_workforce_knowledge_documents');
    const memories = count(db, 'SELECT COUNT(*) as n FROM agent_workforce_agent_memory');
    const goals = pickStrings(
      db,
      `SELECT title FROM agent_workforce_goals
         WHERE title IS NOT NULL ORDER BY created_at DESC LIMIT 4`,
      'title',
      4,
    );
    const topIntegrations = pickStrings(
      db,
      `SELECT source_type AS name FROM data_source_connectors
         WHERE source_type IS NOT NULL LIMIT 4`,
      'name',
      4,
    );
    return {
      workspaceName: businessName,
      businessName,
      businessDescription,
      founderFocus,
      growthStage,
      agentCount,
      activeAgentCount,
      agentNames,
      topAgentRoles,
      taskCount,
      completedTaskCount,
      recentTaskTitles,
      topIntegrations,
      knowledgeDocs,
      memories,
      goals,
    };
  } finally {
    db.close?.();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Script generation

const catalogBlock = (): string =>
  SCENE_KIND_CATALOG.map(
    s => `  - "${s.kind}" (${s.name}): ${s.fits}`,
  ).join('\n');

const VISUAL_PRIMITIVES = [
  { id: 'aurora', name: 'Aurora bands', desc: 'Slow luminous bands with blur. Ethereal, calm.', params: 'colors[], speed, opacity, y' },
  { id: 'bokeh', name: 'Bokeh circles', desc: 'Soft out-of-focus circles drifting. Dreamy, depth.', params: 'count, colors[], seed, minSize, maxSize, speed' },
  { id: 'light-rays', name: 'Light rays', desc: 'Crepuscular rays from a point. Divine, dramatic.', params: 'count, color, originX, originY, spread, opacity' },
  { id: 'constellation', name: 'Constellation net', desc: 'Nodes + faint connecting lines. Network, intelligence.', params: 'nodeCount, color, seed, speed, lineOpacity' },
  { id: 'waveform', name: 'SVG waveform', desc: 'Layered sine waves. Audio, rhythm, flow.', params: 'color, amplitude, frequency, speed, y, layers' },
  { id: 'geometric', name: 'Geometric shapes', desc: 'Rotating circles/squares/triangles. Structure.', params: 'count, color, seed, shapes[], opacity' },
  { id: 'vignette', name: 'Vignette', desc: 'Edge darkening. Focus, cinematic.', params: 'intensity, color' },
  { id: 'ripple', name: 'Ripple rings', desc: 'Expanding concentric circles. Impact, signal.', params: 'cx, cy, color, count, speed, maxRadius, opacity' },
  { id: 'gradient-wash', name: 'Gradient wash', desc: 'Moving color gradient overlay. Mood.', params: 'colors[], speed, angle, opacity' },
  { id: 'flow-field', name: 'Flow field particles', desc: 'Noise-driven particle swarm. Energy, organic.', params: 'count, seed, speed, colors[]' },
  { id: 'pulse-ring', name: 'Pulse ring', desc: 'Single breathing ring. Heartbeat, life.', params: 'cx, cy, radius, color, speed, thickness' },
  { id: 'glow-orb', name: 'Glow orb', desc: 'Soft radial glow. Warmth, presence.', params: 'cx, cy, size, color, pulseSpeed' },
  { id: 'noise-grid', name: 'Noise grid', desc: 'Grid cells with noise opacity. Data, matrix.', params: 'cols, rows, cellSize, seed, color, speed' },
  { id: 'scan-line', name: 'Scan line', desc: 'Moving horizontal line. CRT, tech.', params: 'color, speed, opacity' },
  { id: 'film-grain', name: 'Film grain', desc: 'Subtle noise texture. Analog, cinematic.', params: 'intensity' },
] as const;

const TEXT_ANIMATIONS = ['typewriter', 'fade-in', 'word-by-word', 'letter-scatter', 'glow-text', 'split-reveal', 'count-up'] as const;
const TEXT_POSITIONS = ['center', 'bottom-center', 'bottom-left', 'top-center'] as const;

const primitiveCatalogBlock = (): string =>
  VISUAL_PRIMITIVES.map(
    p => `  - "${p.id}" (${p.name}): ${p.desc} Params: ${p.params}`,
  ).join('\n');

const SCRIPT_SYSTEM = `You are a copywriter and motion-graphics director for ohwow — a local-first AI runtime that gives people an "AI team" that learns, remembers, and works autonomously.

Ohwow's voice: direct, warm, confident, zero corporate language, zero marketing buzzwords. Short sentences. Second person ("you"). Sounds like a knowing friend, not a brochure.

You author video storyboards. Each scene pairs narration with visuals. You have two modes:

MODE 1 — COMPOSABLE SCENES (preferred for new videos)
You design the visual composition from scratch using visual primitives. Each scene gets:
- A "visualLayers" array: primitives stacked bottom-to-top, each with params
- A "text" object: the on-screen text content with animation style
- A "mood": one of dark, warm, cool, electric, forest, sunset, midnight

Available visual primitives (composable, stackable):
${primitiveCatalogBlock()}

Text animation styles:
  - typewriter: char-by-char reveal with cursor (default, good for narration)
  - fade-in: fade + slide up (clean, minimal)
  - word-by-word: words appear sequentially, last word accented (emphasis)
  - letter-scatter: letters fly in from random positions (playful, energetic)
  - glow-text: text with animated bloom/glow (taglines, dramatic moments)
  - split-reveal: lines slide in from alternating sides (use \\n to split lines)
  - count-up: animated number counting from 0 to N (stats: "33 agents", "189 tasks")
Text positions: center, bottom-center, bottom-left, top-center

Creative guidance for layer composition:
- 2-4 visual layers per scene is the sweet spot. Too many = visual noise.
- Start with atmosphere (aurora, gradient-wash, bokeh) then add structure (constellation, geometric, waveform).
- End with polish (vignette, film-grain, scan-line).
- Vary layer combinations between scenes. Every scene should feel distinct.
- Use opacity to control visual weight. Background layers: 0.05-0.15. Foreground: 0.1-0.3.
- Speed creates rhythm. Slow (0.002-0.008) = meditative. Fast (0.02-0.05) = energetic.

MODE 2 — TEMPLATE SCENES (for structured content)
Pre-built motion-graphics templates. Use these when you need specific data visualizations:
${catalogBlock()}

You choose how many scenes a video needs — 3 to 7 — depending on the story.

PER-VIDEO COLOR IDENTITY
Pick a single palette for the whole video:
- "seedHue": 0-360 (the base hue from which all colors derive)
- "harmony": analogous, complementary, triadic, or split
- "mood": the dominant mood for the video
Scenes vary within this palette. This gives each video a cohesive look.

Constraints:
- DO NOT lead with raw metrics. Describe what agents FEEL like to live with.
- When you use a number, tie it to a human outcome. "166 tasks done while you slept" beats "166 completed tasks."
- Never invent product features. Only describe what the facts support.
- No em-dashes, no parentheses, no "(s)" pluralization.
- Second person. No "we" or "our".
- Write for a busy founder who has 30 seconds and a skeptical mind. Paint the AFTER picture.
- Philosophical > promotional.
- End with a memorable tagline on the last scene.`;

function factsBlock(facts: WorkspaceFacts): string {
  const lines: string[] = [];
  lines.push(`- Business: "${facts.businessName}"${facts.growthStage ? ` (${facts.growthStage} stage)` : ''}`);
  if (facts.businessDescription) lines.push(`- What they do: ${facts.businessDescription}`);
  if (facts.founderFocus) lines.push(`- Founder focus: ${facts.founderFocus}`);
  lines.push(`- Agents: ${facts.agentCount}${facts.activeAgentCount ? ` (${facts.activeAgentCount} active)` : ''}`);
  if (facts.agentNames.length) lines.push(`- Agent names: ${facts.agentNames.join(', ')}`);
  if (facts.topAgentRoles.length) lines.push(`- Agent roles: ${facts.topAgentRoles.join(', ')}`);
  lines.push(`- Tasks: ${facts.taskCount}${facts.completedTaskCount ? ` (${facts.completedTaskCount} completed)` : ''}`);
  if (facts.recentTaskTitles.length) {
    lines.push(`- Recent tasks: ${facts.recentTaskTitles.slice(0, 4).map(t => `"${t}"`).join('; ')}`);
  }
  if (facts.memories) lines.push(`- Memories stored: ${facts.memories}`);
  if (facts.knowledgeDocs) lines.push(`- Knowledge docs: ${facts.knowledgeDocs}`);
  if (facts.goals.length) lines.push(`- Goals: ${facts.goals.join('; ')}`);
  if (facts.topIntegrations.length) lines.push(`- Integrations: ${facts.topIntegrations.join(', ')}`);
  return lines.join('\n');
}

function briefsBlock(briefs: SceneBrief[]): string {
  return briefs
    .map(
      (b, i) =>
        `${i + 1}. "${b.kind}" — ${b.theme} (~${b.targetSeconds}s${b.targetWords ? `, ~${b.targetWords} words` : ''})`,
    )
    .join('\n');
}

function buildScriptPrompt(facts: WorkspaceFacts, briefs: SceneBrief[] | null, extraBrief?: string): string {
  const factsSection = `Workspace facts (ground truth — do not invent beyond these):\n${factsBlock(facts)}`;
  const extraSection = extraBrief ? `\nAdditional direction from the creator:\n${extraBrief}\n` : '';

  if (briefs && briefs.length > 0) {
    // Guided mode: user specified the scene order and count.
    const kindsList = briefs.map(b => `"${b.kind}"`).join(', ');
    return `${factsSection}
${extraSection}
Produce exactly ${briefs.length} scenes in the order ${kindsList}, matching these themes:

${briefsBlock(briefs)}

Each script is one to three short sentences. Conversational. Punchy. Second person.
If facts are thin, lean on business_description and founder_focus. Do not mention "warmup" drills.

Respond with ONLY a JSON array:
[
  { "kind": "<scene-kind>", "script": "narration text", "targetSeconds": <estimated length in seconds> }
]`;
  }

  // Free-form mode: LLM decides the storyboard with composable visuals.
  return `${factsSection}
${extraSection}
Design a video storyboard for this workspace using COMPOSABLE SCENES. Choose 3 to 7 scenes.

First, pick a video-level palette (seedHue 0-360, harmony, mood) that fits the brand.

For each scene, write:
- "kind": "composable" (use visual primitives) or a template kind for data-heavy scenes
- "script": the narration (1-3 short sentences, second person, conversational)
- "targetSeconds": how long the narration takes to speak (3-12 seconds)
- "mood": scene mood (dark, warm, cool, electric, forest, sunset, midnight)
- "pacing": "urgent" (fast particles, quick reveals) | "steady" (balanced) | "reflective" (slow, breathing). If omitted, derived from mood.
- "visualLayers": array of { "primitive": "<id>", ...params } — 2-4 layers per scene
- "text": { "content": "<on-screen text>", "animation": "typewriter|fade-in|word-by-word|letter-scatter", "position": "center|bottom-center|bottom-left|top-center", "fontSize": <number> }

For composable scenes, the text.content should be a punchy version of the narration — not the full script. Think title card, not transcript.

If facts are thin, lean on business_description and growth context. Do not mention "warmup" drills. End with a strong tagline.

Respond with ONLY a JSON object:
{
  "palette": { "seedHue": <0-360>, "harmony": "analogous|complementary|triadic|split", "mood": "<mood>" },
  "scenes": [
    {
      "kind": "composable",
      "script": "narration text",
      "targetSeconds": 5,
      "mood": "cool",
      "visualLayers": [
        { "primitive": "aurora", "colors": ["#22d3ee", "#818cf8"], "speed": 0.006, "opacity": 0.12 },
        { "primitive": "constellation", "nodeCount": 15, "color": "#818cf8", "speed": 0.003 },
        { "primitive": "vignette", "intensity": 0.5 }
      ],
      "text": { "content": "Short punchy text", "animation": "fade-in", "position": "center" }
    }
  ]
}`;
}

export async function generateScripts(
  facts: WorkspaceFacts,
  briefs: SceneBrief[] | null,
  apiKey: string,
  model = 'anthropic/claude-sonnet-4-5',
  extraBrief?: string,
): Promise<LlmStoryboard> {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ohwow.fun',
      'X-Title': 'ohwow video',
    },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model,
      temperature: 0.8,
      messages: [
        { role: 'system', content: SCRIPT_SYSTEM },
        { role: 'user', content: buildScriptPrompt(facts, briefs, extraBrief) },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Script LLM failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content ?? '';

  let parsed: unknown;
  try {
    // Try parsing as a JSON object first (new composable format)
    const objStart = raw.indexOf('{');
    const objEnd = raw.lastIndexOf('}');
    if (objStart !== -1 && objEnd > objStart) {
      parsed = JSON.parse(raw.slice(objStart, objEnd + 1));
    }
  } catch {
    // fall through
  }

  // Fall back to array format (legacy guided mode)
  if (!parsed) {
    try {
      const arrJson = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
      const arr = JSON.parse(arrJson);
      if (Array.isArray(arr)) {
        parsed = { scenes: arr };
      }
    } catch {
      throw new Error(`Script LLM returned non-JSON: ${raw.slice(0, 300)}`);
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Script LLM returned unparseable response: ${raw.slice(0, 300)}`);
  }

  const obj = parsed as Record<string, unknown>;
  const scenesArr = Array.isArray(obj.scenes) ? obj.scenes : Array.isArray(parsed) ? (parsed as unknown[]) : null;
  if (!scenesArr || scenesArr.length === 0) {
    throw new Error('Script LLM returned no scenes');
  }
  if (briefs && scenesArr.length !== briefs.length) {
    throw new Error(`Script LLM returned ${scenesArr.length} items, need ${briefs.length}`);
  }

  const palette = obj.palette as LlmStoryboard['palette'] | undefined;

  const scenes: SceneScript[] = (scenesArr as Array<Record<string, unknown>>).map((s, i) => {
    const kind = String(s.kind ?? (briefs ? briefs[i].kind : 'composable'));
    const result: SceneScript = {
      kind,
      script: String(s.script ?? '').trim(),
      caption: s.caption ? String(s.caption).trim() : undefined,
    };
    if (s.mood) result.mood = String(s.mood);
    if (s.pacing) result.pacing = String(s.pacing);
    if (Array.isArray(s.visualLayers)) result.visualLayers = s.visualLayers as SceneScript['visualLayers'];
    if (s.text && typeof s.text === 'object') result.text = s.text as SceneScript['text'];
    return result;
  });

  return { palette, scenes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Voice generation (cached)

export type TtsProviderName = 'kokoro' | 'say' | 'openai';

export interface TtsProvider {
  name: TtsProviderName;
  /** Auto-select a reasonable voice if user didn't set one. */
  defaultVoice: string;
  isAvailable(): Promise<boolean>;
  synthesize(params: { text: string; voice: string; speed: number }): Promise<Buffer>;
}

async function runSpawn(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', c => (err += c.toString()));
    child.on('close', code => resolvePromise({ code: code ?? 1, stderr: err }));
  });
}

/** macOS `say` → aiff → ffmpeg → mp3. Deterministic, on-device, zero-config. */
export const sayProvider: TtsProvider = {
  name: 'say',
  defaultVoice: 'Alex',
  async isAvailable() {
    if (platform() !== 'darwin') return false;
    const { code } = await runSpawn('say', ['-v', '?']);
    return code === 0;
  },
  async synthesize({ text, voice, speed }) {
    const id = Math.random().toString(36).slice(2, 10);
    const aiff = join(tmpdir(), `ohwow-say-${id}.aiff`);
    const mp3 = join(tmpdir(), `ohwow-say-${id}.mp3`);
    // say --rate is words per minute; baseline 175. Map speed 0.5–2.0 onto 90–350 wpm.
    const wpm = Math.round(175 * speed);
    const sayArgs = ['-v', voice, '-r', String(wpm), '-o', aiff, text];
    const sayResult = await runSpawn('say', sayArgs);
    if (sayResult.code !== 0) throw new Error(`say failed: ${sayResult.stderr.slice(-200)}`);
    const ffArgs = ['-y', '-loglevel', 'error', '-i', aiff, '-codec:a', 'libmp3lame', '-qscale:a', '3', mp3];
    const ffResult = await runSpawn('ffmpeg', ffArgs);
    if (ffResult.code !== 0) throw new Error(`ffmpeg failed: ${ffResult.stderr.slice(-200)}`);
    const buffer = await readFile(mp3);
    await Promise.allSettled([unlink(aiff), unlink(mp3)]);
    return buffer;
  },
};

/** Kokoro-FastAPI at localhost:8880. High-quality local neural TTS. */
export const kokoroProvider: TtsProvider = {
  name: 'kokoro',
  defaultVoice: 'af_heart',
  async isAvailable() {
    try {
      const resp = await fetch('http://127.0.0.1:8880/v1/audio/voices', { signal: AbortSignal.timeout(2000) });
      return resp.ok;
    } catch { return false; }
  },
  async synthesize({ text, voice, speed }) {
    const resp = await fetch('http://127.0.0.1:8880/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: text, voice, speed, response_format: 'mp3' }),
    });
    if (!resp.ok) throw new Error(`Kokoro failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  },
};

/** OpenAI TTS direct (needs OPENAI_API_KEY — OpenRouter doesn't proxy TTS). */
export function makeOpenAiProvider(apiKey: string): TtsProvider {
  return {
    name: 'openai',
    defaultVoice: 'onyx',
    async isAvailable() { return Boolean(apiKey); },
    async synthesize({ text, voice, speed }) {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model: 'tts-1', input: text, voice, speed, response_format: 'mp3' }),
      });
      if (!resp.ok) throw new Error(`OpenAI TTS failed: ${resp.status}`);
      return Buffer.from(await resp.arrayBuffer());
    },
  };
}

export async function selectTtsProvider(opts: { openAiApiKey?: string }): Promise<TtsProvider> {
  if (await kokoroProvider.isAvailable()) return kokoroProvider;
  if (opts.openAiApiKey) {
    const openai = makeOpenAiProvider(opts.openAiApiKey);
    if (await openai.isAvailable()) return openai;
  }
  if (await sayProvider.isAvailable()) return sayProvider;
  throw new Error(
    'No TTS provider available. Start Kokoro (port 8880), set OPENAI_API_KEY, or run on macOS for the built-in `say` fallback.',
  );
}

export async function generateVoiceForScript(
  script: SceneScript,
  opts: { provider: TtsProvider; voice: string; speed?: number },
): Promise<{ path: string; hash: string; cached: boolean }> {
  const modality: CacheModality = 'voice';
  const inputs = {
    provider: opts.provider.name,
    voice: opts.voice,
    speed: opts.speed ?? 1.0,
    text: script.script,
  };
  return getOrCreate(modality, inputs, {
    produce: async () => {
      logger.info(`[video/voice] TTS cache miss — ${opts.provider.name}/${opts.voice} (${script.script.length} chars)`);
      const buffer = await opts.provider.synthesize({
        text: script.script,
        voice: opts.voice,
        speed: opts.speed ?? 1.0,
      });
      return { buffer, extension: '.mp3' };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Duration probe

async function ffprobeDurationMs(path: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', c => (out += c.toString()));
    child.stderr.on('data', c => (err += c.toString()));
    child.on('close', code => {
      if (code !== 0) return rejectPromise(new Error(`ffprobe failed (${code}): ${err.slice(-200)}`));
      const seconds = parseFloat(out.trim());
      if (!Number.isFinite(seconds)) return rejectPromise(new Error(`ffprobe non-numeric: "${out.trim()}"`));
      resolvePromise(Math.round(seconds * 1000));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Spec assembly

interface BrandDefaults {
  colors: Record<string, string>;
  fonts: { sans: string; mono: string; display: string };
  glass: { background: string; border: string; borderRadius: number; backdropFilter: string };
}

const DEFAULT_BRAND: BrandDefaults = {
  colors: {
    bg: '#0a0a0f', accent: '#f97316', accentGlow: 'rgba(249, 115, 22, 0.3)',
    blue: '#3b82f6', green: '#22c55e', purple: '#a855f7',
    text: '#e4e4e7', textMuted: '#71717a', textDim: 'rgba(255,255,255,0.4)',
    card: 'rgba(255,255,255,0.06)', cardBorder: 'rgba(255,255,255,0.1)',
    chatgpt: '#10a37f', claude: '#d97706', gemini: '#4285f4',
    perplexity: '#20b2aa', grok: '#e5e5e5',
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
};

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function stageAudioIntoPackage(
  sourcePath: string,
  hash: string,
  packageDir: string,
): Promise<string> {
  const stagedDir = join(packageDir, 'public', 'voice');
  await mkdir(stagedDir, { recursive: true });
  const stagedPath = join(stagedDir, `${hash}.mp3`);
  if (!(await fileExists(stagedPath))) {
    await copyFile(sourcePath, stagedPath);
  }
  return `voice/${hash}.mp3`;
}

interface ResolvedVoice {
  kind: string;
  script: string;
  caption?: string;
  publicRef: string;
  path: string;
  durationMs: number;
  voiceFrames: number;
  mood?: string;
  pacing?: string;
  visualLayers?: SceneScript['visualLayers'];
  text?: SceneScript['text'];
}

function framesFor(resolved: ResolvedVoice): number {
  // scene = lead + voice + tail (but at least SCENE_MIN_FRAMES)
  return Math.max(SCENE_MIN_FRAMES, VOICE_LEAD_FRAMES + resolved.voiceFrames + VOICE_TAIL_FRAMES);
}

/**
 * Derive visual params from the narration and workspace facts based on scene kind.
 * This is the "semantic bridge" — the LLM writes copy, and this function translates
 * that copy into the params each motion-graphics template needs.
 */
function deriveVisualParams(
  kind: string,
  narration: string,
  facts?: WorkspaceFacts,
  sceneIndex = 0,
): Record<string, unknown> {
  switch (kind) {
    case 'text-typewriter': {
      const moods = ['dark', 'cool', 'electric', 'midnight', 'warm', 'sunset'] as const;
      return {
        text: narration,
        fontSize: narration.length > 80 ? 34 : narration.length > 50 ? 38 : 44,
        mood: moods[sceneIndex % moods.length],
        variation: sceneIndex,
        intensity: Math.min(1, 0.3 + sceneIndex * 0.15),
      };
    }
    case 'stats-counter': {
      const counters: Array<{ to: number; label: string; color?: string; startFrame?: number }> = [];
      if (facts?.agentCount) counters.push({ to: facts.agentCount, label: 'agents', color: '#f97316', startFrame: 15 });
      if (facts?.completedTaskCount) counters.push({ to: facts.completedTaskCount, label: 'tasks completed', color: '#3b82f6', startFrame: 30 });
      if (facts?.memories) counters.push({ to: facts.memories, label: 'memories', color: '#22c55e', startFrame: 45 });
      if (facts?.knowledgeDocs) counters.push({ to: facts.knowledgeDocs, label: 'knowledge docs', color: '#a855f7', startFrame: 60 });
      return counters.length > 0 ? { counters: counters.slice(0, 4) } : {};
    }
    case 'prompts-grid': {
      if (!facts?.recentTaskTitles?.length) return {};
      const apps = ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'];
      const times = ['8:12 AM', '9:33 AM', '10:47 AM', '11:15 AM', '1:22 PM', '2:09 PM', '3:44 PM', '4:18 PM', '5:01 PM', '6:33 PM'];
      return {
        prompts: facts.recentTaskTitles.slice(0, 10).map((t, i) => ({
          text: t.length > 60 ? t.slice(0, 57) + '...' : t,
          time: times[i % times.length],
          app: apps[i % apps.length],
        })),
      };
    }
    case 'outcome-orbit': {
      if (!facts) return {};
      const icons = ['🤖', '📧', '📊', '🔍', '💬', '📝', '⚡', '🎯', '🔧'];
      const outColors = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#f97316'];
      const sentences = narration.replace(/([.!?])\s+/g, '$1|').split('|').filter(s => s.trim().length > 10);
      return {
        outcomes: sentences.slice(0, 6).map((text, i) => ({
          text: text.trim(),
          color: outColors[i % outColors.length],
          icon: icons[i % icons.length],
          delay: 15 + i * 25,
        })),
      };
    }
    case 'extraction': {
      if (!facts) return {};
      const cards: Array<{ type: string; text: string; delay: number }> = [];
      if (facts.memories) cards.push({ type: 'Memories', text: `${facts.memories} memories extracted and structured`, delay: 80 });
      if (facts.completedTaskCount) cards.push({ type: 'Tasks', text: `${facts.completedTaskCount} tasks completed autonomously`, delay: 120 });
      if (facts.agentNames.length) cards.push({ type: 'Agents', text: facts.agentNames.slice(0, 3).join(', '), delay: 160 });
      if (facts.knowledgeDocs) cards.push({ type: 'Knowledge', text: `${facts.knowledgeDocs} documents indexed`, delay: 200 });
      return cards.length > 0 ? { cards } : {};
    }
    case 'drop': {
      if (!facts?.topIntegrations?.length && !facts?.agentNames?.length) return {};
      const sources = facts.topIntegrations.length ? facts.topIntegrations : ['ChatGPT', 'Claude', 'Gemini'];
      const fileColors = ['#10a37f', '#d97706', '#4285f4', '#20b2aa', '#a855f7'];
      return {
        files: sources.slice(0, 4).map((s, i) => ({
          name: `${s.toLowerCase().replace(/\s+/g, '-')}.json`,
          source: s,
          color: fileColors[i % fileColors.length],
          delay: i * 15,
        })),
      };
    }
    case 'cta-mesh': {
      if (!facts) return {};
      const tagline = narration.split(/[.!]/).filter(s => s.trim().length > 5).pop()?.trim() ?? 'Your AI team that actually remembers.';
      return {
        cta: {
          tagline,
          subline: facts.businessName !== 'your workspace' ? facts.businessName : 'Free and open source.',
        },
      };
    }
    case 'agent-roster': {
      if (!facts) return {};
      const agentColors = ['#f97316', '#3b82f6', '#22c55e', '#a855f7', '#e11d48', '#06b6d4'];
      const agents = facts.agentNames.slice(0, 6).map((name, i) => ({
        name,
        role: facts.topAgentRoles[i] ?? 'Agent',
        color: agentColors[i % agentColors.length],
        delay: 15 + i * 18,
      }));
      return agents.length > 0 ? { agents } : {};
    }
    case 'terminal-log': {
      if (!facts) return {};
      const logColors = ['#3b82f6', '#71717a', '#22c55e', '#71717a', '#a855f7', '#71717a', '#f97316', '#71717a'];
      const lines: Array<{ text: string; color: string; delay: number }> = [];
      facts.agentNames.slice(0, 4).forEach((name, i) => {
        const role = facts.topAgentRoles[i] ?? 'working';
        lines.push({ text: `→ ${name.toLowerCase()}: ${role.toLowerCase()}...`, color: logColors[(i * 2) % logColors.length], delay: 12 + i * 20 });
        const task = facts.recentTaskTitles[i];
        if (task) lines.push({ text: `  ${task.toLowerCase()}`, color: '#71717a', delay: 18 + i * 20 });
      });
      return lines.length > 0 ? { lines } : {};
    }
    case 'before-after': {
      const beforeItems = [
        { text: 'Checking 5 apps before coffee', icon: '😫' },
        { text: 'Copy-pasting between tools', icon: '📋' },
        { text: 'Forgetting to follow up', icon: '🕳️' },
        { text: 'Working weekends', icon: '😓' },
      ];
      const afterItems: Array<{ text: string; icon: string }> = [];
      if (facts?.agentCount) afterItems.push({ text: `${facts.agentCount} agents handle it`, icon: '✨' });
      if (facts?.completedTaskCount) afterItems.push({ text: `${facts.completedTaskCount} tasks done autonomously`, icon: '⚡' });
      afterItems.push({ text: 'Nothing falls through', icon: '🎯' });
      afterItems.push({ text: 'Friday off. Nothing breaks.', icon: '🏖️' });
      return { before: { items: beforeItems }, after: { items: afterItems.slice(0, 4) } };
    }
    case 'notification-stack': {
      if (!facts) return {};
      const notifications: Array<{ text: string; icon: string; color: string; delay: number }> = [];
      const notifIcons = ['🔍', '📝', '📧', '🛡️', '🧠', '💰'];
      const notifColors = ['#3b82f6', '#22c55e', '#f97316', '#a855f7', '#06b6d4', '#22c55e'];
      facts.recentTaskTitles.slice(0, 6).forEach((title, i) => {
        notifications.push({
          text: title,
          icon: notifIcons[i % notifIcons.length],
          color: notifColors[i % notifColors.length],
          delay: 15 + i * 15,
        });
      });
      return notifications.length > 0 ? { notifications } : {};
    }
    case 'quote-card': {
      const moods = ['electric', 'sunset', 'midnight', 'cool', 'warm'] as const;
      return {
        quote: narration,
        mood: moods[sceneIndex % moods.length],
        variation: sceneIndex,
      };
    }
    case 'workflow-steps': {
      const sentences = narration.replace(/([.!?])\s+/g, '$1|').split('|').filter(s => s.trim().length > 5);
      const stepIcons = ['👁️', '🧠', '⚡', '🔄', '🎯', '✨'];
      const steps = sentences.slice(0, 5).map((text, i) => ({
        label: text.trim().split(' ').slice(0, 3).join(' '),
        description: text.trim(),
        icon: stepIcons[i % stepIcons.length],
        delay: 15 + i * 25,
      }));
      return steps.length > 0 ? { steps } : {};
    }
    default:
      return {};
  }
}

/**
 * Build params for a composable scene from LLM output.
 * The LLM provides visualLayers, text config, and mood directly.
 * We pass them through as ComposableScene params.
 */
function buildComposableParams(
  voice: ResolvedVoice,
  palette?: LlmStoryboard['palette'],
  sceneIndex = 0,
): Record<string, unknown> {
  const params: Record<string, unknown> = { sceneIndex };

  if (voice.visualLayers && voice.visualLayers.length > 0) {
    params.visualLayers = voice.visualLayers.map(layer => {
      const { primitive, ...rest } = layer;
      return { primitive, params: rest };
    });
  }

  if (voice.text) {
    params.text = voice.text;
  } else {
    const content = voice.script.split(/[.!?]/).filter(s => s.trim().length > 5)[0]?.trim() ?? voice.script;
    params.text = {
      content: content.length > 80 ? content.slice(0, 77) + '...' : content,
      animation: (['typewriter', 'fade-in', 'word-by-word', 'letter-scatter'] as const)[sceneIndex % 4],
      position: 'center',
    };
  }

  if (voice.mood) params.mood = voice.mood;
  if (voice.pacing) params.pacing = voice.pacing;
  if (palette) params.palette = palette;

  return params;
}

type TransitionSpec =
  | { kind: 'fade'; durationInFrames: number; spring: { damping: number; durationRestThreshold: number } }
  | { kind: 'slide'; direction: 'from-right' | 'from-left'; durationInFrames: number }
  | { kind: 'wipe'; direction: 'from-left' | 'from-right' | 'from-top' | 'from-bottom'; durationInFrames: number }
  | { kind: 'none' };

const CALM_MOODS = new Set(['warm', 'forest', 'sunset', 'cool']);
const INTENSE_MOODS = new Set(['electric', 'dark', 'midnight']);
const EXTREME_PAIRS: ReadonlySet<string> = new Set([
  'warm|electric', 'electric|warm',
  'warm|dark', 'dark|warm',
  'forest|electric', 'electric|forest',
  'sunset|dark', 'dark|sunset',
]);
const WIPE_DIRECTIONS = ['from-left', 'from-right', 'from-top', 'from-bottom'] as const;

function pickTransition(
  from: { kind: string; params?: Record<string, unknown> },
  to: { kind: string; params?: Record<string, unknown> },
  index = 0,
): TransitionSpec {
  const fromMood = (from.params as { mood?: string } | undefined)?.mood;
  const toMood = (to.params as { mood?: string } | undefined)?.mood;
  const sameMood = fromMood === toMood;
  const calmToCalm = CALM_MOODS.has(fromMood ?? '') && CALM_MOODS.has(toMood ?? '');

  if (sameMood || calmToCalm) {
    return { kind: 'fade', durationInFrames: Math.round(TRANSITION_FRAMES * 1.5), spring: { damping: 200, durationRestThreshold: 0.001 } };
  }

  const pairKey = `${fromMood ?? ''}|${toMood ?? ''}`;
  if (EXTREME_PAIRS.has(pairKey)) {
    return { kind: 'none' };
  }

  const intensityShift =
    (CALM_MOODS.has(fromMood ?? '') && INTENSE_MOODS.has(toMood ?? '')) ||
    (INTENSE_MOODS.has(fromMood ?? '') && CALM_MOODS.has(toMood ?? ''));
  if (intensityShift) {
    const dir = WIPE_DIRECTIONS[index % WIPE_DIRECTIONS.length];
    return { kind: 'wipe', direction: dir, durationInFrames: TRANSITION_FRAMES };
  }

  const direction = index % 2 === 0 ? 'from-right' as const : 'from-left' as const;
  return { kind: 'slide', direction, durationInFrames: TRANSITION_FRAMES };
}

function buildSpec(params: {
  voices: ResolvedVoice[];
  musicSrc: string;
  brand?: BrandDefaults;
  id?: string;
  facts?: WorkspaceFacts;
  palette?: LlmStoryboard['palette'];
}) {
  const brand = params.brand ?? DEFAULT_BRAND;
  const id = params.id ?? `workspace-${Date.now()}`;

  let cursor = 0;
  const voiceovers: Array<{ src: string; startFrame: number; volume: number }> = [];
  const scenes: Array<{ id: string; kind: string; durationInFrames: number; params: Record<string, unknown>; narration: string }> = [];

  for (let i = 0; i < params.voices.length; i++) {
    const v = params.voices[i];
    const sceneFrames = framesFor(v);
    voiceovers.push({ src: v.publicRef, startFrame: cursor + VOICE_LEAD_FRAMES, volume: 0.9 });

    let sceneParams: Record<string, unknown>;
    if (v.kind === 'composable') {
      sceneParams = buildComposableParams(v, params.palette, i);
    } else {
      sceneParams = deriveVisualParams(v.kind, v.script, params.facts, i);
    }

    scenes.push({
      id: `s${i + 1}`,
      kind: v.kind,
      durationInFrames: sceneFrames,
      params: sceneParams,
      narration: v.script,
    });
    cursor += sceneFrames;
    if (i < params.voices.length - 1) cursor -= TRANSITION_FRAMES;
  }

  return {
    id,
    version: 1 as const,
    fps: 30 as const,
    width: 1280 as const,
    height: 720 as const,
    brand,
    ...(params.palette ? { palette: params.palette } : {}),
    music: { src: params.musicSrc, startFrame: 0, volume: 0.22 },
    voiceovers,
    transitions: Array.from({ length: Math.max(0, params.voices.length - 1) }, (_, i) =>
      pickTransition(scenes[i], scenes[i + 1], i),
    ),
    scenes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Top-level skill

export async function authorWorkspaceVideoSpec(
  opts: WorkspaceVideoOptions,
  onProgress?: (msg: string) => void,
): Promise<WorkspaceVideoAuthorResult> {
  const progress = (m: string) => {
    logger.info(`[video/workspace] ${m}`);
    onProgress?.(m);
  };

  progress('gathering workspace facts');
  const facts = await gatherWorkspaceFacts(opts.workspaceDataDir);

  const briefs: SceneBrief[] | null = opts.briefs
    ?? (opts.template ? BUILTIN_TEMPLATES[opts.template] ?? null : null);
  const mode = briefs ? `guided (${briefs.length} scenes)` : 'free-form (LLM decides)';

  progress(`generating scripts — ${mode}, ${facts.agentCount} agents, ${facts.taskCount} tasks`);
  const storyboard = await generateScripts(
    facts,
    briefs,
    opts.openRouterApiKey,
    opts.copyModel ?? 'anthropic/claude-sonnet-4-5',
    opts.extraBrief,
  );
  const scripts = storyboard.scenes;

  if (opts.scriptsOnly) {
    return {
      specPath: '',
      scripts,
      voiceDurationsMs: [],
      totalFrames: 0,
      facts,
    };
  }

  const provider = opts.ttsProvider ?? (await selectTtsProvider({ openAiApiKey: opts.openAiApiKey }));
  const voice = opts.voice ?? provider.defaultVoice;
  progress(`using TTS provider: ${provider.name} (voice: ${voice})`);

  progress(`generating voice for ${scripts.length} scenes`);
  const voices: ResolvedVoice[] = [];
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    progress(`  voice ${i + 1}/${scripts.length}: ${s.script.slice(0, 50)}${s.script.length > 50 ? '…' : ''}`);
    const { path, hash } = await generateVoiceForScript(s, { provider, voice });
    const durationMs = await ffprobeDurationMs(path);
    const voiceFrames = Math.round((durationMs / 1000) * FPS);
    const publicRef = await stageAudioIntoPackage(path, hash, opts.packageDir);
    voices.push({
      kind: s.kind,
      script: s.script,
      caption: s.caption,
      publicRef,
      path,
      durationMs,
      voiceFrames,
      mood: s.mood,
      pacing: s.pacing,
      visualLayers: s.visualLayers,
      text: s.text,
    });
  }

  const musicSrc = 'audio/ambient.mp3';
  const spec = buildSpec({ voices, musicSrc, facts, palette: storyboard.palette });

  const outDir = opts.outputDir ?? join(homedir(), '.ohwow', 'media', 'specs');
  await mkdir(outDir, { recursive: true });
  const specPath = join(outDir, `workspace-${facts.workspaceName}-${Date.now()}.json`);
  await writeFile(specPath, JSON.stringify(spec, null, 2));

  const totalFrames = spec.scenes.reduce((acc, s, i) => {
    let t = acc + s.durationInFrames;
    if (i < spec.scenes.length - 1) t -= TRANSITION_FRAMES;
    return t;
  }, 0);

  progress(`spec written: ${specPath} (${totalFrames} frames)`);

  return {
    specPath,
    scripts,
    voiceDurationsMs: voices.map(v => v.durationMs),
    totalFrames,
    facts,
  };
}
