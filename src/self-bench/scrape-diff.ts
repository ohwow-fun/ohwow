/**
 * scrape-diff — structural diff between two normalized scrape
 * snapshots.
 *
 * This is NOT a full LCS diff. It's a set-difference on non-empty
 * lines: what lines are in the new snapshot but not the old
 * (`added`), and what lines are in the old but not the new
 * (`removed`). That's enough to answer "what's different about this
 * page" for a market-radar probe — the operator doesn't need
 * line-aligned diffs, just a bulleted "these bullets appeared, those
 * disappeared" so an LLM drafter can pick up the signal.
 *
 * Output is capped at MAX_LINES_PER_SIDE lines per side to keep
 * evidence rows small. Callers hash the full normalized snapshots
 * separately — the diff is for human/LLM context, not dedup.
 */

export interface ScrapeDiffResult {
  added: string[];
  removed: string[];
  /** True when either side was truncated to the cap. */
  truncated: boolean;
}

export const MAX_LINES_PER_SIDE = 40;

/**
 * Compute added/removed line sets between two normalized snapshots.
 * Empty lines are ignored. Deterministic order: input order within
 * each side, dedup preserved from first occurrence.
 */
export function diffScrapeSnapshots(
  oldSnapshot: string,
  newSnapshot: string,
  maxLinesPerSide: number = MAX_LINES_PER_SIDE,
): ScrapeDiffResult {
  const oldLines = splitLines(oldSnapshot);
  const newLines = splitLines(newSnapshot);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const added: string[] = [];
  const removed: string[] = [];
  const seenAdded = new Set<string>();
  const seenRemoved = new Set<string>();

  for (const line of newLines) {
    if (!oldSet.has(line) && !seenAdded.has(line)) {
      seenAdded.add(line);
      added.push(line);
    }
  }
  for (const line of oldLines) {
    if (!newSet.has(line) && !seenRemoved.has(line)) {
      seenRemoved.add(line);
      removed.push(line);
    }
  }

  const truncated = added.length > maxLinesPerSide || removed.length > maxLinesPerSide;
  return {
    added: added.slice(0, maxLinesPerSide),
    removed: removed.slice(0, maxLinesPerSide),
    truncated,
  };
}

function splitLines(snapshot: string): string[] {
  if (!snapshot) return [];
  return snapshot
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
