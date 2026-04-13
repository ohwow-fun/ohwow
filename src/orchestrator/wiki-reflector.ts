/**
 * Wiki Reflector — ambient curation hook.
 *
 * Runs after every chat turn as a fire-and-forget job. Asks a cheap
 * model whether the exchange contained durable, wiki-worthy information,
 * then either appends to an existing page or creates a new one. This
 * is the safety net layer beneath the system prompt: even if the COS
 * doesn't proactively call wiki_write_page mid-turn, the reflector
 * catches what should have been captured.
 *
 * Design constraints:
 * - Never block the chat response (caller invokes with .catch()).
 * - Never throw — degrade silently.
 * - Use the cheapest router purpose ('extraction') so it costs ~nothing.
 * - Strict JSON parse, abort on malformed output.
 * - Skip when the COS already called wiki_write_page this turn (no
 *   need to second-guess in-turn curation).
 * - Idempotent: dedupe slugs against the existing wiki, append when
 *   the slug already exists rather than overwriting.
 * - Content cap per update so a chatty model can't bloat a page.
 */

import { logger } from '../lib/logger.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { LocalToolContext } from './local-tool-types.js';
import { listWikiPages, readWikiPage, writeWikiPage } from './tools/wiki.js';

interface WikiReflectionUpdate {
  slug: string;
  title: string;
  action: 'create' | 'append';
  section?: string;
  content: string;
}

interface WikiReflectionPayload {
  updates: WikiReflectionUpdate[];
}

const MIN_USER_MESSAGE_LEN = 25;
const MAX_CONTENT_PER_UPDATE = 800;
const MAX_UPDATES_PER_TURN = 3;
const MAX_USER_SLICE = 1500;
const MAX_ASSISTANT_SLICE = 1500;

const REFLECTION_PROMPT = `You are the wiki curator for an AI business OS. Your job: decide whether a chat exchange contains durable, reusable information worth saving to the team's wiki.

CAPTURE (durable, useful next week or to other teammates):
- Decisions and the reasoning behind them ("we discount enterprise 15%")
- Facts about people: roles, preferences, contact details, working style
- Facts about competitors, vendors, tools, products, markets
- Recurring playbooks, procedures, "how we do X"
- Goals, constraints, deadlines, OKRs
- Domain knowledge: terminology, technical patterns, learned lessons

IGNORE (ephemeral, no future value):
- Greetings, status checks, small talk
- One-off questions and their answers
- Personal feelings or transient state
- Questions ABOUT the wiki itself (the user is asking you to look something up, not telling you something new)
- Tool-call chatter or process narration

Output STRICT JSON, no prose, no markdown fences:
{"updates":[{"slug":"kebab-case","title":"Human Title","action":"create" | "append","section":"## Heading","content":"1-3 sentence markdown body to add. Terse and factual."}]}

If nothing is durable, output: {"updates":[]}

Rules:
- Use existing slugs from the EXISTING WIKI list when the new info belongs on an existing page (action: "append").
- Only create a new page when no existing page is a natural fit.
- "section" is required for "append" — pick the heading the new content should live under (create it if needed).
- Maximum 3 updates per turn. Pick the most important.
- Keep "content" terse: ≤ 3 sentences. Don't restate the conversation, distill the fact.`;

interface ReflectorDeps {
  modelRouter: ModelRouter | null;
  toolCtx: LocalToolContext;
}

