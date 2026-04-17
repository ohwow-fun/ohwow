#!/usr/bin/env node
/**
 * Single-shot DOM probe for Studio's playlist picker.
 *
 * Goal: discover selectors for playlist support (Phase 2c) without
 * spamming the channel. The picker lives on the wizard's Details step
 * behind the Audience section's "Show more" expander. We need to see
 * the DOM shape of:
 *   - "Show more" expander (button, aria-label, mount state)
 *   - Playlist field trigger (closed-state chip + label)
 *   - Playlist picker dialog (root, listbox of rows, search input,
 *     "New playlist" affordance, Done/Cancel buttons)
 *   - Per-row attributes (name, checkbox state, id — the thing we'll
 *     cache in yt-playlists.json)
 *
 * Round-trip cost: one throwaway draft. Flow:
 *   1. uploadShort({ dryRun: true }) on briefing-dryrun-v4.mp4 with a
 *      probe-identifier title. Studio auto-saves as draft.
 *   2. findDraftIdByTitle → videoId.
 *   3. Reopen via resume URL (udvid=…) so we land on Details.
 *   4. Dump DOM in three phases, each separated by a human-paced click:
 *        phase A: pristine Details (look for playlist field + Show more)
 *        phase B: after Show more expand (if it was collapsed)
 *        phase C: after clicking the playlist trigger (picker open)
 *   5. deleteDraft to clean up.
 *
 * Pure read, apart from the staged/deleted draft. Run ONCE — channel
 * is still cooling off from the 2026-04-17 rate-limit warning. Output
 * goes to stderr (human-readable dump) + stdout (JSON for tooling).
 *
 * Flags:
 *   --mp4=<path>      override test mp4 (default briefing-dryrun-v4.mp4)
 *   --identity=<id>   pin channel (handle or UC-id)
 *   --keep            skip the deleteDraft at the end (operator will clean up)
 *   --yes             skip interactive confirm (needed in non-TTY)
 *
 * Exit codes:
 *   0 probe completed
 *   1 preflight (mp4 missing, session unhealthy)
 *   2 user declined
 *   3 runtime (wizard / probe / delete failed)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  deleteDraft,
  ensureYTStudio,
  findDraftIdByTitle,
  uploadShort,
} from '../../src/integrations/youtube/index.ts';
import { humanClickAt, sleepRandom } from '../../src/integrations/youtube/upload/human.ts';
import { waitForSelector } from '../../src/integrations/youtube/wait.ts';

const VIDEO_PKG = path.resolve('packages/video');
const DEFAULT_MP4 = path.join(VIDEO_PKG, 'out/briefing-dryrun-v4.mp4');

function parseArgs(argv) {
  const out = { flags: new Set(), kv: {} };
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) {
      const [k, ...rest] = a.slice(2).split('=');
      out.kv[k] = rest.join('=');
    } else if (a.startsWith('--')) {
      out.flags.add(a.slice(2));
    }
  }
  return out;
}

async function confirmTty(prompt) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => rl.question(prompt, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// The in-page probe payload. Runs via page.evaluate at three phases.
// Returns a structured dump we'll pretty-print to stderr and emit as JSON.
// ---------------------------------------------------------------------------
const PROBE_JS = `(() => {
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const classStr = typeof el.className === 'string' ? el.className
                   : (el.className?.baseVal ?? '');
    const attrs = [];
    for (const a of el.attributes || []) {
      // Trim long values so the dump doesn't explode.
      attrs.push(a.name + '="' + String(a.value).slice(0, 120) + '"');
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: classStr ? String(classStr).slice(0, 120) : null,
      visible: el.offsetParent !== null,
      text: (el.textContent || '').trim().slice(0, 160),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      attrs: attrs.slice(0, 20),
    };
  };

  const out = { url: location.href, now: new Date().toISOString() };

  // 1. Anything with "playlist" in the tag name (custom elements).
  out.customTagMatches = [];
  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (!tag.includes('playlist')) continue;
    if (!tag.startsWith('ytcp-') && !tag.startsWith('tp-yt-') && !tag.startsWith('yt-')) continue;
    out.customTagMatches.push(describe(el));
    if (out.customTagMatches.length > 40) break;
  }

  // 2. Anything with "playlist" in id.
  out.idMatches = [];
  for (const el of document.querySelectorAll('[id]')) {
    if (!/playlist/i.test(el.id)) continue;
    out.idMatches.push(describe(el));
    if (out.idMatches.length > 40) break;
  }

  // 3. Labels / headings whose text says "Playlists" or "Playlist".
  out.labelMatches = [];
  for (const el of document.querySelectorAll('div, span, label, h1, h2, h3, h4, ytcp-form-input-container, ytcp-form-section-header')) {
    if (el.children.length > 3) continue;
    const t = (el.textContent || '').trim();
    if (!/^playlists?$/i.test(t) && !/add.*playlist/i.test(t)) continue;
    const d = describe(el);
    if (!d.visible) continue;
    // Walk up a few parents so we can locate the form-row container.
    let p = el.parentElement;
    const chain = [];
    for (let i = 0; i < 6 && p; i += 1) {
      chain.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : ''));
      p = p.parentElement;
    }
    d.parentChain = chain;
    out.labelMatches.push(d);
    if (out.labelMatches.length > 20) break;
  }

  // 4. Audience "Show more" / "Show less" buttons (anywhere — filter by text).
  out.showMoreMatches = [];
  for (const el of document.querySelectorAll('button, [role="button"], ytcp-button, tp-yt-paper-button, paper-button')) {
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim().toLowerCase();
    if (!/show\\s+(more|less)/i.test(label)) continue;
    out.showMoreMatches.push(describe(el));
    if (out.showMoreMatches.length > 10) break;
  }

  // 5. Any open dialog / popup (picker candidates).
  out.openDialogs = [];
  for (const el of document.querySelectorAll('tp-yt-paper-dialog, ytcp-dialog, [role="dialog"]')) {
    if (el.offsetParent === null) continue;
    const d = describe(el);
    // Include the first-level children labels so we can see the dialog's shape.
    d.children = [];
    for (const c of el.children) {
      d.children.push({ tag: c.tagName.toLowerCase(), id: c.id || null, text: (c.textContent || '').trim().slice(0, 80) });
      if (d.children.length > 12) break;
    }
    out.openDialogs.push(d);
  }

  // 6. Visible listbox + checkbox rows (picker body).
  out.listboxes = [];
  for (const el of document.querySelectorAll('tp-yt-paper-listbox, [role="listbox"]')) {
    if (el.offsetParent === null) continue;
    const d = describe(el);
    d.itemsSample = [];
    const items = el.querySelectorAll('tp-yt-paper-checkbox, ytcp-checkbox-lit, tp-yt-paper-item, [role="option"], [role="checkbox"]');
    for (const item of items) {
      if (item.offsetParent === null) continue;
      const ir = item.getBoundingClientRect();
      d.itemsSample.push({
        tag: item.tagName.toLowerCase(),
        id: item.id || null,
        text: (item.textContent || '').trim().slice(0, 60),
        checked: item.hasAttribute('checked') || item.getAttribute('aria-checked') === 'true',
        rect: { x: Math.round(ir.left), y: Math.round(ir.top), w: Math.round(ir.width), h: Math.round(ir.height) },
        attrs: [...item.attributes].map(a => a.name + '="' + String(a.value).slice(0, 60) + '"').slice(0, 10),
      });
      if (d.itemsSample.length > 8) break;
    }
    out.listboxes.push(d);
    if (out.listboxes.length > 4) break;
  }

  // 7. Any visible search / text input inside an open dialog.
  out.dialogInputs = [];
  for (const el of document.querySelectorAll('[role="dialog"] input, tp-yt-paper-dialog input, ytcp-dialog input, [role="dialog"] tp-yt-paper-input')) {
    if (el.offsetParent === null) continue;
    out.dialogInputs.push(describe(el));
    if (out.dialogInputs.length > 6) break;
  }

  return out;
})()`;

function sectionHeader(title) {
  process.stderr.write(`\n=== ${title} ===\n`);
}

function dumpPhase(label, dump) {
  sectionHeader(label);
  process.stderr.write(`url: ${dump.url}\n`);
  const sections = ['customTagMatches', 'idMatches', 'labelMatches', 'showMoreMatches', 'openDialogs', 'listboxes', 'dialogInputs'];
  for (const key of sections) {
    const rows = dump[key] || [];
    process.stderr.write(`\n-- ${key} (${rows.length}) --\n`);
    for (const r of rows) {
      process.stderr.write(JSON.stringify(r, null, 2) + '\n');
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Two probe modes:
  //   (default)        open the /video/<id>/edit page for the most recent
  //                    public video and probe its Audience/playlist DOM.
  //                    No staging, no cleanup — safest and simplest path.
  //                    The Audience section + playlist picker Polymer
  //                    components are shared with the upload wizard
  //                    (same story as thumbnail.ts).
  //   --stage          stage a throwaway draft via uploadShort, reopen via
  //                    udvid=… so we land on the wizard's Details step,
  //                    probe, then deleteDraft. Use when the edit-page
  //                    DOM differs and we need wizard-specific selectors.
  const stageMode = args.flags.has('stage');

  const mp4Path = path.resolve(args.kv.mp4 || DEFAULT_MP4);
  if (stageMode && !fs.existsSync(mp4Path)) {
    console.error(`[probe] mp4 not found: ${mp4Path}`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = `Playlist Probe ${stamp} (delete me)`;

  console.error('[probe] plan:');
  console.error(`  mode       ${stageMode ? 'stage (wizard on fresh draft)' : 'edit-page (existing video)'}`);
  if (stageMode) {
    console.error(`  mp4        ${mp4Path}  (${(fs.statSync(mp4Path).size / 1024 / 1024).toFixed(1)} MB)`);
    console.error(`  title      ${title}`);
    console.error(`  keep       ${args.flags.has('keep') ? 'YES (operator deletes manually)' : 'no (auto deleteDraft)'}`);
  } else if (args.kv['edit-video']) {
    console.error(`  video      ${args.kv['edit-video']}`);
  } else {
    console.error('  video      (most recent uploaded, autodetected)');
  }

  if (!args.flags.has('yes')) {
    const ok = await confirmTty('[probe] run probe now? Type \'y\': ');
    if (!ok) {
      console.error('[probe] declined.');
      process.exit(2);
    }
  }

  const session = await ensureYTStudio({ identity: args.kv.identity, throwOnChallenge: true });
  const { page } = session;
  let videoId = args.kv['edit-video'] ?? null;

  try {
    const flags = session.health.accountFlags || {};
    if (flags.hasUnacknowledgedCopyrightTakedown || flags.hasUnacknowledgedTouStrike) {
      console.error('[probe] account flags set — refusing.');
      process.exit(1);
    }
    console.error(`[probe] session ok. channel=${session.health.channelId ?? '(unknown)'}`);

    if (stageMode) {
      // --- STAGE -------------------------------------------------------------
      console.error('[probe] staging throwaway draft…');
      await uploadShort(page, {
        filePath: mp4Path,
        title,
        description: 'Probe run — safe to delete.',
        visibility: 'unlisted',
        dryRun: true,
        onStage: (ev) => process.stderr.write(
          `  [stage] ${ev.stage} ${ev.ok ? 'ok' : 'FAIL'} ${ev.durationMs}ms${ev.error ? ' — ' + ev.error : ''}\n`,
        ),
      });

      // --- RESOLVE videoId ---------------------------------------------------
      console.error('[probe] resolving draft videoId…');
      videoId = await findDraftIdByTitle(page, {
        channelId: session.health.channelId,
        titleContains: title.slice(0, 40),
      });
      if (!videoId) {
        console.error('[probe] could not resolve draft videoId. Inspect Studio Content → Drafts and clean up manually.');
        process.exit(3);
      }
      console.error(`[probe] draft videoId = ${videoId}`);

      // --- REOPEN on Details -------------------------------------------------
      const resumeUrl = `https://studio.youtube.com/channel/${session.health.channelId}/videos/upload?d=ud&udvid=${videoId}`;
      await page.goto(resumeUrl);
      await sleepRandom(1_500, 2_500);
    } else {
      // --- EDIT-PAGE MODE ----------------------------------------------------
      if (!videoId) {
        console.error('[probe] autodetecting most recent video…');
        await page.goto(`https://studio.youtube.com/channel/${session.health.channelId}/videos/upload`);
        await sleepRandom(2_000, 3_000);
        videoId = await page.evaluate(`(() => {
          const row = document.querySelector('ytcp-video-row');
          if (!row) return null;
          const m = (row.outerHTML || '').match(/i\\d*\\.ytimg\\.com\\/vi\\/([\\w-]{11})\\//);
          return m ? m[1] : null;
        })()`);
        if (!videoId) {
          console.error('[probe] could not autodetect a video. Pass --edit-video=<id>.');
          process.exit(3);
        }
        console.error(`[probe] autodetected videoId = ${videoId}`);
      }
      const editUrl = `https://studio.youtube.com/video/${videoId}/edit`;
      console.error(`[probe] opening edit page: ${editUrl}`);
      await page.goto(editUrl);
      // Wait for the title box to mount — canary for the edit page loading.
      await waitForSelector(page, '#title-textarea #textbox', {
        timeoutMs: 12_000,
        label: 'edit page title box',
      });
      await sleepRandom(1_500, 2_500);
    }

    // --- PHASE A: pristine Details ----------------------------------------
    const phaseA = await page.evaluate(PROBE_JS);
    dumpPhase('PHASE A — pristine Details', phaseA);

    // --- PHASE B: after expanding "Show more" (if any) --------------------
    let phaseB = null;
    const showMoreCoords = await page.evaluate(`(() => {
      for (const el of document.querySelectorAll('button, [role="button"], ytcp-button, tp-yt-paper-button, paper-button')) {
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim().toLowerCase();
        if (!/show\\s+more/i.test(label)) continue;
        if (el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    })()`);
    if (showMoreCoords) {
      console.error('[probe] clicking Show more…');
      await humanClickAt(page, showMoreCoords.x, showMoreCoords.y);
      await sleepRandom(600, 1_200);
      phaseB = await page.evaluate(PROBE_JS);
      dumpPhase('PHASE B — after Show more expand', phaseB);
    } else {
      console.error('[probe] no Show more button visible (section may already be expanded, or naming has drifted)');
    }

    // --- PHASE C: after opening playlist picker ---------------------------
    // Find the playlist field trigger by scanning for a button/chip with
    // "playlist" in its label or its nearest preceding label text.
    let phaseC = null;
    const pickerOpenCoords = await page.evaluate(`(() => {
      // Strategy: find a visible button / dropdown whose own text or nearest
      // ancestor form-row header says "Playlist" / "Playlists" / "Add playlist".
      const candidates = [];
      for (const el of document.querySelectorAll('ytcp-text-dropdown-trigger, ytcp-form-input-container button, ytcp-button, tp-yt-paper-button, [role="button"]')) {
        if (el.offsetParent === null) continue;
        const selfText = (el.textContent || '').trim();
        if (/playlist/i.test(selfText) || /add.*playlist/i.test(selfText)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          candidates.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, reason: 'selfText', tag: el.tagName.toLowerCase() });
          continue;
        }
        // Walk up to form-row, check its header text.
        let p = el.parentElement;
        for (let i = 0; i < 6 && p; i += 1) {
          const header = p.querySelector?.('ytcp-form-input-container, .title, [slot="title"]');
          const ht = (header?.textContent || '').trim();
          if (/^playlists?$/i.test(ht)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) break;
            candidates.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, reason: 'ancestor:' + p.tagName.toLowerCase(), tag: el.tagName.toLowerCase() });
            break;
          }
          p = p.parentElement;
        }
      }
      return candidates[0] || null;
    })()`);
    if (pickerOpenCoords) {
      console.error(`[probe] clicking playlist trigger (${pickerOpenCoords.reason}, tag=${pickerOpenCoords.tag})…`);
      await humanClickAt(page, pickerOpenCoords.x, pickerOpenCoords.y);
      await sleepRandom(900, 1_800);
      phaseC = await page.evaluate(PROBE_JS);
      dumpPhase('PHASE C — after playlist picker open', phaseC);
    } else {
      console.error('[probe] playlist trigger not found. Phase B dump is the endpoint.');
    }

    // Emit structured JSON for tooling / diff-by-eye.
    console.log(JSON.stringify({
      ok: true,
      videoId,
      phaseA,
      phaseB,
      phaseC,
    }, null, 2));

    // --- CLEANUP ----------------------------------------------------------
    if (!stageMode) {
      console.error('[probe] edit-page mode — nothing to clean up (no edits were saved).');
    } else if (args.flags.has('keep')) {
      console.error(`[probe] --keep set. Draft ${videoId} left on channel. Delete manually when done.`);
    } else {
      console.error('[probe] deleting draft…');
      await deleteDraft(page, { videoId });
      console.error('[probe] cleanup ok.');
    }
  } catch (err) {
    console.error(`[probe] error: ${err?.message ?? err}`);
    if (stageMode && videoId) {
      console.error(`[probe] leftover draft may exist: ${videoId}`);
      console.error(`  clean up: node --import tsx scripts/yt-experiments/_publish-briefing.mjs --delete-draft=${videoId}`);
    }
    process.exit(3);
  } finally {
    if (session.ownsBrowser) session.browser.close();
  }
}

main().catch((err) => {
  console.error('[probe] fatal', err);
  process.exit(1);
});
