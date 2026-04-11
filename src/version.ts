import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function findVersion(): string {
  // When bundled, import.meta.url may be deep in dist/.
  // Use cwd-based resolution (bin script always runs from repo root).
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export const VERSION = findVersion();