export async function reflectOnWikiOpportunities(
  deps: ReflectorDeps,
  userMessage: string,
  assistantResponse: string,
  options: { skipIfCuratedInTurn: boolean },
): Promise<void> {
  // Gate 1: the COS already curated mid-turn — don't second-guess it.
  if (options.skipIfCuratedInTurn) return;

  // Gate 2: short / trivial messages aren't worth reflecting on.
  const trimmed = userMessage.trim();
  if (trimmed.length < MIN_USER_MESSAGE_LEN) return;

  // Gate 3: need a model router to do the extraction.
  if (!deps.modelRouter) return;

  try {
    // Pull the existing wiki page list so the model knows what to
    // append to vs. create. Cheap call: file-system list, no I/O on
    // page bodies.
    const listResult = await listWikiPages(deps.toolCtx, {});
    const existingPages = listResult.success && listResult.data
      ? ((listResult.data as { pages?: Array<{ slug: string; title: string; summary: string | null }> }).pages ?? [])
      : [];

    const existingForPrompt = existingPages.length > 0
      ? existingPages
          .slice(0, 60) // hard cap so the prompt stays small
          .map((p) => `- ${p.slug}: ${p.title}${p.summary ? ` — ${p.summary}` : ''}`)
          .join('\n')
      : '(no pages yet)';

    const userBlock = `EXISTING WIKI:
${existingForPrompt}

EXCHANGE:
USER: ${userMessage.slice(0, MAX_USER_SLICE)}

ASSISTANT: ${assistantResponse.slice(0, MAX_ASSISTANT_SLICE)}`;

    // Run the extraction on the cheap tier. 'memory_extraction' routes
    // to gemini-flash / haiku / similar by default — same tier the
    // memory extractor uses.
    const provider = await deps.modelRouter.getProvider('memory_extraction');
    const result = await provider.createMessage({
      system: REFLECTION_PROMPT,
      messages: [{ role: 'user', content: userBlock }],
      maxTokens: 1024,
      temperature: 0,
    });

    // Strict JSON parse. Strip any accidental code fences first since
    // smaller models occasionally wrap JSON despite the prompt.
    const cleaned = stripJsonFences(result.content.trim());
    let payload: WikiReflectionPayload;
    try {
      payload = JSON.parse(cleaned) as WikiReflectionPayload;
    } catch {
      logger.debug({ raw: cleaned.slice(0, 200) }, '[wiki-reflector] non-JSON output, skipping');
      return;
    }

    const updates = Array.isArray(payload.updates) ? payload.updates : [];
    if (updates.length === 0) return;

    // Dedupe by slug (model occasionally repeats) and cap.
    const seen = new Set<string>();
    const accepted: WikiReflectionUpdate[] = [];
    for (const u of updates) {
      if (!u || typeof u.slug !== 'string' || typeof u.content !== 'string') continue;
      const slug = u.slug.toLowerCase().trim();
      if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      accepted.push({
        ...u,
        slug,
        content: u.content.slice(0, MAX_CONTENT_PER_UPDATE),
      });
      if (accepted.length >= MAX_UPDATES_PER_TURN) break;
    }

    const existingBySlug = new Map(existingPages.map((p) => [p.slug, p]));

    for (const update of accepted) {
      try {
        const exists = existingBySlug.has(update.slug);
        if (exists || update.action === 'append') {
          await applyAppend(deps.toolCtx, update);
        } else {
          await applyCreate(deps.toolCtx, update);
        }
      } catch (err) {
        logger.warn({ err, slug: update.slug }, '[wiki-reflector] failed to apply update');
      }
    }

    logger.info(
      { updates: accepted.length, slugs: accepted.map((u) => u.slug) },
      '[wiki-reflector] curated turn',
    );
  } catch (err) {
    logger.warn({ err }, '[wiki-reflector] reflection failed');
  }
}

function stripJsonFences(text: string): string {
  // Strip ```json ... ``` or ``` ... ``` if the model wrapped it.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return text;
}

async function applyAppend(ctx: LocalToolContext, update: WikiReflectionUpdate): Promise<void> {
  // Read the existing page (or fall back to create if it's gone missing).
  const readResult = await readWikiPage(ctx, { slug: update.slug });
  if (!readResult.success || !readResult.data) {
    await applyCreate(ctx, update);
    return;
  }
  const data = readResult.data as {
    title: string;
    summary: string | null;
    body: string;
  };

  const merged = mergeIntoBody(data.body, update.section ?? '## Notes', update.content);

  // No-op if the merge didn't change anything (content already present).
  if (merged === data.body) {
    logger.debug({ slug: update.slug }, '[wiki-reflector] content already present, skipping append');
    return;
  }

  await writeWikiPage(ctx, {
    slug: update.slug,
    title: data.title,
    body: merged,
    summary: data.summary ?? undefined,
  });
}

async function applyCreate(ctx: LocalToolContext, update: WikiReflectionUpdate): Promise<void> {
  const heading = update.section?.startsWith('#') ? update.section : '## Notes';
  const body = `${heading}\n\n${update.content}\n`;
  await writeWikiPage(ctx, {
    slug: update.slug,
    title: update.title || update.slug,
    body,
  });
}

/**
 * Merge a new block of content into an existing markdown body under a
 * specific section heading. If the section exists, append the content
 * beneath it (after any existing content in that section). If not,
 * append the section + content to the end of the body. Idempotent: if
 * the exact content is already present in the section, return the body
 * unchanged.
 */
function mergeIntoBody(body: string, section: string, content: string): string {
  const heading = section.trim().startsWith('#') ? section.trim() : `## ${section.trim()}`;
  const trimmedContent = content.trim();
  if (!trimmedContent) return body;

  // Idempotency check: if the new content is already substantially
  // present (first sentence match), skip.
  const firstSentence = trimmedContent.split(/[.!?]\s/)[0].slice(0, 80);
  if (firstSentence.length > 20 && body.includes(firstSentence)) {
    return body;
  }

  const lines = body.split('\n');
  const headingIdx = lines.findIndex((l) => l.trim() === heading);

  if (headingIdx === -1) {
    // Section doesn't exist — append to the end.
    const trailing = body.endsWith('\n') ? '' : '\n';
    return `${body}${trailing}\n${heading}\n\n${trimmedContent}\n`;
  }

  // Find where the next heading starts (or end of doc) and insert
  // before it.
  let insertIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      insertIdx = i;
      break;
    }
  }

  // Trim trailing blank lines in the section so insertion is clean.
  while (insertIdx > headingIdx + 1 && lines[insertIdx - 1].trim() === '') {
    insertIdx--;
  }

  const before = lines.slice(0, insertIdx);
  const after = lines.slice(insertIdx);
  const insertion = ['', trimmedContent, ''];
  return [...before, ...insertion, ...after].join('\n');
}
