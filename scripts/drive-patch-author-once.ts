/**
 * drive-patch-author-once — manual one-shot driver for
 * PatchAuthorExperiment.probe + judge + intervene.
 *
 * Opens the active workspace's runtime.db (read/write, NOT the
 * daemon's handle — make sure the daemon is not mid-write), builds
 * a minimal ExperimentContext with a real ModelRouter, and calls
 * the experiment once. Used for the first autonomous-patch trial so
 * we don't have to wait 6h for the scheduled cadence.
 *
 * Safety: this script does NOT touch the kill switches. If the
 * patch-author switch is closed the experiment will no-op; if it's
 * open the normal safeSelfCommit (Layers 1-9) will fire, so every
 * safety gate still applies.
 */

import { initDatabase } from '../src/db/init.js';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createRpcHandlers } from '../src/db/rpc-handlers.js';
import { loadConfig, resolveActiveWorkspace } from '../src/config.js';
import { ModelRouter } from '../src/execution/model-router.js';
import { PatchAuthorExperiment } from '../src/self-bench/experiments/patch-author.js';
import { setSelfCommitRepoRoot } from '../src/self-bench/self-commit.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExperimentContext } from '../src/self-bench/experiment-types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[drive] workspace=${resolveActiveWorkspace().name}  db=${config.dbPath}`);

  const rawDb = initDatabase(config.dbPath);
  const rpcHandlers = createRpcHandlers(rawDb);
  const db = createSqliteAdapter(rawDb, { rpcHandlers });

  const modelRouter = new ModelRouter({
    anthropicApiKey: config.anthropicApiKey || undefined,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    quickModel: config.quickModel || undefined,
    ocrModel: config.ocrModel || undefined,
    preferLocalModel: config.preferLocalModel,
    modelSource: config.modelSource,
    cloudProvider: config.cloudProvider,
    openRouterApiKey: config.openRouterApiKey || undefined,
    openRouterModel: config.openRouterModel || undefined,
    openaiCompatibleUrl: config.openaiCompatibleUrl || undefined,
    openaiCompatibleApiKey: config.openaiCompatibleApiKey || undefined,
    claudeCodeCliPath: config.claudeCodeCliPath || undefined,
    claudeCodeCliModel: config.claudeCodeCliModel || undefined,
  });

  // Point self-commit at this repo root (the scripts/ parent).
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  setSelfCommitRepoRoot(repoRoot);
  console.log(`[drive] repoRoot=${repoRoot}`);

  const workspaceSlug = resolveActiveWorkspace().name;

  // Minimal engine shim — PatchAuthorExperiment only reads engine.modelRouter.
  const engineShim = { modelRouter } as unknown as ExperimentContext['engine'];

  const ctx: ExperimentContext = {
    db,
    workspaceId: workspaceSlug,
    workspaceSlug,
    engine: engineShim,
    recentFindings: async () => [],
    scheduler: undefined,
  };

  const exp = new PatchAuthorExperiment();
  console.log('[drive] probe()…');
  const probe = await exp.probe(ctx);
  console.log(`[drive] probe summary: ${probe.summary}`);

  const verdict = exp.judge(probe, []);
  console.log(`[drive] verdict: ${verdict}`);

  if (verdict !== 'warning') {
    console.log('[drive] nothing to intervene on; exiting');
    return;
  }

  console.log('[drive] intervene()…');
  const t0 = Date.now();
  const result = await exp.intervene(verdict, probe, ctx);
  const dt = Date.now() - t0;
  console.log(`[drive] intervene finished in ${dt}ms`);
  console.log(`[drive] description: ${result?.description}`);
  console.log('[drive] details:', JSON.stringify(result?.details, null, 2));
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error('[drive] fatal:', err);
    process.exit(1);
  },
);
