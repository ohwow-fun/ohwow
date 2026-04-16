/**
 * Runtime Config
 * Loads configuration from ~/.ohwow/config.json or environment variables.
 * Supports free tier (no license key) and connected tier (cloud via license key).
 * Plan-specific enforcement happens on the cloud side, not in the runtime.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { McpServerConfig } from './mcp/types.js';
import { logger } from './lib/logger.js';

export type RuntimeTier = 'free' | 'connected';

export type ModelSource = 'local' | 'cloud' | 'auto' | 'claude-code' | 'claude-code-cli';

/** Which cloud provider to use when modelSource === 'cloud' */
export type CloudProvider = 'anthropic' | 'openrouter';

export type ClaudeCodeCliPermissionMode = 'skip' | 'allowedTools' | 'interactive';

export type DeviceRole = 'hybrid' | 'worker' | 'coordinator';

export interface RuntimeConfig {
  /** License key for the workspace (empty for free tier) */
  licenseKey: string;
  /** Cloud control plane URL */
  cloudUrl: string;
  /** Anthropic API key (customer's own key) */
  anthropicApiKey: string;
  /** Which model provider to use: local (Ollama), cloud (Claude), or auto (route by task) */
  modelSource: ModelSource;
  /** Which cloud provider to use when modelSource === 'cloud' */
  cloudProvider: CloudProvider;
  /** Cloud model ID for the selected cloud provider */
  cloudModel: string;
  /** OAuth token from Anthropic browser flow */
  anthropicOAuthToken: string;
  /** Port for the local HTTP server */
  port: number;
  /** Path to SQLite database file */
  dbPath: string;
  /** JWT secret (shared with cloud) */
  jwtSecret: string;
  /** Local URL the runtime is accessible at */
  localUrl: string;
  /** Run browser in headless mode (default: true). Set OHWOW_BROWSER_HEADLESS=false to show window. */
  browserHeadless: boolean;
  /** Browser target: 'chromium' (Playwright default) or 'chrome' (connect to real Chrome via CDP). Default: 'chrome'. */
  browserTarget: 'chromium' | 'chrome';
  /** CDP port for Chrome remote debugging (default: 9222). Only used when browserTarget is 'chrome'. */
  chromeCdpPort: number;
  /**
   * Map of email → Chrome profile directory for desktop_focus_app
   * resolution. Lets users pass a human identity (ogsus@ohwow.fun) and
   * have the tool target the right profile, even when that email is
   * not a Google account and therefore isn't stored in Chrome's
   * account_info. Example: { "ogsus@ohwow.fun": "Profile 1" }.
   */
  chromeProfileAliases: Record<string, string>;
  /**
   * Default Chrome profile directory (as it lives in chrome-debug/) for
   * this workspace's debug Chrome. Used when the daemon needs to spawn
   * a fresh debug Chrome and no call site passed an explicit profile.
   * Most boxes have multiple Google accounts under a single debug
   * data-dir; without this, spawns land on 'Default', which is rarely
   * the account signed into the workspace's target sites (x.com etc.).
   * Set e.g. 'Profile 1' in ~/.ohwow/config.json or workspace.json.
   */
  chromeDefaultProfile: string;
  /** Ollama URL for local model inference (default: http://localhost:11434) */
  ollamaUrl: string;
  /** Ollama model name (default: llama3.1) */
  ollamaModel: string;
  /** Prefer local Ollama model for routine tasks (default: false) */
  preferLocalModel: boolean;
  /** Override model for the orchestrator chat (empty = use default ollamaModel or Claude) */
  orchestratorModel: string;
  /** Smaller/faster Ollama model for simple tasks (default: empty, disabled) */
  quickModel: string;
  /** Ollama OCR model name for vision/text extraction (default: empty, disabled) */
  ocrModel: string;
  /** OpenRouter API key for free frontier models */
  openRouterApiKey: string;
  /** OpenRouter model ID (default: deepseek/deepseek-v3.2) */
  openRouterModel: string;
  /** fal.ai API key for hosted video/image generation */
  falKey: string;
  /** fal.ai model slug for text-to-video (e.g. fal-ai/seedance-1-0-pro, fal-ai/kling-video/v2.1/master/text-to-video) */
  falVideoModel: string;
  /** Port for the Scrapling sidecar server (default: 8100) */
  scraplingPort: number;
  /** Auto-start Scrapling server on first use (default: true) */
  scraplingAutoStart: boolean;
  /** Default proxy for Scrapling requests */
  scraplingProxy: string;
  /** List of proxies for rotation */
  scraplingProxies: string[];
  /** Whether onboarding has been completed */
  onboardingComplete: boolean;
  /** Whether the agent setup wizard has been completed (post-onboarding) */
  agentSetupComplete: boolean;
  /** Whether the first guided chat welcome has been triggered (prevents replay) */
  firstChatCompleted: boolean;
  /** Enable Cloudflare tunnel for public webhook URL (default: false) */
  tunnelEnabled: boolean;
  /** Skip cost confirmation dialogs for cloud media generation (default: false) */
  skipMediaCostConfirmation: boolean;
  /** Runtime tier: free (local only) or connected (cloud + integrations) */
  tier: RuntimeTier;
  /** Display-only: the workspace's plan name (set by cloud on connect). Not used for gating. */
  planName?: string;
  /** Device role: hybrid (all services), worker (task execution only), coordinator (orchestrator only) */
  deviceRole: DeviceRole;
  /** Workspace group for mesh isolation (only peers in the same group auto-pair) */
  workspaceGroup: string;
  /** Global MCP server defaults available to all agents */
  mcpServers: McpServerConfig[];
  /** Whether the MCP server for Claude Code is enabled */
  mcpServerEnabled: boolean;
  /** OpenClaw integration configuration */
  openclaw: import('./integrations/openclaw/types.js').OpenClawConfig;
  /** TurboQuant KV cache compression bits (2, 3, or 4). 0 = disabled. Default: 0 (auto-enabled when turbo-capable server detected). */
  turboQuantBits: 0 | 2 | 3 | 4;
  /** URL for llama-server with TurboQuant support (default: http://localhost:8085) */
  llamaCppUrl: string;
  /** Path to llama-server binary (empty = auto-detect in ~/.ohwow/bin/ or PATH) */
  llamaCppBinaryPath: string;
  /** Direct path to a .gguf model file for llama-server (empty = resolve from Ollama blobs) */
  llamaCppModelPath: string;
  /** Enable MLX-VLM inference on Apple Silicon (default: false, auto-enabled when hardware detected) */
  mlxEnabled: boolean;
  /** URL for mlx-vlm server (default: http://localhost:8090) */
  mlxServerUrl: string;
  /** MLX model ID from HuggingFace (e.g., 'mlx-community/gemma-4-e4b-it-4bit'). Empty = auto-resolve from ollamaModel. */
  mlxModel: string;
  /** Path to claude CLI binary for full-delegation execution (empty = auto-detect from PATH) */
  claudeCodeCliPath: string;
  /** Model override for Claude Code CLI executor (empty = Claude Code default) */
  claudeCodeCliModel: string;
  /** Max tool iterations for Claude Code CLI (default: 25) */
  claudeCodeCliMaxTurns: number;
  /** Permission mode for Claude Code CLI: skip (default), allowedTools, or interactive */
  claudeCodeCliPermissionMode: ClaudeCodeCliPermissionMode;
  /** Auto-detect and prefer Claude Code CLI for code-capable agents (default: true) */
  claudeCodeCliAutodetect: boolean;
  /** Embedding model for RAG vector search (default: nomic-embed-text). Empty string to disable. */
  embeddingModel: string;
  /** Weight for BM25 in hybrid search: 0.0 = pure embedding, 1.0 = pure BM25 (default: 0.5) */
  ragBm25Weight: number;
  /** Enable LLM-based reranking of RAG results (adds latency, default: false) */
  rerankerEnabled: boolean;
  /** Enable mesh-distributed RAG retrieval across peer devices (default: false) */
  meshRagEnabled: boolean;
  /** Base URL for OpenAI-compatible provider (e.g. http://localhost:8000). Empty to disable. */
  openaiCompatibleUrl: string;
  /** API key for OpenAI-compatible provider (optional) */
  openaiCompatibleApiKey: string;
  /** Enable LSP integration for code intelligence tools (default: true) */
  lspEnabled: boolean;
  /** Enable token preflight check before API calls (default: true) */
  tokenPreflightEnabled: boolean;
  /** Action when tokens exceed model capacity: 'trim' auto-compresses, 'reject' blocks (default: 'trim') */
  tokenPreflightAction: 'trim' | 'reject';
  /** Warn when token utilization exceeds this percentage (default: 90) */
  tokenPreflightWarnPct: number;
  /** Enable recovery audit logging to database (default: true) */
  recoveryAuditEnabled: boolean;
  /** Stale branch detection policy (default: 'warn') */
  staleBranchPolicy: 'off' | 'warn' | 'block' | 'auto-rebase' | 'auto-merge';
  /** Number of commits behind main before triggering stale branch detection (default: 5) */
  staleBranchThreshold: number;
  /**
   * Workspace-level kill switch for the orchestrator's desktop control tools.
   * Default `false` — desktop tools (request_desktop, desktop_screenshot,
   * desktop_focus_app, etc.) are NOT injected into the orchestrator's
   * tool surface unless the user message was explicitly classified as a
   * desktop intent. When `true`, the orchestrator can call request_desktop
   * on any turn the way the legacy default behaved. The agent runner gates
   * its existing per-agent `desktop_enabled` flag against this same setting,
   * so a workspace-wide `false` overrides any agent's opt-in.
   *
   * The reason this defaults off: a confused model can fall into a
   * desktop_screenshot loop and read window contents from unrelated apps,
   * leaking cross-workspace data into the response. Opt-in only.
   */
  desktopToolsEnabled: boolean;
  /**
   * Opt-in for the X intelligence scheduler. When true, the daemon
   * shells out to scripts/x-experiments/x-intel.mjs at the configured
   * cadence — harvesting the ohwow Chrome profile's home feed, searches,
   * and watched profiles; classifying into per-workspace buckets; and
   * uploading daily briefs to the workspace knowledge store (with
   * approval gating). Requires a per-workspace x-config.json at
   * ~/.ohwow/workspaces/<ws>/x-config.json and debug Chrome logged into
   * x.com on the configured chromeCdpPort. Default: false.
   */
  xIntelEnabled: boolean;
  /** Cadence for XIntelScheduler in minutes. Default: 180 (every 3h). */
  xIntelIntervalMinutes: number;
  /**
   * Opt-in for the X forecast scorer — daily companion to x-intel that
   * judges past predictions once their by_when date has passed and
   * writes calibrated-accuracy data the brief can surface. Read-only wrt
   * workspace knowledge; safe to enable by default. Default: true.
   */
  xForecastEnabled: boolean;
  /** Cadence for the forecast scorer in minutes. Default: 1440 (daily). */
  xForecastIntervalMinutes: number;
  /**
   * Enable the x-authors-to-crm pipeline step that chains after x-intel:
   * consumes the sidecar ledger, applies free-gates, classifies intent,
   * and proposes CRM contact creation for qualified authors. Scheduler
   * knob only — the actual free-gate thresholds and bucket allowlists
   * live in ~/.ohwow/workspaces/<ws>/lead-gen-config.json (not here).
   * Default: false.
   */
  xAuthorsToCrmEnabled: boolean;
  /**
   * Scheduler-level floor on the author's composite score. The workspace's
   * lead-gen-config.json is the real source of truth for free-gate
   * thresholds; this is a coarse kill-switch knob for emergencies.
   * Default: 0.6.
   */
  xAuthorsMinSignal: number;
  /** Scheduler-level bucket allowlist. Overridden by lead-gen-config.json. Default: ['market_signal','competitors']. */
  xAuthorsBuckets: string[];
  /**
   * Chain x-compose.mjs after a successful x-intel run — drafts
   * original posts (tactical_tip / observation / opinion / question /
   * story / humor shapes) from the fresh x-intel-history patterns.
   * DRY-only: nothing is posted automatically. Default: false.
   */
  xComposeEnabled: boolean;
  /**
   * Chain x-reply.mjs after a successful x-intel run — drafts replies
   * to strategic posts from the fresh x-posts sidecar. DRY-only.
   * Default: false.
   */
  xReplyEnabled: boolean;
  /**
   * Run x-compose with SHAPES=humor on its own cadence. Independent of
   * x-intel — humor draws from x-intel-history, which persists across
   * ticks. Default: false.
   */
  xHumorEnabled: boolean;
  /** Cadence for the humor scheduler in minutes. Default: 60 (hourly). */
  xHumorIntervalMinutes: number;
}

