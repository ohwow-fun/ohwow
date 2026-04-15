import { listProfiles } from '../../src/execution/browser/chrome-lifecycle.ts';
for (const p of listProfiles()) {
  console.log(`${p.directory.padEnd(12)} | ${(p.email || '-').padEnd(30)} | local=${p.localProfileName || '-'} | gaia=${p.gaiaName || '-'}`);
}
