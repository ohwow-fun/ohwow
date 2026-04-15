/**
 * Open x.com/home in the ohwow.fun Chrome profile (Profile 1) and
 * print the resulting CDP targetId + browserContextId. Re-run is
 * idempotent — openProfileWindow makes a fresh tab every time.
 */
import { openProfileWindow } from '../../src/execution/browser/chrome-lifecycle.ts';

const r = await openProfileWindow({
  profileDir: 'Profile 1',
  url: 'https://x.com/home',
  timeoutMs: 15000,
});
console.log(JSON.stringify(r, null, 2));