interface ConfigFile {
  licenseKey?: string;
  cloudUrl?: string;
  anthropicApiKey?: string;
  modelSource?: ModelSource;
  cloudProvider?: CloudProvider;
  cloudModel?: string;
  anthropicOAuthToken?: string;
  port?: number;
  dbPath?: string;
  jwtSecret?: string;
  localUrl?: string;
  browserHeadless?: boolean;
  browserTarget?: 'chromium' | 'chrome';
  chromeCdpPort?: number;
  chromeProfileAliases?: Record<string, string>;
  chromeDefaultProfile?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  preferLocalModel?: boolean;
  orchestratorModel?: string;
  quickModel?: string;
  ocrModel?: string;
  openRouterApiKey?: string;
  openRouterModel?: string;
  falKey?: string;
  falVideoModel?: string;
  scraplingPort?: number;
  scraplingAutoStart?: boolean;
  scraplingProxy?: string;
  scraplingProxies?: string[];
  onboardingComplete?: boolean;
  agentSetupComplete?: boolean;
  firstChatCompleted?: boolean;
  tunnelEnabled?: boolean;
  skipMediaCostConfirmation?: boolean;
  pendingAgentSetup?: {
    businessType: string;
    agent: {
      name: string;
      role: string;
      systemPrompt: string;
      tools: string[];
    };
  } | null;
  tier?: RuntimeTier | 'starter' | 'pro' | 'enterprise';
  deviceRole?: DeviceRole;
  workspaceGroup?: string;
  mcpServers?: McpServerConfig[];
  mcpServerEnabled?: boolean;
  xIntelEnabled?: boolean;
  xIntelIntervalMinutes?: number;
  xForecastEnabled?: boolean;
  xForecastIntervalMinutes?: number;
  xAuthorsToCrmEnabled?: boolean;
  xAuthorsMinSignal?: number;
  xAuthorsBuckets?: string[];
  xComposeEnabled?: boolean;
  xReplyEnabled?: boolean;
  xHumorEnabled?: boolean;
  xHumorIntervalMinutes?: number;
  openclaw?: Partial<import('./integrations/openclaw/types.js').OpenClawConfig>;
  turboQuantBits?: 0 | 2 | 3 | 4;
  llamaCppUrl?: string;
  llamaCppBinaryPath?: string;
  llamaCppModelPath?: string;
  mlxEnabled?: boolean;
  mlxServerUrl?: string;
  mlxModel?: string;
  claudeCodeCliPath?: string;
  claudeCodeCliModel?: string;
  claudeCodeCliMaxTurns?: number;
  claudeCodeCliPermissionMode?: ClaudeCodeCliPermissionMode;
  claudeCodeCliAutodetect?: boolean;
  embeddingModel?: string;
  ragBm25Weight?: number;
  rerankerEnabled?: boolean;
  meshRagEnabled?: boolean;
  openaiCompatibleUrl?: string;
  openaiCompatibleApiKey?: string;
  lspEnabled?: boolean;
  tokenPreflightEnabled?: boolean;
  tokenPreflightAction?: 'trim' | 'reject';
  tokenPreflightWarnPct?: number;
  recoveryAuditEnabled?: boolean;
  staleBranchPolicy?: 'off' | 'warn' | 'block' | 'auto-rebase' | 'auto-merge';
  staleBranchThreshold?: number;
  desktopToolsEnabled?: boolean;
}

