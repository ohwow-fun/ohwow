/**
 * scripts/autonomy-tick.ts — fire one Conductor tick by hand.
 *
 * Usage: tsx scripts/autonomy-tick.ts
 *
 * Loads the active workspace's DB, builds a Conductor with the stub
 * executor + default DirectorIO, and invokes `conductorTick` once. Prints
 * the result and exits. Used by humans to test the wiring without flipping
 * OHWOW_AUTONOMY_CONDUCTOR globally — set the flag inline:
 *   OHWOW_AUTONOMY_CONDUCTOR=1 tsx scripts/autonomy-tick.ts
 */
import { initDatabase } from '../src/db/init.js';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { resolveActiveWorkspace } from '../src/config.js';
import { conductorTick, defaultMakeStubExecutor } from '../src/autonomy/conductor.js';
import { defaultDirectorIO } from '../src/autonomy/director.js';

async function main(): Promise<void> {
  const ws = resolveActiveWorkspace();
  const rawDb = initDatabase(ws.dbPath);
  const db = createSqliteAdapter(rawDb);
  const io = defaultDirectorIO({ db });
  const result = await conductorTick({
    db,
    io,
    workspace_id: ws.name,
    makeExecutor: defaultMakeStubExecutor,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  rawDb.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
