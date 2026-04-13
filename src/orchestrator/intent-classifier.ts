/**
 * Intent classification for the local orchestrator.
 * Uses weighted keyword scoring — all intents are scored in parallel,
 * the highest score wins. Ties break by priority order.
 *
 * Pure function — no class or DB dependency.
 */

import type { ClassifiedIntent, OrchestratorMode } from './orchestrator-types.js';
import type { IntentSection } from './tool-definitions.js';

export const CONFIRMATION_PATTERN = /^(yes|yeah|yep|yup|sure|ok|okay|proceed|go ahead|do it|go for it|let'?s go|let'?s do it|sounds good|confirmed?|absolutely|please|please do|that works|perfect|exactly|correct)\s*[.!]?$/i;

/** Detect complex multi-step requests that benefit from planning before execution. */
const COMPLEX_PATTERN = /\b(set up|build|create.*(?:pipeline|workflow|system|automation)|implement|migrate|configure.*(?:multiple|several)|and then|after that|first.*then|step[s]?\s*\d|multi.?step)\b/i;

/** Detect read-only / exploratory intents. */
const EXPLORE_PATTERN = /^(show|list|get|what|how|check|status|overview|pulse|tell me|describe|explain|who|where|which)\b/i;

// ============================================================================
// SCORING SYSTEM
// ============================================================================

interface IntentSignals {
  intent: string;
  sections: Set<IntentSection>;
  statusLabel: string;
  strong: RegExp[];    // weight 3
  medium: RegExp[];    // weight 2
  weak: RegExp[];      // weight 1
  negative: RegExp[];  // weight -3
}

/** Known macOS app names for desktop app-launch detection */
const APP_NAMES = 'textedit|finder|notes|safari|preview|calendar|music|photos|maps|messages|mail|reminders|terminal|system\\s*settings|system\\s*preferences|keynote|pages|numbers|xcode|spotify|slack|discord|zoom|figma|notion|obsidian|1password|bitwarden|iterm|warp|kitty|alacritty|ghostty|chrome|firefox|arc|brave|spotlight|calculator|activity\\s*monitor';

const APP_LAUNCH = new RegExp(`\\b(?:open|launch|start|switch\\s+to|activate|use|navigate\\s+(?:to|through))\\s+(?:${APP_NAMES})\\b`);
const APP_NAME_STANDALONE = new RegExp(`\\b(?:textedit|finder|preview|keynote|pages|numbers|xcode|spotify|slack|discord|zoom|figma|notion|obsidian|iterm|warp|kitty|alacritty|ghostty|terminal|spotlight|notes)\\b`);

/**
 * Intent signal definitions, ordered by tie-break priority.
 * When two intents score equally, the one earlier in this array wins.
 */