export const DEFAULT_CONFIG_DIR = join(homedir(), '.ohwow');
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.json');
export const DEFAULT_DB_PATH = join(DEFAULT_CONFIG_DIR, 'data', 'runtime.db');
export const DEFAULT_PORT = 7700;
export const DEFAULT_CLOUD_URL = 'https://ohwow.fun';

// ---------------------------------------------------------------------------
// Workspaces
//
// One daemon at a time, but data is sharded into per-workspace directories so
// you can keep the ohwow.fun GTM brain isolated from (e.g.) an AvenueD ops
// brain. The active workspace is resolved with this precedence:
//
//   1. OHWOW_WORKSPACE env var (set by --workspace=<name> CLI flag too)
//   2. ~/.ohwow/current-workspace pointer file (written by `ohwow workspace use`)
//   3. The literal name 'default'
//
// On legacy installs (~/.ohwow/data/runtime.db with no ~/.ohwow/workspaces),
// the resolver returns the legacy paths so subcommands keep working against
// pre-migration daemons. The daemon then migrates the legacy directory into
// ~/.ohwow/workspaces/default the next time it starts cleanly.
// ---------------------------------------------------------------------------

export const DEFAULT_WORKSPACE = 'default';
export const WORKSPACES_DIR = join(DEFAULT_CONFIG_DIR, 'workspaces');
export const WORKSPACE_POINTER_FILE = join(DEFAULT_CONFIG_DIR, 'current-workspace');
export const LEGACY_DATA_DIR = join(DEFAULT_CONFIG_DIR, 'data');

export interface WorkspaceLayout {
  /** Workspace short name (slug) */
  name: string;
  /** Absolute path to the workspace's data directory */
  dataDir: string;
  /** Absolute path to runtime.db inside dataDir */
  dbPath: string;
  /**
   * Directory holding synthesized code-skill source files (`*.ts`).
   * The runtime skill loader watches this path for changes and
   * hot-loads any file that matches an active agent_workforce_skills
   * row with skill_type='code'.
   */
  skillsDir: string;
  /**
   * Where the runtime writes esbuild-compiled `.js` output for code
   * skills. Kept separate from the source dir so file watchers only
   * trigger on human- or LLM-authored source changes, not compiler
   * output, and so nuking the cache is a single `rm -rf`.
   */
  compiledSkillsDir: string;
}

/** Workspace names must be filesystem-safe (no slashes, no leading dot). */
export function isValidWorkspaceName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

