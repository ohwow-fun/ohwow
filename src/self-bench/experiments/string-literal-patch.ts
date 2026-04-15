/**
 * JSON-patch applier for string-literal-mode tier-2 paths.
 *
 * The patch-author's string-literal branch asks the model for an
 * array of {find, replace, occurrence?} edits rather than a full
 * file rewrite. This module owns the parse + apply step:
 *
 *   - validate JSON shape
 *   - require each `find` to match the source exactly once (or at
 *     the specified 1-based occurrence when multiple matches exist)
 *   - apply edits left-to-right against the original source
 *   - refuse if any find is missing, ambiguous, or if an edit is a
 *     no-op (find === replace)
 *
 * The Layer 4 AST gate in safeSelfCommit is what enforces that the
 * replacement lands INSIDE a string-literal node. This applier only
 * cares that the text-level edit is unambiguous.
 */

export interface StringLiteralEdit {
  find: string;
  replace: string;
  /** 1-based match index when `find` appears more than once. */
  occurrence?: number;
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
  content?: string;
  /** Per-edit match offset for logging. */
  appliedAt?: number[];
}

/**
 * Parse an LLM response into an edit array. Accepts either a bare
 * JSON array or a JSON object with `{ edits: [...] }` so the model
 * has two permissible shapes. Strips a single fenced code block.
 */
export function parseStringLiteralEditsResponse(raw: string): StringLiteralEdit[] | { error: string } {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `model response is not valid JSON: ${(err as Error).message}` };
  }
  let edits: unknown;
  if (Array.isArray(parsed)) {
    edits = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).edits)) {
    edits = (parsed as Record<string, unknown>).edits;
  } else {
    return { error: 'expected a JSON array of {find, replace} edits or an object with an `edits` array' };
  }
  const arr = edits as unknown[];
  const out: StringLiteralEdit[] = [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!e || typeof e !== 'object') return { error: `edit #${i} is not an object` };
    const { find, replace, occurrence } = e as Record<string, unknown>;
    if (typeof find !== 'string' || find.length === 0) {
      return { error: `edit #${i} missing or empty \`find\` string` };
    }
    if (typeof replace !== 'string') {
      return { error: `edit #${i} missing \`replace\` string` };
    }
    if (find === replace) {
      return { error: `edit #${i} is a no-op (find === replace)` };
    }
    const edit: StringLiteralEdit = { find, replace };
    if (occurrence !== undefined) {
      if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
        return { error: `edit #${i} has non-integer/zero occurrence` };
      }
      edit.occurrence = occurrence;
    }
    out.push(edit);
  }
  if (out.length === 0) return { error: 'edits array is empty' };
  return out;
}

/**
 * Apply edits to `source`. Each edit's `find` must match exactly one
 * occurrence in the pre-edit source (or the specified occurrence
 * when disambiguation is needed). Applies in order of discovered
 * match offset so left-to-right edits don't invalidate later ones.
 */
export function applyStringLiteralEdits(
  source: string,
  edits: readonly StringLiteralEdit[],
): ApplyResult {
  const matches: Array<{ edit: StringLiteralEdit; index: number }> = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const all = allIndicesOf(source, e.find);
    if (all.length === 0) {
      return { ok: false, reason: `edit #${i} find string not found: ${truncate(e.find)}` };
    }
    if (all.length > 1 && e.occurrence === undefined) {
      return {
        ok: false,
        reason: `edit #${i} find string appears ${all.length} times — specify \`occurrence\` (1-based) to disambiguate`,
      };
    }
    const pick = e.occurrence ?? 1;
    if (pick > all.length) {
      return {
        ok: false,
        reason: `edit #${i} occurrence=${pick} but only ${all.length} match(es) exist`,
      };
    }
    matches.push({ edit: e, index: all[pick - 1] });
  }
  // Sort by source position so replacements chained left-to-right
  // preserve each subsequent match offset.
  matches.sort((a, b) => a.index - b.index);
  // Reject overlaps — an edit's span can't touch another's.
  for (let i = 1; i < matches.length; i++) {
    const prev = matches[i - 1];
    const prevEnd = prev.index + prev.edit.find.length;
    if (matches[i].index < prevEnd) {
      return { ok: false, reason: `edits overlap in source at offset ${matches[i].index}` };
    }
  }
  let out = '';
  let cursor = 0;
  const appliedAt: number[] = [];
  for (const m of matches) {
    out += source.slice(cursor, m.index);
    out += m.edit.replace;
    cursor = m.index + m.edit.find.length;
    appliedAt.push(m.index);
  }
  out += source.slice(cursor);
  if (out === source) {
    return { ok: false, reason: 'edits produced no change to source' };
  }
  return { ok: true, content: out, appliedAt };
}

function allIndicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

function truncate(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