const INTENT_SIGNALS: IntentSignals[] = [
  // ── Desktop: physical GUI interaction ──
  {
    intent: 'desktop',
    sections: new Set<IntentSection>(['desktop', 'memory']),
    statusLabel: 'Preparing desktop control...',
    strong: [
      /\b(?:double[- ]?click|right[- ]?click)\b/,
      /\bclick(?:ed|ing)?(?:\s+on)?\b/,
      /\bdrag(?:ged|ging)?\b/,
      /\bhover(?:ed|ing)?\b/,
      /\bcursor\b/,
      /\bscroll\s*(?:up|down|left|right)\b/,
      /\b(?:resize|minimiz|maximiz|fullscreen)\w*\b/,
      /\b(?:move|close|switch)\s+(?:the\s+)?window/,
      /\b(?:cmd|ctrl|alt|option|shift)\s*\+/,
      /\bkeyboard\s*shortcut/,
      /\bpress\s+(?:enter|escape|esc|tab|space|return|delete|backspace|arrow)/,
      /\b(?:hotkey|key\s*combo)\b/,
      /\b(?:dock|title\s*bar|menu\s*bar)\b/,
      /\btypewrite\b/,
      /\bmove\s*(?:the\s*)?mouse\b/,
      /\bdesktop\s*control\b/,
      /\b(?:top|bottom)\s*(?:left|right)(?:\s*corner)?\b/,
      /\bcoordinates?\b/,
      APP_LAUNCH,
    ],
    medium: [
      /\bscroll\b/,
      /\btype\s+(?:my|the|your|this|an?)\s/,
      /\btype\s+\w+\s+(?:into|in(?:to)?\s+the)/,
      /\bpress\b/,
      /\bclose\s+this\b/,
      /\bopen\s+a\s+new\b/,
      /\bfill\s*(?:out|in)\b/,
      /\b(?:copy|cut)\b[\s\S]*\bpaste\b/,
      /\bthe\s+(?:window|dialog|button|form|menu|sidebar|toolbar)\b/,
      /\b(?:current|active|this)\s+window\b/,
      /\b(?:login|registration|signup|sign[- ]?up)\s+form\b/,
      /\bmy\s+(?:desktop|screen|computer|mac)\b/,
      /\bopen\s+a\s+new\s+tab\b/,
      /\bapp\s*switcher\b/,
      /\bnew\s+tab\b/,
      /\bscreenshot\b/,
      /\bon\s+screen\b/,
    ],
    weak: [
      /\bscreen\b/,
      /\bwindow\b/,
      /\bbutton\b/,
      /\bdesktop\b/,
      /\bapps?\b/,
      /\bmonitor\b/,
      /\bdisplay\b/,
      APP_NAME_STANDALONE,
    ],
    negative: [
      /\bwebsite\b/,
      /\burl\b/,
      /\bhttps?:\/\//,
      /\bwww\./,
      /\bbrowse\b/,
      /\bweb\s*page\b/,
    ],
  },

  // ── Browser: web navigation and scraping, plus X/Twitter writes ──
  // X posting flows (tweets, threads, articles, DMs) live on 'browser'
  // because they drive the user's real Chrome via CDP. Adding tweet/
  // twitter/x.com keywords here makes the orchestrator see the
  // x_compose_* tools when the user says things like "post this
  // tweet" or "DM James on X". Without this, "post a tweet" scored
  // zero on every intent and fell through to the 'general' bucket,
  // where the LLM would dispatch to run_agent + a stale desktop SOP.
  {
    intent: 'browser',
    sections: new Set<IntentSection>(['browser', 'memory']),
    statusLabel: 'Preparing browser...',
    strong: [
      /\bwebsite\b/,
      /\burl\b/,
      /\bbrowse\b/,
      /\bbrowser\b/,
      /\bheadless\b/,
      /\bweb\s*page\b/,
      /\bhttps?:\/\//,
      /\bwww\.\w/,
      /\bscrape\b/,
      /\bgo\s+to\s+\S+\.\w{2,}/,  // "go to example.com"
      // X / Twitter write surfaces
      /\btweet\b/,
      /\btwitter\b/,
      /\bx\.com\b/,
      /\b(?:post|publish|share)\s+(?:this\s+|a\s+|an\s+|the\s+)?(?:tweet|thread|article|post)\b/i,
      /\b(?:post|publish|share)\s+(?:this\s+|that\s+)?(?:to|on)\s+x\b/i,
      /\b(?:post|publish|share)\s+(?:to|on)\s+twitter\b/i,
      /\bx\s*article\b/i,
    ],
    medium: [
      /\bopen\s+.*page\b/,
      /\bnavigate\s+to\b/,
      /\bopen\s+.*browser\b/,
      /\bdm\s+\w+\s+on\s+(?:x|twitter)\b/i,
      /\b@\w+\s+on\s+(?:x|twitter)\b/i,
    ],
    weak: [
      /\bscreenshot\b/,
    ],
    negative: [
      /\bdesktop\b/,
      /\bmacOS\b/i,
      /\bmy\s+computer\b/,
    ],
  },

  // ── Message: chat and messaging channels ──
  {
    intent: 'message',
    sections: new Set<IntentSection>(['channels', 'agents']),
    statusLabel: 'Loading channels...',
    strong: [
      /\bwhatsapp\b/,
      /\btelegram\b/,
      /\bsend\s+.*message\b/,
      /\bsms\b/,
      /\b(?:^|\.\s*)dm\s/,
      /\b(?:whitelist|allowlist|allowed\s*chat|add\s*.*number|remove\s*.*number|block\s*.*number)\b/,
      /^text\s+\S+/,  // "text someone" at start of message = strong
    ],
    medium: [
      /\bmessage\s+\S+/,
      /\bchat\s+\S+/,
    ],
    weak: [],
    negative: [
      /\bclick\b/,
      /\bdrag\b/,
      /\b(?:cmd|ctrl)\s*\+/,
      /\bcursor\b/,
    ],
  },

  // ── Media: content generation ──
  {
    intent: 'media',
    sections: new Set<IntentSection>(['agents', 'memory']),
    statusLabel: 'Preparing media generation...',
    strong: [
      /\bgenerate\s+.*image\b/,
      /\bcreate\s+.*image\b/,
      /\b(?:draw|paint)\b/,
      /\billustration\b/,
      /\bgenerate\s+.*video\b/,
      /\bcreate\s+.*video\b/,
      /\banimate\b/,
      /\btext[- ]?to[- ]?speech\b/,
      /\btts\b/,
      /\btranscribe\b/,
      /\bspeech[- ]?to[- ]?text\b/,
      /\bstt\b/,
      /\bgenerate\s+.*audio\b/,
      /\bmake\s+.*music\b/,
      /\bsound\s+effect\b/,
      /\bvoice\s*clone\b/,
      /\bgenerate\s+.*slide\b/,
      /\bcreate\s+.*presentation\b/,
      /\bpitch\s+deck\b/,
    ],
    medium: [
      /\blogo\b/,
      /\bicon\b/,
      /\bpicture\s+of\b/,
      /\bphoto\s+of\b/,
      /\bimage\s+of\b/,
      /\bread\s+.*aloud\b/,
      /\bspeak\b/,
    ],
    weak: [],
    negative: [],
  },

  // ── Dev: software engineering tasks (code editing, debugging, refactoring) ──
  {
    intent: 'dev',
    sections: new Set<IntentSection>(['filesystem', 'project_instructions', 'memory', 'dev']),
    statusLabel: 'Entering code mode...',
    strong: [
      /\bfix\s+(?:the\s+|this\s+)?(?:bug|error|issue|crash|failure)\b/,
      /\brefactor\b/,
      /\bimplement\b/,
      /\badd\s+(?:a\s+)?(?:feature|test|endpoint|route|component|function|method|class|hook)\b/,
      /\bwrite\s+(?:a\s+)?(?:test|spec|unit\s+test|e2e)\b/,
      /\bdebug\b/,
      /\btypecheck\b/,
      /\blint\b/,
      /\bmigration\b/,
      /\bgit\s+(?:commit|push|pull|rebase|merge|diff|status|log|branch)\b/,
      /\bpr\b.*\b(?:create|open|review)\b/,
      /\bpull\s+request\b/,
      /\bbuild\s+(?:error|fail|broken)\b/,
      /\bcompile\s+error\b/,
      /\btype\s+error\b/,
      /\bstack\s+trace\b/,
      /\bnpm\s+(?:run|test|install|build)\b/,
      /\byarn\s+(?:run|test|add|build)\b/,
      /\bcargo\s+(?:run|test|build|check)\b/,
      /\bpip\s+(?:install|run)\b/,
    ],
    medium: [
      /\bcodebase\b/,
      /\bsource\s+code\b/,
      /\bfunction\b/,
      /\bmodule\b/,
      /\bcomponent\b/,
      /\bendpoint\b/,
      /\bapi\s+route\b/,
      /\bschema\b/,
      /\.(?:tsx?|jsx?|py|rs|go)\b/,
    ],
    weak: [
      /\bcode\b/,
      /\bbug\b/,
      /\berror\b/,
    ],
    negative: [
      /\bclick\b/,
      /\bdrag\b/,
      /\bscroll\b/,
    ],
  },

  // ── File: general filesystem operations ──
  {
    intent: 'file',
    sections: new Set<IntentSection>(['filesystem', 'project_instructions', 'memory']),
    statusLabel: 'Preparing filesystem access...',
    strong: [
      /\bread\s+.*file\b/,
      /\bedit\s+.*file\b/,
      /\bwrite\s+.*file\b/,
      /\bdirectory\b/,
      /\bsearch\s+.*file\b/,
      /\blist\s+.*files?\b/,
      /\.(?:md|json|yaml|yml|toml|csv|txt|xml|html|css)\b/,
    ],
    medium: [
      /\bfile\b/,
      /\bfolder\b/,
    ],
    weak: [],
    negative: [
      /\bclick\b/,
      /\bdrag\b/,
      /\bscroll\b/,
      /\bcursor\b/,
      /\b(?:cmd|ctrl)\s*\+/,
      /\bdouble[- ]?click\b/,
    ],
  },

  // ── Task: agent and workflow operations ──
  {
    intent: 'task',
    sections: new Set<IntentSection>(['agents', 'projects', 'memory']),
    statusLabel: 'Loading agents...',
    strong: [
      /\brun\s+(?:the\s+)?(?:\S+\s+)?agent\b/,  // "run the marketing agent"
      /\bcreate\s+(?:a\s+)?task\b/,
      /\bapprove\b/,
      /\breject\b/,
      /\bschedule\b/,
      /\bworkflow\b/,
      /\bagent\b.*\btask\b/,  // both words = strong signal
    ],
    medium: [
      /\bagent\b/,
      /\btask\b/,
    ],
    weak: [],
    negative: [],
  },

  // ── Research: information gathering ──
  {
    intent: 'research',
    sections: new Set<IntentSection>(['rag', 'memory', 'browser']),
    statusLabel: 'Preparing research...',
    strong: [
      /\bresearch\b/,
      /\bdeep\s+research\b/,
      /\blook\s+up\b/,
      /\bfind\s+.*info\b/,
      /\banalyze\b/,
    ],
    medium: [
      /\bsearch\b/,
    ],
    weak: [],
    negative: [
      /\bclick\b/,
      /\bdrag\b/,
      /\bcursor\b/,
      /\b\.(?:tsx?|jsx?|py|md)\b/,
      /\bsearch\s+.*file\b/,
    ],
  },

  // ── Knowledge base: ingest, upload, manage documents ──
  // Distinct from `research` (which reads/searches). This intent triggers when
  // the user wants to ADD content to the knowledge base or MANAGE existing
  // docs (upload, ingest, re-index, delete, list), which needs the same 'rag'
  // section so upload_knowledge/list_knowledge/etc. are surfaced to the model.
  // Also loads 'filesystem' because ingest typically starts from a local file.
  {
    intent: 'knowledge',
    sections: new Set<IntentSection>(['rag', 'filesystem', 'memory']),
    statusLabel: 'Loading knowledge base...',
    strong: [
      /\bknowledge\s*base\b/,
      /\bknowledge\s*doc/,
      /\bingest\b/,
      /\bupload\s+.*(?:knowledge|doc|file|pdf|markdown|md\b)/,
      /\badd\s+.*to\s+(?:the\s+)?(?:knowledge|kb|rag|docs?)\b/,
      /\bindex\s+.*(?:document|file|content)\b/,
      /\bliving\s*doc/,
    ],
    medium: [
      /\bkb\b/,
      /\brag\b/,
      /\bdocument\b/,
    ],
    weak: [
      /\bupload\b/,
      /\bingest\b/,
    ],
    negative: [
      /\bclick\b/,
      /\bdrag\b/,
      /\bcursor\b/,
    ],
  },

  // ── CRM: contact and lead management ──
  //
  // Loads 'business' because that's where list_contacts, create_contact,
  // update_contact, search_contacts, log_contact_event, and
  // get_contact_pipeline live in the tool section map. Without this,
  // any focused CRM request would match this intent but then have no
  // contact tools available to use — a confusing silent failure mode.
  {
    intent: 'crm',
    sections: new Set<IntentSection>(['memory', 'agents', 'business']),
    statusLabel: 'Loading CRM context...',
    strong: [
      /\blead\b/,
      /\bcustomer\b/,
      /\bdeal\b/,
      /\bcrm\b/,
    ],
    medium: [
      /\bcontact\b/,
      /\bcall\b/,
      /\blog\s+.*event\b/,
    ],
    weak: [],
    negative: [
      /\bclick\b/,
      /\bdrag\b/,
      /\b(?:cmd|ctrl)\s*\+/,
      /\bfill\s*(?:out|in)\b/,
    ],
  },

  // ── Status: workspace overview ──
  {
    intent: 'status',
    sections: new Set<IntentSection>(['pulse', 'agents', 'projects']),
    statusLabel: 'Gathering workspace data...',
    strong: [
      /\bpulse\b/,
      /\boverview\b/,
      /\bdashboard\b/,
      /\bhow\s+.*(?:things|going)\b/,
    ],
    medium: [
      /\bstatus\b/,
      /\bupdate\b/,
    ],
    weak: [],
    negative: [],
  },

  // ── Plan: strategic planning ──
  {
    intent: 'plan',
    sections: new Set<IntentSection>(['agents', 'projects', 'memory']),
    statusLabel: 'Loading workspace...',
    strong: [
      /\broadmap\b/,
      /\bstrategy\b/,
    ],
    medium: [
      /\bplan\b/,
      /\bsteps\b/,
    ],
    weak: [],
    negative: [],
  },
];