/** Compute the on-disk layout for a workspace by name (does not create dirs). */
export function workspaceLayoutFor(name: string): WorkspaceLayout {
  const dataDir = join(WORKSPACES_DIR, name);
  const skillsDir = join(dataDir, 'skills');
  return {
    name,
    dataDir,
    dbPath: join(dataDir, 'runtime.db'),
    skillsDir,
    compiledSkillsDir: join(skillsDir, '.compiled'),
  };
}

/** Read the active workspace pointer file, or null if missing/empty. */
export function readWorkspacePointer(): string | null {
  if (!existsSync(WORKSPACE_POINTER_FILE)) return null;
  try {
    const value = readFileSync(WORKSPACE_POINTER_FILE, 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Write the active workspace pointer file. Creates ~/.ohwow if needed. */
export function writeWorkspacePointer(name: string): void {
  if (!existsSync(DEFAULT_CONFIG_DIR)) {
    mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(WORKSPACE_POINTER_FILE, name);
}

/** List workspace directories under ~/.ohwow/workspaces (sorted, may be empty). */
export function listWorkspaces(): string[] {
  if (!existsSync(WORKSPACES_DIR)) return [];
  try {
    return readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the active workspace layout. See the section comment above for
 * precedence rules. When the resolver falls back to the literal 'default'
 * name and no workspaces dir exists yet, it checks for a legacy
 * ~/.ohwow/data/runtime.db and returns those paths so we don't strand
 * pre-migration installs.
 */
export function resolveActiveWorkspace(): WorkspaceLayout {
  const fromEnv = process.env.OHWOW_WORKSPACE?.trim();
  if (fromEnv && isValidWorkspaceName(fromEnv)) {
    return workspaceLayoutFor(fromEnv);
  }

  const fromPointer = readWorkspacePointer();
  if (fromPointer && isValidWorkspaceName(fromPointer)) {
    return workspaceLayoutFor(fromPointer);
  }

  const defaultLayout = workspaceLayoutFor(DEFAULT_WORKSPACE);
  // Legacy fallback: if the new layout has no default workspace yet but the
  // old single-workspace install exists, point at it. The daemon will migrate
  // it the next time it boots cleanly.
  if (!existsSync(defaultLayout.dataDir) && existsSync(join(LEGACY_DATA_DIR, 'runtime.db'))) {
    const legacySkillsDir = join(LEGACY_DATA_DIR, 'skills');
    return {
      name: DEFAULT_WORKSPACE,
      dataDir: LEGACY_DATA_DIR,
      dbPath: join(LEGACY_DATA_DIR, 'runtime.db'),
      skillsDir: legacySkillsDir,
      compiledSkillsDir: join(legacySkillsDir, '.compiled'),
    };
  }
  return defaultLayout;
}

// ---------------------------------------------------------------------------
// Per-workspace config (workspace.json)
//
// Each non-default workspace can carry a workspace.json with overrides on top
// of the global config. The absence of workspace.json is the "legacy default"
// signal — those workspaces read global config.json unchanged, preserving the
// pre-multi-workspace behavior.
//
// Mode semantics:
//   - 'local-only': blanks licenseKey + forces tier='free'. Control plane is
//     never instantiated; the workspace is a fully disconnected sandbox.
//   - 'cloud':      uses workspace-specific licenseKey + forces tier='connected'.
//     The daemon connects to whichever cloud workspace that license maps to.
//
// See docs/multi-workspace-plan.md for the full design.
// ---------------------------------------------------------------------------

export type WorkspaceMode = 'local-only' | 'cloud';

export interface WorkspaceConfig {
  schemaVersion: 1;
  mode: WorkspaceMode;
  /** Required when mode='cloud'. Blank otherwise. */
  licenseKey?: string;
  /** Persisted after the first successful ControlPlaneClient.connect(). */
  cloudWorkspaceId?: string;
  /** Persisted alongside cloudWorkspaceId. */
  cloudDeviceId?: string;
  /** ISO timestamp of the last successful connect. */
  lastConnectAt?: string;
  /** Human label, shown in `workspace list`/`workspace info`. */
  displayName?: string;
  /**
   * The HTTP port this workspace's daemon binds to. Auto-allocated by
   * `workspace start` on first run (default keeps 7700 from global config;
   * subsequent workspaces get 7701, 7702, …). Persisted so the same
   * workspace always uses the same port across daemon restarts.
   */
  port?: number;
  /**
   * Forward-compat slot for multi-workspace-per-license cloud feature.
   * When set, forwarded as ConnectRequest.requestedWorkspaceId. Safe to
   * include today — cloud backends that don't know about it ignore it.
   */
  requestedCloudWorkspaceId?: string;
  /**
   * Per-workspace override for the desktop tools kill switch. When set,
   * overrides the global config's desktopToolsEnabled. Default behavior
   * (omitted): inherit the global setting, which itself defaults to false.
   * See RuntimeConfig.desktopToolsEnabled for the security rationale.
   */
  desktopToolsEnabled?: boolean;
  /** Per-workspace override: enable the X intelligence scheduler. */
  xIntelEnabled?: boolean;
  /** Per-workspace override: cadence in minutes for the X intelligence scheduler. */
  xIntelIntervalMinutes?: number;
  /** Per-workspace override: enable the X forecast scorer. */
  xForecastEnabled?: boolean;
  /** Per-workspace override: cadence in minutes for the X forecast scorer. */
  xForecastIntervalMinutes?: number;
  /** Per-workspace override: enable the x-authors-to-crm pipeline step chained after x-intel. */
  xAuthorsToCrmEnabled?: boolean;
  /** Per-workspace override: scheduler-level minimum composite score. */
  xAuthorsMinSignal?: number;
  /** Per-workspace override: scheduler-level bucket allowlist. */
  xAuthorsBuckets?: string[];
  xComposeEnabled?: boolean;
  xReplyEnabled?: boolean;
  xHumorEnabled?: boolean;
  xHumorIntervalMinutes?: number;
  /**
   * Absolute path of the git repository this workspace's self-bench loop
   * operates on. Overrides the cwd-derived default (which assumes the
   * daemon binary lives under the repo). Required when a single daemon
   * binary serves multiple workspaces that each target a different repo
   * — e.g. default=/Users/jesus/Documents/ohwow/ohwow,
   * avenued=/Users/jesus/Documents/ohwow/ohwow.fun. When absent, the
   * daemon falls back to the cwd-derived behaviour so existing
   * single-repo workspaces keep working unchanged.
   */
  repoRoot?: string;
}

export function workspaceConfigPath(name: string): string {
  return join(WORKSPACES_DIR, name, 'workspace.json');
}

/**
 * Read a workspace's config file. Returns null if missing or unreadable.
 * Malformed files are logged but treated as missing to avoid hard-failing
 * subcommands like `workspace list`.
 */
export function readWorkspaceConfig(name: string): WorkspaceConfig | null {
  const path = workspaceConfigPath(name);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as WorkspaceConfig;
  } catch (err) {
    logger.warn(`[Config] Failed to parse ${path}: ${err}`);
    return null;
  }
}

/**
 * Write a workspace's config file, creating the workspace dir if needed.
 * Always round-trips schemaVersion=1 even if the caller forgot to set it.
 */
export function writeWorkspaceConfig(name: string, cfg: WorkspaceConfig): void {
  const layout = workspaceLayoutFor(name);
  if (!existsSync(layout.dataDir)) {
    mkdirSync(layout.dataDir, { recursive: true });
  }
  const normalized: WorkspaceConfig = { ...cfg, schemaVersion: 1 };
  writeFileSync(workspaceConfigPath(name), JSON.stringify(normalized, null, 2));
}

/**
 * Find the local workspace (if any) that uses a given license key. Scans every
 * workspace.json under ~/.ohwow/workspaces AND the global config.json (which
 * acts as the default workspace's implicit config). Returns null when nothing
 * matches. Used for mirror detection in `workspace create --license-key=...`.
 */
export function findWorkspaceByLicenseKey(licenseKey: string): string | null {
  if (!licenseKey) return null;
  // Check per-workspace configs first.
  for (const name of listWorkspaces()) {
    const cfg = readWorkspaceConfig(name);
    if (cfg?.mode === 'cloud' && cfg.licenseKey === licenseKey) {
      return name;
    }
  }
  // Check global config.json (default workspace). Only matches when the
  // default workspace has NOT been explicitly given a workspace.json override.
  const defaultCfg = readWorkspaceConfig(DEFAULT_WORKSPACE);
  if (defaultCfg === null && existsSync(DEFAULT_CONFIG_PATH)) {
    try {
      const raw = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as { licenseKey?: string };
      if (parsed.licenseKey === licenseKey) return DEFAULT_WORKSPACE;
    } catch {
      // malformed — treat as no match
    }
  }
  return null;
}

/**
 * Find the local workspace (if any) that has persisted a given cloud workspace
 * ID. Only scans per-workspace configs (global config.json doesn't track the
 * cloud workspace id — that's resolved on every connect for the default
 * workspace). Used for the cross-workspace conflict check at daemon boot.
 */
export function findWorkspaceByCloudId(cloudWorkspaceId: string): string | null {
  if (!cloudWorkspaceId) return null;
  for (const name of listWorkspaces()) {
    const cfg = readWorkspaceConfig(name);
    if (cfg?.mode === 'cloud' && cfg.cloudWorkspaceId === cloudWorkspaceId) {
      return name;
    }
  }
  return null;
}

/**
 * Apply a workspace.json's mode-based overrides on top of the global
 * fileConfig. Pure function — returns a new ConfigFile, never mutates.
 *
 *  - local-only: blanks licenseKey + forces tier='free' so the control plane
 *    is never instantiated. The global license (if any) is ignored for this
 *    workspace.
 *  - cloud:      substitutes the workspace-specific licenseKey (not global)
 *    and forces tier='connected'. The cloud resolves the actual plan tier.
 *
 * Missing or malformed workspace.json → fileConfig returned unchanged.
 */
function applyWorkspaceOverrides(fileConfig: ConfigFile, ws: WorkspaceConfig | null): ConfigFile {
  if (!ws) return fileConfig;
  const next: ConfigFile = { ...fileConfig };
  if (ws.mode === 'local-only') {
    next.licenseKey = '';
    next.tier = 'free';
  } else if (ws.mode === 'cloud') {
    next.licenseKey = ws.licenseKey ?? '';
    next.tier = 'connected';
  }
  // Per-workspace port overrides global config.json port. Critical for
  // running multiple workspaces in parallel — each daemon binds to its own
  // port so they don't fight for 7700.
  if (typeof ws.port === 'number' && ws.port > 0) {
    next.port = ws.port;
  }
  // Per-workspace desktop kill switch overrides the global setting. Lets
  // an operator opt one workspace into desktop control without enabling
  // it globally, or vice-versa.
  if (typeof ws.desktopToolsEnabled === 'boolean') {
    next.desktopToolsEnabled = ws.desktopToolsEnabled;
  }
  // Per-workspace X intelligence scheduler overrides. Each workspace can
  // opt in independently — e.g. enable intel on your GTM workspace while
  // keeping it off on an ops workspace. Interval defaults to 180min via
  // loadConfig when the override is omitted.
  if (typeof ws.xIntelEnabled === 'boolean') {
    next.xIntelEnabled = ws.xIntelEnabled;
  }
  if (typeof ws.xIntelIntervalMinutes === 'number' && ws.xIntelIntervalMinutes > 0) {
    next.xIntelIntervalMinutes = ws.xIntelIntervalMinutes;
  }
  if (typeof ws.xForecastEnabled === 'boolean') {
    next.xForecastEnabled = ws.xForecastEnabled;
  }
  if (typeof ws.xForecastIntervalMinutes === 'number' && ws.xForecastIntervalMinutes > 0) {
    next.xForecastIntervalMinutes = ws.xForecastIntervalMinutes;
  }
  if (typeof ws.xAuthorsToCrmEnabled === 'boolean') {
    next.xAuthorsToCrmEnabled = ws.xAuthorsToCrmEnabled;
  }
  if (typeof ws.xAuthorsMinSignal === 'number' && ws.xAuthorsMinSignal >= 0 && ws.xAuthorsMinSignal <= 1) {
    next.xAuthorsMinSignal = ws.xAuthorsMinSignal;
  }
  if (Array.isArray(ws.xAuthorsBuckets)) {
    next.xAuthorsBuckets = ws.xAuthorsBuckets.filter((b) => typeof b === 'string');
  }
  if (typeof ws.xComposeEnabled === 'boolean') next.xComposeEnabled = ws.xComposeEnabled;
  if (typeof ws.xReplyEnabled === 'boolean') next.xReplyEnabled = ws.xReplyEnabled;
  if (typeof ws.xHumorEnabled === 'boolean') next.xHumorEnabled = ws.xHumorEnabled;
  if (typeof ws.xHumorIntervalMinutes === 'number' && ws.xHumorIntervalMinutes > 0) {
    next.xHumorIntervalMinutes = ws.xHumorIntervalMinutes;
  }
  return next;
}

/**
 * Resolve the HTTP port a given workspace's daemon should bind to.
 *
 *   - The default workspace inherits the global config.json port (7700 by
 *     default), preserving pre-multi-workspace behavior for users who never
 *     created a second workspace.
 *   - Non-default workspaces use whatever port is persisted in their
 *     workspace.json. If they don't have one yet, the caller should
 *     allocate one with allocateWorkspacePort and persist it via
 *     writeWorkspaceConfig before starting the daemon.
 */
export function portForWorkspace(name: string): number | null {
  if (name === DEFAULT_WORKSPACE) {
    try {
      const raw = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as { port?: number };
      return parsed.port ?? DEFAULT_PORT;
    } catch {
      return DEFAULT_PORT;
    }
  }
  const cfg = readWorkspaceConfig(name);
  return cfg?.port ?? null;
}

/**
 * URL the local web dashboard is reachable at for a given workspace.
 * Returns null if the workspace has never been assigned a port (i.e.
 * was created --local-only before a daemon first ran). Self-bench
 * experiments that drive Playwright against the dashboard use this
 * so they never hardcode :7700.
 */
export function dashboardUrlForWorkspace(name: string): string | null {
  const port = portForWorkspace(name);
  if (port === null) return null;
  return `http://localhost:${port}`;
}

/**
 * Pick a free port for a brand-new workspace daemon. Walks 7701..8700,
 * skipping any port already assigned to another local workspace (whether
 * the corresponding daemon is currently running or not — port assignments
 * are sticky so the same workspace keeps the same port).
 *
 * Throws if no port in that range is free, which would only happen with
 * 1000+ workspaces (unrealistic).
 */
export function allocateWorkspacePort(): number {
  const used = new Set<number>();
  // Default workspace permanently holds whatever the global config says.
  used.add(portForWorkspace(DEFAULT_WORKSPACE) ?? DEFAULT_PORT);
  // Plus every other workspace that's already been assigned a port.
  for (const name of listWorkspaces()) {
    if (name === DEFAULT_WORKSPACE) continue;
    const p = portForWorkspace(name);
    if (p !== null) used.add(p);
  }
  for (let p = DEFAULT_PORT + 1; p < DEFAULT_PORT + 1000; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(`No free workspace port in range ${DEFAULT_PORT + 1}-${DEFAULT_PORT + 999}`);
}

/**
 * Load runtime config from file + env vars (env vars override file values).
 * Free tier: no license key or API key required.
 * Connected tier: requires license key.
 */
export function loadConfig(configPath?: string): RuntimeConfig {
  const path = configPath || DEFAULT_CONFIG_PATH;
  let fileConfig: ConfigFile = {};

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      fileConfig = JSON.parse(raw) as ConfigFile;
    } catch (err) {
      logger.warn(`[Config] Failed to parse ${path}: ${err}`);
    }
  }

  // Apply per-workspace overrides from ~/.ohwow/workspaces/<name>/workspace.json
  // if present. The default workspace has no workspace.json and passes through
  // unchanged, preserving the pre-multi-workspace behavior.
  const activeWs = resolveActiveWorkspace();
  const wsConfig = readWorkspaceConfig(activeWs.name);
  fileConfig = applyWorkspaceOverrides(fileConfig, wsConfig);

  // Determine tier: connected if license key exists, otherwise free.
  // All plan-specific enforcement happens on the cloud side.
  const licenseKey = process.env.OHWOW_LICENSE_KEY || fileConfig.licenseKey || '';
  const tier: RuntimeTier = (() => {
    const raw = fileConfig.tier || (licenseKey ? 'connected' : 'free');
    // Backward compat: map any paid tier name to 'connected'
    if (['connected', 'starter', 'pro', 'enterprise'].includes(raw as string)) return 'connected';
    if (raw === 'free') return 'free';
    return licenseKey ? 'connected' : 'free';
  })();

  const config: RuntimeConfig = {
    licenseKey,
    cloudUrl: process.env.OHWOW_CLOUD_URL || fileConfig.cloudUrl || DEFAULT_CLOUD_URL,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || fileConfig.anthropicApiKey || '',
    modelSource: (process.env.OHWOW_MODEL_SOURCE as ModelSource) || fileConfig.modelSource || 'local',
    cloudProvider: (process.env.OHWOW_CLOUD_PROVIDER as CloudProvider) || fileConfig.cloudProvider || 'anthropic',
    cloudModel: process.env.OHWOW_CLOUD_MODEL || fileConfig.cloudModel || 'claude-haiku-4-5-20251001',
    anthropicOAuthToken: process.env.ANTHROPIC_OAUTH_TOKEN || fileConfig.anthropicOAuthToken || '',
    port: parseInt(process.env.OHWOW_PORT || '', 10) || fileConfig.port || DEFAULT_PORT,
    // dbPath: explicit OHWOW_DB_PATH wins (test/migration escape hatch),
    // then a per-install override in config.json, then the active workspace.
    // A pinned fileConfig.dbPath is ignored when its parent directory no
    // longer exists — this happens after the legacy data dir migration if
    // the pre-workspace install had a hardcoded dbPath, and we don't want to
    // silently create a fresh DB at the dead path.
    dbPath:
      process.env.OHWOW_DB_PATH ||
      (fileConfig.dbPath && existsSync(dirname(fileConfig.dbPath))
        ? fileConfig.dbPath
        : resolveActiveWorkspace().dbPath),
    jwtSecret: process.env.ENTERPRISE_JWT_SECRET || fileConfig.jwtSecret || '',
    localUrl: process.env.OHWOW_LOCAL_URL || fileConfig.localUrl || `http://localhost:${fileConfig.port || DEFAULT_PORT}`,
    browserHeadless: process.env.OHWOW_BROWSER_HEADLESS === 'true' ? true : (fileConfig.browserHeadless === true),
    browserTarget: (process.env.OHWOW_BROWSER_TARGET as 'chromium' | 'chrome') || fileConfig.browserTarget || 'chrome',
    chromeCdpPort: parseInt(process.env.OHWOW_CHROME_CDP_PORT || '', 10) || fileConfig.chromeCdpPort || 9222,
    chromeProfileAliases: fileConfig.chromeProfileAliases || {},
    chromeDefaultProfile: process.env.OHWOW_CHROME_PROFILE || fileConfig.chromeDefaultProfile || 'Default',
    ollamaUrl: process.env.OHWOW_OLLAMA_URL || fileConfig.ollamaUrl || 'http://localhost:11434',
    ollamaModel: process.env.OHWOW_OLLAMA_MODEL || fileConfig.ollamaModel || 'qwen3:4b',
    preferLocalModel: process.env.OHWOW_PREFER_LOCAL === 'true' || fileConfig.preferLocalModel === true,
    orchestratorModel: process.env.OHWOW_ORCHESTRATOR_MODEL || fileConfig.orchestratorModel || '',
    quickModel: process.env.OHWOW_QUICK_MODEL || fileConfig.quickModel || '',
    ocrModel: process.env.OHWOW_OCR_MODEL || fileConfig.ocrModel || '',
    openRouterApiKey: process.env.OPENROUTER_API_KEY || fileConfig.openRouterApiKey || '',
    openRouterModel: process.env.OPENROUTER_MODEL || fileConfig.openRouterModel || 'deepseek/deepseek-v3.2',
    falKey: process.env.FAL_KEY || fileConfig.falKey || '',
    falVideoModel: process.env.FAL_VIDEO_MODEL || fileConfig.falVideoModel || 'fal-ai/luma-dream-machine',
    scraplingPort: parseInt(process.env.OHWOW_SCRAPLING_PORT || '', 10) || fileConfig.scraplingPort || 8100,
    scraplingAutoStart: process.env.OHWOW_SCRAPLING_AUTO_START === 'false' ? false : (fileConfig.scraplingAutoStart !== false),
    scraplingProxy: process.env.OHWOW_SCRAPLING_PROXY || fileConfig.scraplingProxy || '',
    scraplingProxies: fileConfig.scraplingProxies || [],
    onboardingComplete: fileConfig.onboardingComplete ?? false,
    agentSetupComplete: fileConfig.agentSetupComplete ?? true,
    firstChatCompleted: fileConfig.firstChatCompleted ?? false,
    tunnelEnabled: process.env.OHWOW_TUNNEL_ENABLED === 'true' || fileConfig.tunnelEnabled === true,
    skipMediaCostConfirmation: fileConfig.skipMediaCostConfirmation ?? false,
    tier,
    deviceRole: (process.env.OHWOW_DEVICE_ROLE as DeviceRole) || fileConfig.deviceRole || 'hybrid',
    workspaceGroup: process.env.OHWOW_WORKSPACE_GROUP || fileConfig.workspaceGroup || 'default',
    mcpServers: fileConfig.mcpServers ?? [],
    mcpServerEnabled: fileConfig.mcpServerEnabled ?? false,
    xIntelEnabled: process.env.OHWOW_X_INTEL_ENABLED === 'true' || fileConfig.xIntelEnabled === true,
    xIntelIntervalMinutes: parseInt(process.env.OHWOW_X_INTEL_INTERVAL_MIN || '', 10) || fileConfig.xIntelIntervalMinutes || 180,
    xForecastEnabled:
      process.env.OHWOW_X_FORECAST_ENABLED === 'false'
        ? false
        : process.env.OHWOW_X_FORECAST_ENABLED === 'true'
          ? true
          : fileConfig.xForecastEnabled ?? true,
    xForecastIntervalMinutes:
      parseInt(process.env.OHWOW_X_FORECAST_INTERVAL_MIN || '', 10) || fileConfig.xForecastIntervalMinutes || 1440,
    // Scheduler-level knobs for the x-authors-to-crm chain step. These
    // are coarse kill-switches; the actual free-gate rubric lives in
    // ~/.ohwow/workspaces/<ws>/lead-gen-config.json (per-workspace, never
    // committed). Treat these as emergency levers, not tuning surface.
    xAuthorsToCrmEnabled: process.env.OHWOW_X_AUTHORS_TO_CRM_ENABLED === 'true' || fileConfig.xAuthorsToCrmEnabled === true,
    xAuthorsMinSignal: (() => {
      const env = parseFloat(process.env.OHWOW_X_AUTHORS_MIN_SIGNAL || '');
      if (Number.isFinite(env) && env >= 0 && env <= 1) return env;
      const fc = fileConfig.xAuthorsMinSignal;
      if (typeof fc === 'number' && fc >= 0 && fc <= 1) return fc;
      return 0.6;
    })(),
    xAuthorsBuckets: Array.isArray(fileConfig.xAuthorsBuckets) && fileConfig.xAuthorsBuckets.length > 0
      ? fileConfig.xAuthorsBuckets
      : ['market_signal', 'competitors'],
    xComposeEnabled: process.env.OHWOW_X_COMPOSE_ENABLED === 'true' || fileConfig.xComposeEnabled === true,
    xReplyEnabled: process.env.OHWOW_X_REPLY_ENABLED === 'true' || fileConfig.xReplyEnabled === true,
    xHumorEnabled: process.env.OHWOW_X_HUMOR_ENABLED === 'true' || fileConfig.xHumorEnabled === true,
    xHumorIntervalMinutes: parseInt(process.env.OHWOW_X_HUMOR_INTERVAL_MIN || '', 10) || fileConfig.xHumorIntervalMinutes || 60,
    openclaw: {
      enabled: fileConfig.openclaw?.enabled ?? false,
      binaryPath: fileConfig.openclaw?.binaryPath ?? '',
      allowlistedSkills: fileConfig.openclaw?.allowlistedSkills ?? [],
      rateLimitPerMinute: fileConfig.openclaw?.rateLimitPerMinute ?? 10,
      rateLimitPerHour: fileConfig.openclaw?.rateLimitPerHour ?? 100,
      sandboxAllowNetwork: fileConfig.openclaw?.sandboxAllowNetwork ?? false,
      maxExecutionTimeMs: fileConfig.openclaw?.maxExecutionTimeMs ?? 30_000,
    },
    turboQuantBits: (() => {
      const env = parseInt(process.env.OHWOW_TURBOQUANT_BITS || '', 10);
      const val = [2, 3, 4].includes(env) ? env : (fileConfig.turboQuantBits ?? 0);
      return val as 0 | 2 | 3 | 4;
    })(),
    llamaCppUrl: process.env.OHWOW_LLAMA_CPP_URL || fileConfig.llamaCppUrl || 'http://localhost:8085',
    llamaCppBinaryPath: process.env.OHWOW_LLAMA_CPP_BINARY || fileConfig.llamaCppBinaryPath || '',
    llamaCppModelPath: process.env.OHWOW_LLAMA_CPP_MODEL || fileConfig.llamaCppModelPath || '',
    mlxEnabled: process.env.OHWOW_MLX_ENABLED === 'true' || fileConfig.mlxEnabled === true,
    mlxServerUrl: process.env.OHWOW_MLX_SERVER_URL || fileConfig.mlxServerUrl || 'http://localhost:8090',
    mlxModel: process.env.OHWOW_MLX_MODEL || fileConfig.mlxModel || '',
    claudeCodeCliPath: process.env.OHWOW_CLAUDE_CODE_CLI_PATH || fileConfig.claudeCodeCliPath || '',
    claudeCodeCliModel: process.env.OHWOW_CLAUDE_CODE_CLI_MODEL || fileConfig.claudeCodeCliModel || '',
    claudeCodeCliMaxTurns: parseInt(process.env.OHWOW_CLAUDE_CODE_CLI_MAX_TURNS || '', 10) || fileConfig.claudeCodeCliMaxTurns || 25,
    claudeCodeCliPermissionMode: (process.env.OHWOW_CLAUDE_CODE_CLI_PERMISSION_MODE as ClaudeCodeCliPermissionMode) || fileConfig.claudeCodeCliPermissionMode || 'skip',
    claudeCodeCliAutodetect: process.env.OHWOW_CLAUDE_CODE_CLI_AUTODETECT === 'false' ? false : (fileConfig.claudeCodeCliAutodetect !== false),
    embeddingModel: process.env.OHWOW_EMBEDDING_MODEL ?? fileConfig.embeddingModel ?? 'nomic-embed-text',
    ragBm25Weight: (() => {
      const env = parseFloat(process.env.OHWOW_RAG_BM25_WEIGHT || '');
      return !isNaN(env) ? env : (fileConfig.ragBm25Weight ?? 0.5);
    })(),
    rerankerEnabled: process.env.OHWOW_RERANKER_ENABLED === 'true' || (fileConfig.rerankerEnabled ?? false),
    meshRagEnabled: process.env.OHWOW_MESH_RAG_ENABLED === 'true' || (fileConfig.meshRagEnabled ?? false),
    openaiCompatibleUrl: process.env.OHWOW_OPENAI_COMPATIBLE_URL ?? fileConfig.openaiCompatibleUrl ?? '',
    openaiCompatibleApiKey: process.env.OHWOW_OPENAI_COMPATIBLE_API_KEY ?? fileConfig.openaiCompatibleApiKey ?? '',
    lspEnabled: process.env.OHWOW_LSP_ENABLED === 'false' ? false : (fileConfig.lspEnabled !== false),
    tokenPreflightEnabled: process.env.OHWOW_TOKEN_PREFLIGHT_ENABLED === 'false' ? false : (fileConfig.tokenPreflightEnabled !== false),
    tokenPreflightAction: (process.env.OHWOW_TOKEN_PREFLIGHT_ACTION as 'trim' | 'reject') || fileConfig.tokenPreflightAction || 'trim',
    tokenPreflightWarnPct: (() => {
      const env = parseInt(process.env.OHWOW_TOKEN_PREFLIGHT_WARN_PCT || '', 10);
      return !isNaN(env) ? env : (fileConfig.tokenPreflightWarnPct ?? 90);
    })(),
    recoveryAuditEnabled: process.env.OHWOW_RECOVERY_AUDIT_ENABLED === 'false' ? false : (fileConfig.recoveryAuditEnabled !== false),
    staleBranchPolicy: (process.env.OHWOW_STALE_BRANCH_POLICY as RuntimeConfig['staleBranchPolicy']) || fileConfig.staleBranchPolicy || 'warn',
    staleBranchThreshold: (() => {
      const env = parseInt(process.env.OHWOW_STALE_BRANCH_THRESHOLD || '', 10);
      return !isNaN(env) ? env : (fileConfig.staleBranchThreshold ?? 5);
    })(),
    desktopToolsEnabled: process.env.OHWOW_DESKTOP_TOOLS_ENABLED === 'true' || fileConfig.desktopToolsEnabled === true,
  };


  // Connected tier validates required fields
  if (tier !== 'free') {
    if (!config.licenseKey) {
      throw new Error('Missing license key. Set OHWOW_LICENSE_KEY or add licenseKey to ~/.ohwow/config.json');
    }
  }

  return config;
}

/**
 * Try to load config — returns null instead of throwing when config is missing/incomplete.
 * Used by the setup wizard to detect first-run state.
 */
export function tryLoadConfig(configPath?: string): RuntimeConfig | null {
  try {
    return loadConfig(configPath);
  } catch {
    return null;
  }
}

/**
 * Read ~/.ohwow/config.json, merge updates, and write it back.
 * Creates the file if it doesn't exist.
 */
export function updateConfigFile(updates: Partial<ConfigFile>, configPath?: string): void {
  const path = configPath || DEFAULT_CONFIG_PATH;
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // Corrupted file — overwrite
    }
  }
  const merged = { ...existing, ...updates };
  writeFileSync(path, JSON.stringify(merged, null, 2));
}

/** Check if this is a first run (no config file or onboarding not complete). */
export function isFirstRun(configPath?: string): boolean {
  const path = configPath || DEFAULT_CONFIG_PATH;
  if (!existsSync(path)) return true;
  try {
    const raw = readFileSync(path, 'utf-8');
    const fileConfig = JSON.parse(raw) as ConfigFile;
    return !fileConfig.onboardingComplete;
  } catch {
    return true;
  }
}
