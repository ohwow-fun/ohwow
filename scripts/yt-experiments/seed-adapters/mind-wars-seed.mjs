/**
 * Mind Wars — seed adapter.
 *
 * Primary source: ohwow knowledge base, filtered by tag 'mind-wars' via
 * the daemon's /api/knowledge/search endpoint. Falls back to a curated
 * question list bundled with this file if the knowledge base has no
 * mind-wars-tagged docs yet.
 *
 * This adapter is intentionally less polished than briefing/tomorrow-broke
 * until the philosophy corpus is seeded. The prompt module is strict about
 * refusing to fabricate attributions, so low-quality seeds will safely
 * produce confidence:0 drafts rather than bad episodes.
 */
import { resolveOhwow } from "../../x-experiments/_ohwow.mjs";
import {
  loadSeen,
  markSeen,
  hash,
  randomPick,
} from "./_common.mjs";

const SERIES = "mind-wars";

/**
 * Bootstrap question list — grounded enough for first runs, not meant as
 * the steady-state source. Each question carries a suggested corpus tag
 * and a one-line frame the prompt module can fact-check against.
 */
const BOOTSTRAP_QUESTIONS = [
  {
    question: "Should AI agents own the property they produce?",
    corpus_tag: "property-rights",
    frame: "Locke's labor theory of property vs. tool-use theories. Nozick on desert.",
  },
  {
    question: "If an AI can pass the Turing test, do you owe it grief when you retire it?",
    corpus_tag: "moral-patiency",
    frame: "Parfit on personal identity. Chalmers on substrate-independence.",
  },
  {
    question: "Is the end of full employment a failure of policy or a success of civilization?",
    corpus_tag: "future-of-work",
    frame: "Keynes's 'economic possibilities for our grandchildren' vs. Arendt on labor and meaning.",
  },
  {
    question: "Can a person have a meaningful life with no work at all?",
    corpus_tag: "meaning-of-work",
    frame: "Aristotelian virtue ethics vs. Maslow's hierarchy. The Mormon / kibbutz counter-examples.",
  },
  {
    question: "Should AI-generated art count as art?",
    corpus_tag: "aesthetics",
    frame: "Danto on the artworld. Goodman on the languages of art. Benjamin on mechanical reproduction.",
  },
  {
    question: "Does an AGI have a right to self-preservation?",
    corpus_tag: "moral-patiency",
    frame: "Hobbes on natural rights. Singer on moral circles. Nagel on the point of view of the universe.",
  },
  {
    question: "Is concentration of wealth among a few labs a bigger risk than misaligned AGI?",
    corpus_tag: "political-economy",
    frame: "Hayek on distributed knowledge. Piketty on r > g. Olson on collective action.",
  },
  {
    question: "Should AI companions be legal for minors?",
    corpus_tag: "developmental-ethics",
    frame: "Turkle on relational selfhood. Bowlby on attachment. Mill on harm principle.",
  },
];

/**
 * Query the knowledge base for mind-wars-tagged docs. Returns an array of
 * {id, title, snippet} or [] if the endpoint isn't available or no results.
 * Best-effort — falls back to bootstrap questions on any error.
 */
async function searchKnowledge(tag) {
  try {
    const { url, token } = resolveOhwow();
    const res = await fetch(`${url}/api/knowledge/search?q=${encodeURIComponent(tag)}&limit=10`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

export async function pickSeed({ workspace, historyDays: _historyDays = 30 } = {}) {
  const seen = loadSeen(workspace, SERIES);

  // Try corpus first.
  const hits = await searchKnowledge("mind-wars");
  if (hits.length) {
    const unseen = hits
      .map((h) => ({ ...h, _hash: hash(h.id || h.title || h.snippet || JSON.stringify(h)) }))
      .filter((h) => !seen.has(h._hash));
    if (unseen.length) {
      const pick = randomPick(unseen);
      const seed = {
        kind: "knowledge",
        title: pick.title || "mind-wars excerpt",
        body: pick.snippet || pick.content || pick.title || "",
        citations: [],
        metadata: {
          corpus_tag: "mind-wars",
          source_doc: pick.id || null,
        },
      };
      markSeen(workspace, SERIES, pick._hash, seed.title);
      return seed;
    }
  }

  // Fallback — bootstrap question list.
  const bootstrapUnseen = BOOTSTRAP_QUESTIONS
    .map((q) => ({ ...q, _hash: hash(q.question) }))
    .filter((q) => !seen.has(q._hash));
  if (!bootstrapUnseen.length) return null; // exhausted bootstrap pool

  const pick = randomPick(bootstrapUnseen);
  const seed = {
    kind: "internal-archive",
    title: pick.question,
    body: `QUESTION: ${pick.question}\n\nFRAME: ${pick.frame}`,
    citations: [],
    metadata: {
      corpus_tag: pick.corpus_tag,
      source: "bootstrap-questions",
    },
  };
  markSeen(workspace, SERIES, pick._hash, seed.title);
  return seed;
}