/** Score a message against a single intent's signals */
function scoreIntent(lower: string, signals: IntentSignals): number {
  let score = 0;
  for (const re of signals.strong)   if (re.test(lower)) score += 3;
  for (const re of signals.medium)   if (re.test(lower)) score += 2;
  for (const re of signals.weak)     if (re.test(lower)) score += 1;
  for (const re of signals.negative) if (re.test(lower)) score -= 3;
  return score;
}

// ============================================================================
// HELPERS
// ============================================================================

function detectMode(intent: string, message: string): OrchestratorMode {
  if (['greeting', 'status'].includes(intent)) return 'conversational';
  if (['file', 'research', 'browser'].includes(intent) && EXPLORE_PATTERN.test(message.trim())) return 'explore';
  if (EXPLORE_PATTERN.test(message.trim()) && !COMPLEX_PATTERN.test(message)) return 'explore';
  return 'execute';
}

function detectPlanFirst(message: string, intent: string): boolean {
  if (['greeting', 'status', 'message'].includes(intent)) return false;
  return COMPLEX_PATTERN.test(message);
}

function classify(intent: string, sections: Set<IntentSection>, statusLabel: string, message: string): ClassifiedIntent {
  return {
    intent,
    sections,
    statusLabel,
    planFirst: detectPlanFirst(message, intent),
    mode: detectMode(intent, message),
  };
}

