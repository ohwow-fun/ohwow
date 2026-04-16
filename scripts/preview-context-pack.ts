/**
 * Operator-facing preview of the cross-domain context pack the
 * autonomous patch-author sees before every LLM call.
 *
 * Run:    npx tsx scripts/preview-context-pack.ts
 *         npx tsx scripts/preview-context-pack.ts --workspace=avenued
 *
 * Prints each <context> block with its byte budget so the operator
 * can see exactly what sales state, goals, rejections, and roadmap
 * excerpts are flowing into the model's prompt. Useful for:
 *   - confirming the pack picks up newly-shipped sources
 *   - spotting when a section is empty (missing signal upstream)
 *   - catching bloat before it blows the model's context window
 *
 * Read-only. Opens the workspace's runtime.db to hydrate the
 * runtime_config cache + find the consolidated workspace row id,
 * then tears the adapter down.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { workspaceLayoutFor } from '../src/config.js';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { refreshRuntimeConfigCache } from '../src/self-bench/runtime-config.js';
import { buildContextPack } from '../src/self-bench/context-pack.js';

async function main() {
  const args = process.argv.slice(2);
  const workspaceArg = args.find((a) => a.startsWith('--workspace='));
  const workspace = workspaceArg ? workspaceArg.split('=')[1] : 'default';

  const layout = workspaceLayoutFor(workspace);
  process.stderr.write(`[preview-context-pack] workspace=${workspace} db=${layout.dbPath}\n`);

  const db = new Database(layout.dbPath, { readonly: true });
  const adapter = createSqliteAdapter(db);
  try {
    await refreshRuntimeConfigCache(adapter);

    // Find the consolidated workspace row id positionally — CLAUDE.md
    // warns against hardcoding 'local' because boot-time consolidation
    // rewrites the seed row's id to the cloud workspace UUID.
    const { data } = await adapter
      .from<{ id: string }>('agent_workforce_workspaces')
      .select('id')
      .limit(1);
    const workspaceId = (data ?? [])[0]?.id ?? null;
    if (!workspaceId) {
      process.stderr.write(
        `[preview-context-pack] no row in agent_workforce_workspaces — goals section will be empty\n`,
      );
    }

    const approvalsPath = path.join(layout.dataDir, 'x-approvals.jsonl');
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const pack = await buildContextPack({
      db: adapter,
      workspaceId: workspaceId ?? 'unknown',
      repoRoot,
      approvalsJsonlPath: approvalsPath,
    });

    const summary = pack.summary();
    const totalBytes = summary.reduce((a, s) => a + s.bytes, 0);
    process.stderr.write(
      `[preview-context-pack] sections: ${summary.length}, total bytes: ${totalBytes}\n`,
    );
    for (const s of summary) {
      process.stderr.write(`  - ${s.name}: ${s.bytes} bytes\n`);
    }
    process.stderr.write('\n');
    process.stdout.write(pack.toPromptString());
    process.stdout.write('\n');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stderr.write(
    `[preview-context-pack] failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
