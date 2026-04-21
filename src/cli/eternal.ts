/* eslint-disable no-console */
/**
 * `ohwow eternal` — inspect and manually control the Eternal Systems mode.
 *
 * Subcommands:
 *   status         Print current EternalState (mode, last activity, days since active).
 *   conservative   Manually set mode to conservative.
 *   normal         Restore normal mode.
 *   init           Interactive wizard to configure eternal.config.json.
 */

function printHelp(): void {
  console.log('Usage:');
  console.log('  ohwow eternal status          Show current eternal mode and activity');
  console.log('  ohwow eternal conservative    Manually enter conservative mode');
  console.log('  ohwow eternal normal          Restore normal mode');
  console.log('  ohwow eternal init            Interactive setup wizard');
}

async function runInit(configDir: string): Promise<void> {
  const { createInterface } = await import('node:readline');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  console.log('\nEternal Systems setup\n');

  const corpusPath = (
    await ask('Path to your values corpus file (leave blank to skip): ')
  ).trim();

  const conservativeRaw = (
    await ask('Days of inactivity before conservative mode [7]: ')
  ).trim();
  const conservativeAfterDays = conservativeRaw ? parseInt(conservativeRaw, 10) : 7;

  const estateRaw = (
    await ask('Days of inactivity before estate mode [90]: ')
  ).trim();
  const estateAfterDays = estateRaw ? parseInt(estateRaw, 10) : 90;

  rl.close();

  const spec = {
    ...(corpusPath ? { valuesCorpusPath: corpusPath } : {}),
    inactivityProtocol: {
      conservativeAfterDays: Number.isNaN(conservativeAfterDays) ? 7 : conservativeAfterDays,
      trusteePingAfterDays: Number.isNaN(conservativeAfterDays) ? 7 : conservativeAfterDays,
      estateAfterDays: Number.isNaN(estateAfterDays) ? 90 : estateAfterDays,
    },
  };

  mkdirSync(configDir, { recursive: true });
  const outPath = join(configDir, 'eternal.config.json');
  writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n', 'utf-8');

  console.log(`\nSaved to ${outPath}`);
  console.log(`Conservative mode after ${spec.inactivityProtocol.conservativeAfterDays} days of inactivity.`);
  console.log(`Estate mode after ${spec.inactivityProtocol.estateAfterDays} days of inactivity.`);
}

export async function runEternalCli(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    process.exit(sub ? 0 : 1);
  }

  if (sub !== 'status' && sub !== 'conservative' && sub !== 'normal' && sub !== 'init') {
    console.error(`Unknown eternal subcommand: ${sub}`);
    printHelp();
    process.exit(1);
  }

  // Lazy-load runtime deps so --help works without touching the DB.
  const { loadConfig } = await import('../config.js');
  const { dirname } = await import('node:path');

  const config = loadConfig();

  if (sub === 'init') {
    await runInit(dirname(config.dbPath));
    process.exit(0);
  }

  const { initDatabase } = await import('../db/init.js');
  const { createSqliteAdapter } = await import('../db/sqlite-adapter.js');
  const { getEternalState, setEternalMode } = await import('../eternal/index.js');

  const rawDb = initDatabase(config.dbPath);
  const db = createSqliteAdapter(rawDb);

  if (sub === 'status') {
    const state = await getEternalState(db);
    const now = Date.now();
    let daysSince: string;
    if (state.lastActivityAt) {
      const ms = now - Date.parse(state.lastActivityAt);
      daysSince = (ms / 86_400_000).toFixed(1);
    } else {
      daysSince = 'never';
    }

    console.log(`Mode:             ${state.mode}`);
    console.log(`Last activity:    ${state.lastActivityAt ?? '(none)'}`);
    console.log(`Days since active: ${daysSince}`);
    if (state.modeChangedAt) {
      console.log(`Mode changed:     ${state.modeChangedAt}`);
      console.log(`Change reason:    ${state.modeChangedReason ?? ''}`);
    }
    process.exit(0);
  }

  if (sub === 'conservative') {
    await setEternalMode(db, 'conservative', 'manual: operator CLI');
    console.log('Eternal mode set to conservative. The conductor will skip autonomous ticks.');
    console.log('Run "ohwow eternal normal" to restore.');
    process.exit(0);
  }

  if (sub === 'normal') {
    await setEternalMode(db, 'normal', 'manual: operator CLI');
    console.log('Eternal mode restored to normal.');
    process.exit(0);
  }
}