// ============================================================================
// MAIN CLASSIFIER
// ============================================================================

export function classifyIntent(message: string, previousIntent?: ClassifiedIntent): ClassifiedIntent {
  const lower = message.toLowerCase().trim();

  // Short confirmation messages → inherit previous intent's sections
  if (CONFIRMATION_PATTERN.test(lower) && previousIntent) {
    return {
      intent: previousIntent.intent,
      sections: previousIntent.sections,
      statusLabel: 'On it...',
      planFirst: false,
      mode: 'execute',
    };
  }

  // Greetings (exact-match short circuit, not keyword-based)
  if (/^(hey|hi|hello|morning|good morning|good evening|yo|sup|what'?s up)\b/.test(lower)) {
    return classify('greeting', new Set<IntentSection>(['pulse', 'memory', 'agents']), 'Checking your pulse...', lower);
  }

  // Score all intents in parallel — highest score wins, but merge sections
  // from all qualifying intents so multi-step prompts get the right tools.
  // e.g. "Open Safari, go to apple.com, then drag the screenshot to Finder"
  // → primary intent: desktop, but browser sections also included.
  let bestSignals = INTENT_SIGNALS[0];
  let bestScore = 0;
  const qualifyingIntents: IntentSignals[] = [];

  for (const signals of INTENT_SIGNALS) {
    const score = scoreIntent(lower, signals);
    if (score >= 3) qualifyingIntents.push(signals);
    if (score > bestScore) {
      bestScore = score;
      bestSignals = signals;
    }
    // Ties break by priority order (earlier in INTENT_SIGNALS wins)
  }

  if (bestScore >= 3) {
    // Merge sections from qualifying intents (capped at top 3 to prevent prompt bloat)
    const mergedSections = new Set<IntentSection>(bestSignals.sections);
    const topQualifying = qualifyingIntents
      .filter(q => q !== bestSignals)
      .slice(0, 2);
    for (const q of topQualifying) {
      for (const s of q.sections) mergedSections.add(s);
    }
    return classify(bestSignals.intent, mergedSections, bestSignals.statusLabel, lower);
  }

  // General fallback — include core context + channels (low token cost, high utility)
  return classify('general', new Set<IntentSection>(['agents', 'memory', 'rag', 'business', 'pulse', 'channels']), 'Thinking...', lower);
}
