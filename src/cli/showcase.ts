/* eslint-disable no-console */
/**
 * `ohwow showcase <target>` — Phase 1 MVP.
 *
 * Terminal-first research + setup flow. Takes a person or company name,
 * optionally fetches their website for a quick read, proposes a tailored
 * agent + project + goal + contact, and applies it to the active workspace
 * on user confirmation.
 *
 * Why a separate CLI entry (instead of a subscreen in the main TUI): this
 * is a one-shot immersive experience — splash → research → propose →
 * apply → exit — not a navigable tab. The main TUI stays untouched.
 */

import React from 'react';
import { render } from 'ink';
import { ShowcaseWizard } from '../tui/screens/showcase-wizard.js';
import { guessKind, normalizeUrl } from '../showcase/research.js';
import { resolveWorkspaceId } from '../showcase/setup.js';
import type { ShowcaseTarget, TargetKind } from '../showcase/types.js';

interface ParsedArgs {
  name: string;
  url?: string;
  company?: string;
  email?: string;
  kindOverride?: TargetKind;
  showHelp: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let url: string | undefined;
  let company: string | undefined;
  let email: string | undefined;
  let kindOverride: TargetKind | undefined;
  let showHelp = false;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else if (arg.startsWith('--company=')) {
      company = arg.slice('--company='.length);
    } else if (arg.startsWith('--email=')) {
      email = arg.slice('--email='.length);
    } else if (arg === '--person') {
      kindOverride = 'person';
    } else if (arg === '--company') {
      kindOverride = 'company';
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  return {
    name: positional.join(' ').trim(),
    url,
    company,
    email,
    kindOverride,
    showHelp,
  };
}

function usage(): void {
  console.log('Usage: ohwow showcase <target> [flags]');
  console.log('');
  console.log('Research a person or company and set up a tailored agent, project, goal,');
  console.log('and contact in the active workspace.');
  console.log('');
  console.log('Arguments:');
  console.log('  <target>              Name of the person or company (positional).');
  console.log('');
  console.log('Flags:');
  console.log('  --url=<url>           Website to read for context (recommended).');
  console.log('  --company=<name>      Company name (when <target> is a person).');
  console.log('  --email=<addr>        Email for the contact.');
  console.log('  --person              Force target kind = person.');
  console.log('  --company             Force target kind = company (ambiguous names).');
  console.log('');
  console.log('Examples:');
  console.log('  ohwow showcase "Acme Corp" --url=acme.com');
  console.log('  ohwow showcase "Jane Doe" --person --company="Acme" --url=acme.com');
}

export async function runShowcaseCli(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.showHelp || !parsed.name) {
    usage();
    process.exit(parsed.showHelp ? 0 : 1);
  }

  // Workspace + DB: resolve the focused workspace and open its SQLite DB
  // directly. We don't need the daemon running — this command writes rows
  // that the daemon (when next started) will pick up.
  const { loadConfig, resolveActiveWorkspace, DEFAULT_PORT } = await import('../config.js');
  const { initDatabase } = await import('../db/init.js');
  const { createSqliteAdapter } = await import('../db/sqlite-adapter.js');

  const active = resolveActiveWorkspace();
  let dbPath: string;
  let port: number;
  let ollamaModel: string | undefined;
  try {
    const config = loadConfig();
    dbPath = config.dbPath;
    port = config.port;
    ollamaModel = config.ollamaModel;
  } catch {
    dbPath = active.dbPath;
    port = DEFAULT_PORT;
  }

  const rawDb = initDatabase(dbPath);
  const db = createSqliteAdapter(rawDb);

  const workspaceId = await resolveWorkspaceId(db);
  if (!workspaceId) {
    console.error(
      `No workspace row found in ${dbPath}. ` +
        `Run "ohwow" once to finish onboarding, or "ohwow workspace use <name>" to focus a workspace.`,
    );
    process.exit(1);
  }

  const kind: TargetKind = parsed.kindOverride ?? guessKind(parsed.name);
  const target: ShowcaseTarget = {
    name: parsed.name,
    kind,
    url: parsed.url ? normalizeUrl(parsed.url) : undefined,
    company: parsed.company,
    email: parsed.email,
  };

  const dashboardUrl = `http://localhost:${port}`;

  const instance = render(
    React.createElement(ShowcaseWizard, {
      db,
      rawDb,
      workspaceId,
      workspaceName: active.name,
      dashboardUrl,
      ollamaModel,
      target,
    }),
  );
  const cleanup = () => {
    instance.unmount();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await instance.waitUntilExit();
  process.exit(0);
}
