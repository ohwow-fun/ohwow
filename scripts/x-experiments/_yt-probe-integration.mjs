/**
 * YouTube upload integration test — uses _yt-browser.mjs to upload a
 * test Short as UNLISTED. Verifies the full flow works deterministically.
 *
 * Run: node --import tsx scripts/x-experiments/_yt-probe-integration.mjs
 */
import { ensureYTReady, uploadShort } from './_yt-browser.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const testVideo = path.join(os.tmpdir(), 'ohwow-yt-test.mp4');
if (!fs.existsSync(testVideo)) {
  execSync(`ffmpeg -y -f lavfi -i "color=c=black:s=1080x1920:d=5" -c:v libx264 -preset ultrafast -crf 28 "${testVideo}" 2>/dev/null`, { timeout: 15000 });
}

async function main() {
  console.log('[yt-test] connecting to YouTube Studio...');
  const { browser, page } = await ensureYTReady();

  console.log('[yt-test] uploading test Short (unlisted)...');
  const result = await uploadShort(page, {
    filePath: testVideo,
    title: 'ohwow integration test — delete me',
    description: 'Automated integration test. Safe to delete.',
    visibility: 'unlisted',
    screenshot: true,
  });

  console.log('[yt-test] result:', JSON.stringify(result, null, 2));

  if (result.videoUrl) {
    console.log(`[yt-test] SUCCESS: ${result.videoUrl}`);
  } else {
    console.log('[yt-test] WARNING: upload completed but no video URL extracted');
  }

  browser.close();
}

main().catch(err => {
  console.error('[yt-test] fatal:', err.message);
  process.exit(1);
});
