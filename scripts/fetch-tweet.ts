#!/usr/bin/env node
/**
 * CLI wrapper around src/integrations/x/fetch-tweet. Prints the tweet as
 * JSON to stdout. Useful for quick debugging and shell-scripted
 * enrichment flows that don't want to go through MCP.
 *
 * Usage:
 *   npx tsx scripts/fetch-tweet.ts <permalink-or-id>
 *   npx tsx scripts/fetch-tweet.ts https://x.com/shannholmberg/status/2044523795206029525
 *   npx tsx scripts/fetch-tweet.ts 2044523795206029525
 *
 * Exit codes:
 *   0 — tweet found, printed
 *   1 — no arg provided / unparseable id / tweet not found
 *   2 — network or syndication error
 */

import { fetchXPost } from '../src/integrations/x/fetch-tweet.js';

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write('usage: npx tsx scripts/fetch-tweet.ts <permalink-or-id>\n');
    process.exit(1);
  }
  try {
    const post = await fetchXPost(input);
    if (!post) {
      process.stderr.write('tweet not found (private, deleted, or unparseable id)\n');
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(post, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

main();
