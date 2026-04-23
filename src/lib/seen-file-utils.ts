import fs from 'node:fs';

/** Load all IDs already recorded in a JSONL seen-file. Returns an empty Set if the file doesn't exist. */
export function loadSeen(seenPath: string): Set<string> {
  const seen = new Set<string>();
  if (!fs.existsSync(seenPath)) return seen;
  const lines = fs.readFileSync(seenPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      seen.add((JSON.parse(line) as { id: string }).id);
    } catch {
      // Skip malformed lines
    }
  }
  return seen;
}

/** Append items to the JSONL seen-file. Each line: {"id":"...","ts":"..."} */
export function appendSeen(seenPath: string, items: Array<{ id: string }>): void {
  const lines = items.map(item =>
    JSON.stringify({ id: item.id, ts: new Date().toISOString() })
  );
  if (lines.length === 0) return;
  fs.appendFileSync(seenPath, lines.join('\n') + '\n');
}

/** Filter out items whose IDs are already in the seen set. */
export function filterFresh<T extends { id: string }>(items: T[], seen: Set<string>): T[] {
  return items.filter(item => !seen.has(item.id));
}
