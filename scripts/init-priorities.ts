/**
 * Bootstrap the per-workspace priorities directory.
 *
 * Creates `~/.ohwow/workspaces/<name>/priorities/` if missing, writes a
 * README.md that documents the convention, and regenerates the index
 * section in the README based on whatever priority files are already
 * there. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/init-priorities.ts
 *   npx tsx scripts/init-priorities.ts --workspace=avenued
 *   npx tsx scripts/init-priorities.ts --example   # also writes an example priority
 */

import fs from 'node:fs';
import path from 'node:path';
import { workspaceLayoutFor } from '../src/config.js';
import { readPriorityDocs, renderPrioritiesReadme } from '../src/lib/priorities.js';

function parseArgs(argv: string[]): { workspace: string; example: boolean } {
  const out = { workspace: 'default', example: false };
  for (const raw of argv) {
    if (raw.startsWith('--workspace=')) out.workspace = raw.split('=')[1] || 'default';
    else if (raw === '--example') out.example = true;
  }
  return out;
}

function writeExample(dir: string): string {
  const file = path.join(dir, 'example-outreach-template-rewrite.md');
  if (fs.existsSync(file)) return file;
  const body = [
    '---',
    'title: "Outreach template rewrite"',
    'status: pending',
    'tags: [outreach, thermostat, copy]',
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
    '## Goal',
    'Drop the "Hey [name], caught [bucket hint]" opener — operators keep',
    'rejecting it. Move to something that reads less like a template.',
    '',
    '## Context',
    'See `strategy.attribution_findings` and the operator-rejections',
    'section of the context pack for evidence.',
    '',
    '## Work Log',
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

function main() {
  const { workspace, example } = parseArgs(process.argv.slice(2));
  const layout = workspaceLayoutFor(workspace);
  const prioritiesDir = path.join(layout.dataDir, 'priorities');
  fs.mkdirSync(prioritiesDir, { recursive: true });

  if (example) {
    const written = writeExample(prioritiesDir);
    process.stdout.write(`[init-priorities] wrote example priority at ${written}\n`);
  }

  const docs = readPriorityDocs(layout.dataDir);
  const readme = renderPrioritiesReadme(docs);
  fs.writeFileSync(path.join(prioritiesDir, 'README.md'), readme, 'utf-8');

  process.stdout.write(
    `[init-priorities] workspace=${workspace} dir=${prioritiesDir} priorities=${docs.length}\n`,
  );
  for (const d of docs) {
    process.stdout.write(`  - [${d.status}] ${d.title}\n`);
  }
}

main();
