/**
 * Intent classification for the local orchestrator.
 * Pure function — no class or DB dependency.
 */

import type { ClassifiedIntent, OrchestratorMode } from './orchestrator-types.js';
import type { IntentSection } from './tool-definitions.js';

export const CONFIRMATION_PATTERN = /^(yes|yeah|yep|yup|sure|ok|okay|proceed|go ahead|do it|go for it|let'?s go|let'?s do it|sounds good|confirmed?|absolutely|please|please do|that works|perfect|exactly|correct)\s*[.!]?$/i;

/** Detect complex multi-step requests that benefit from planning before execution. */
const COMPLEX_PATTERN = /\b(set up|build|create.*(?:pipeline|workflow|system|automation)|implement|migrate|configure.*(?:multiple|several)|and then|after that|first.*then|step[s]?\s*\d|multi.?step)\b/i;

/** Detect read-only / exploratory intents. */
const EXPLORE_PATTERN = /^(show|list|get|what|how|check|status|overview|pulse|tell me|describe|explain|who|where|which)\b/i;

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

  // Greetings
  if (/^(hey|hi|hello|morning|good morning|good evening|yo|sup|what'?s up)\b/.test(lower)) {
    return classify('greeting', new Set<IntentSection>(['pulse', 'memory', 'agents']), 'Checking your pulse...', lower);
  }

  // File/code operations
  if (/\b(file|folder|directory|codebase|code|read|edit|write|list|search.*file|\.tsx?|\.jsx?|\.py|\.md)\b/.test(lower)) {
    return classify('file', new Set<IntentSection>(['filesystem', 'project_instructions', 'memory']), 'Preparing filesystem access...', lower);
  }

  // Task/agent operations
  if (/\b(run agent|create task|approve|reject|schedule|agent|task|workflow)\b/.test(lower)) {
    return classify('task', new Set<IntentSection>(['agents', 'projects', 'memory']), 'Loading agents...', lower);
  }

  // Status/overview
  if (/\b(status|pulse|overview|update|how.*(things|going)|dashboard)\b/.test(lower)) {
    return classify('status', new Set<IntentSection>(['pulse', 'agents', 'projects']), 'Gathering workspace data...', lower);
  }

  // Research
  if (/\b(research|look up|search|find.*info|analyze|deep research)\b/.test(lower)) {
    return classify('research', new Set<IntentSection>(['rag', 'memory', 'browser']), 'Preparing research...', lower);
  }

  // CRM
  if (/\b(contact|lead|customer|deal|crm|call|log.*event)\b/.test(lower)) {
    return classify('crm', new Set<IntentSection>(['memory', 'agents']), 'Loading CRM context...', lower);
  }

  // Messaging (including whitelist management)
  if (/\b(whatsapp|telegram|send.*message|message\s+\S+|msg|dm|sms|text\s+\S+|chat\s+\S+)\b/.test(lower) ||
      /\b(whitelist|allowlist|allowed.*chat|add.*number|remove.*number|block.*number)\b/.test(lower)) {
    return classify('message', new Set<IntentSection>(['channels', 'agents']), 'Loading channels...', lower);
  }

  // Media generation (images, video, audio, TTS, STT)
  if (/\b(generate.*image|create.*image|draw|paint|illustration|logo|icon|picture of|photo of|image of|generate.*video|create.*video|animate|text.?to.?speech|read.*aloud|speak|tts|transcribe|speech.?to.?text|stt|generate.*audio|make.*music|sound effect|voice.*clone|generate.*slide|create.*presentation|pitch deck)\b/.test(lower)) {
    return classify('media', new Set<IntentSection>(['agents', 'memory']), 'Preparing media generation...', lower);
  }

  // Browser
  if (/\b(website|url|browse|browser|chromium|headless|scrape|screenshot|open.*page|open.*browser|go to|web\s*page|http|www)\b/.test(lower)) {
    return classify('browser', new Set<IntentSection>(['browser', 'memory']), 'Preparing browser...', lower);
  }

  // Plans
  if (/\b(plan|strategy|roadmap|steps)\b/.test(lower)) {
    return classify('plan', new Set<IntentSection>(['agents', 'projects', 'memory']), 'Loading workspace...', lower);
  }

  // General fallback — include core context + channels (low token cost, high utility)
  return classify('general', new Set<IntentSection>(['agents', 'memory', 'rag', 'business', 'pulse', 'channels']), 'Thinking...', lower);
}
