#!/usr/bin/env node
/**
 * yt-selector-audit — check every selector in selectors.ts against live Studio.
 *
 * Runs each SEL.* entry through document.querySelectorAll and prints a
 * table with mount-count and first-element-visible flag. Use when a
 * downstream flow starts failing to pinpoint which specific selector
 * drifted vs just "the whole page is broken".
 *
 * Some selectors only mount in specific states (e.g. UPLOAD_FILE_INPUT
 * needs the upload dialog open, VISIBILITY_RADIOS need the wizard on
 * step 3). The audit reports them as 0-count, which is correct for the
 * default state — use FLOW=upload to exercise the wizard first.
 *
 * Env:
 *   FLOW=upload   open the upload dialog before auditing (covers more selectors)
 *   JSON=1        emit raw JSON instead of the human table
 *
 * Run: node --import tsx scripts/x-experiments/yt-selector-audit.mjs
 */
import { ensureYTStudio, SEL } from '../../src/integrations/youtube/index.ts';
import { openUploadDialog, closeAnyOpenDialog } from '../../src/integrations/youtube/upload/open-dialog.js';

const FLOW = process.env.FLOW || 'base';
const AS_JSON = process.env.JSON === '1';

function categorize(key) {
  if (key.startsWith('UPLOAD_')) return 'upload';
  if (key.startsWith('VISIBILITY_')) return 'visibility';
  if (key.startsWith('META_')) return 'metadata';
  if (key.startsWith('WIZARD_')) return 'wizard';
  if (key.startsWith('DIALOG_')) return 'dialog';
  if (key.startsWith('AUTH_')) return 'auth';
  if (key.startsWith('CHALLENGE_')) return 'challenge';
  if (key.startsWith('VIDEO_')) return 'video';
  if (key.startsWith('ANALYTICS_')) return 'analytics';
  if (key.startsWith('CHANNEL_')) return 'channel';
  if (key.startsWith('SHORTS_') || key.startsWith('WATCH_')) return 'url';
  return 'other';
}

async function run() {
  const session = await ensureYTStudio({ throwOnChallenge: true });
  try {
    if (FLOW === 'upload') {
      await openUploadDialog(session.page);
    }

    const entries = Object.entries(SEL);
    const results = [];
    for (const [key, selector] of entries) {
      const probe = await session.page.evaluate(`(() => {
        try {
          const els = document.querySelectorAll(${JSON.stringify(selector)});
          const first = els[0];
          let visible = false;
          if (first) {
            if (first.offsetParent !== null) {
              const r = first.getBoundingClientRect();
              visible = r.width > 0 && r.height > 0;
            }
          }
          return { ok: true, count: els.length, visible, firstText: first ? (first.textContent || '').replace(/\\s+/g, ' ').slice(0, 60).trim() : null };
        } catch (e) { return { ok: false, err: String(e) }; }
      })()`);
      results.push({ key, category: categorize(key), selector, ...probe });
    }

    if (FLOW === 'upload') {
      await closeAnyOpenDialog(session.page);
    }

    if (AS_JSON) {
      console.log(JSON.stringify({ flow: FLOW, url: session.health.url, results }, null, 2));
    } else {
      console.log(`\nAUDIT: flow=${FLOW}  url=${session.health.url}\n`);
      const byCat = results.reduce((acc, r) => { (acc[r.category] ||= []).push(r); return acc; }, {});
      for (const [cat, rs] of Object.entries(byCat)) {
        console.log(`## ${cat}`);
        for (const r of rs) {
          const flag = !r.ok ? '?' : r.count === 0 ? '-' : r.visible ? '✓' : '·';
          const detail = !r.ok ? `ERR ${r.err}` : `count=${r.count} visible=${r.visible}${r.firstText ? ` text="${r.firstText}"` : ''}`;
          console.log(`  ${flag} ${r.key.padEnd(34)} ${detail}`);
        }
        console.log('');
      }
      const notFound = results.filter((r) => r.ok && r.count === 0).length;
      const errors = results.filter((r) => !r.ok).length;
      const mounted = results.filter((r) => r.ok && r.count > 0).length;
      console.log(`summary: ${mounted} mounted, ${notFound} not-found (state-dependent), ${errors} errors`);
    }
  } finally {
    session.browser.close();
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err), stack: err?.stack }, null, 2));
  process.exit(3);
});
