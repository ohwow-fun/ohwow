/**
 * Select (or create) a playlist on the currently open Studio surface.
 *
 * Works on both the upload wizard's Details step and the per-video edit
 * page — the picker is the same `ytcp-playlist-dialog` Polymer component
 * in both places. The trigger (ytcp-video-metadata-playlists) may be
 * hidden behind an "Advanced / Show more" expander on the wizard; we
 * expand any candidate expander before scanning for the trigger, no-op
 * if the trigger is already visible.
 *
 * Contract:
 *   - Idempotent: if the chip already shows `name`, returns early with
 *     the cached id (no picker opened).
 *   - On first match, clicks the checkbox row to toggle selection, then
 *     clicks Done. Returns { playlistId, created: false }.
 *   - On no match + createIfMissing: clicks "New playlist", types `name`,
 *     picks visibility, confirms, then selects the newly-created row and
 *     clicks Done. Returns { playlistId, created: true }.
 *   - On no match + !createIfMissing: closes picker and throws.
 *
 * All clicks go through human.ts helpers — Studio's thumbnail uploader
 * taught us Polymer handlers can reject untrusted events, so every
 * interactive surface in this flow uses Input.dispatchMouseEvent at
 * resolved rect coords.
 *
 * Playlist ids come straight from the `test-id` attribute on each
 * ytcp-checkbox-lit row — Studio renders the YouTube playlist id there
 * (e.g. "PL5rMjg46oY…"). Those ids are the cache key callers can persist
 * to `~/.ohwow/workspaces/<ws>/yt-playlists.json` to skip the find-by-
 * name scan on future runs.
 */

import type { RawCdpPage } from '../../../execution/browser/raw-cdp.js';
import { YTTimeoutError, YTUploadError } from '../errors.js';
import { SEL } from '../selectors.js';
import { waitForPredicate, waitForSelector } from '../wait.js';
import { humanClickAt, humanClickSelector, humanType, sleepRandom } from './human.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Max time to wait for the playlist picker's "New playlist" button to be
 * interactable after clicking the trigger. Empirical on slower first-mount:
 * Studio's Polymer dialog can take 4-7s on a cold profile session, so 4s
 * was too tight. 8s matches the order of magnitude Studio itself takes to
 * render complex pickers; callers who want a clean bail can set
 * `opts.skipPlaylist` (or pass `--no-playlist` to the CLI) instead of
 * relying on the timeout.
 */
const PICKER_INTERACTIVE_TIMEOUT_MS = 8_000;

export type PlaylistVisibility = 'public' | 'unlisted' | 'private';

export interface SelectPlaylistOptions {
  /** Exact playlist name (case-insensitive match against existing rows). */
  name: string;
  /** Create the playlist if no row matches. Default false. */
  createIfMissing?: boolean;
  /** Visibility for a newly-created playlist. Default 'unlisted'. */
  createVisibility?: PlaylistVisibility;
}

export interface SelectPlaylistResult {
  /** YouTube playlist id, e.g. "PL5rMjg46oY…". */
  playlistId: string;
  /** True when the playlist was created during this call. */
  created: boolean;
  /** True when the binding was already in place before this call (no-op). */
  alreadyBound: boolean;
}

/**
 * Expand the Advanced / Show more section if the playlist trigger is
 * not yet visible. Idempotent — returns immediately if the trigger is
 * already on screen.
 */
async function revealTrigger(page: RawCdpPage): Promise<void> {
  const visible = await page.evaluate<boolean>(
    `!!document.querySelector(${JSON.stringify(SEL.PLAYLIST_TRIGGER)}) && document.querySelector(${JSON.stringify(SEL.PLAYLIST_TRIGGER)}).offsetParent !== null`,
  );
  if (visible) return;

  // Find the nearest visible "Show more" / "Show advanced settings"
  // expander and click it.
  const coords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    for (const el of document.querySelectorAll(${JSON.stringify(SEL.PLAYLIST_SHOW_MORE_TOGGLE)})) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  })()`);
  if (!coords) {
    throw new YTUploadError('select_playlist', 'playlist trigger not visible and no Show more expander found');
  }

  await humanClickAt(page, coords.x, coords.y);
  await waitForPredicate(
    page,
    `!!document.querySelector(${JSON.stringify(SEL.PLAYLIST_TRIGGER)}) && document.querySelector(${JSON.stringify(SEL.PLAYLIST_TRIGGER)}).offsetParent !== null`,
    { timeoutMs: 3_000, label: 'playlist trigger visible after expand' },
  );
}

/** Read the chip text (closed-state trigger label) — the names of already-bound playlists. */
async function readChipNames(page: RawCdpPage): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL.PLAYLIST_TRIGGER)});
    if (!el) return [];
    const raw = (el.textContent || '').trim();
    if (!raw) return [];
    // Studio separates multiple bindings with commas when the chip holds
    // more than one. Single-binding is just the playlist name.
    return raw.split(/,\\s*/).map((s) => s.trim()).filter(Boolean);
  })()`);
}

/**
 * Snapshot what the picker subtree actually looks like right now. Used by
 * the timeout-path of openPicker to surface actionable diagnostics in the
 * thrown error: operators should see which selectors matched and which
 * didn't instead of a generic "never held within Nms".
 */
async function readPickerDiag(page: RawCdpPage): Promise<{
  dialogPresent: boolean;
  dialogVisible: boolean;
  newButtonPresent: boolean;
  newButtonVisible: boolean;
  rowsCount: number;
  visibleRowsCount: number;
}> {
  return page.evaluate<{
    dialogPresent: boolean;
    dialogVisible: boolean;
    newButtonPresent: boolean;
    newButtonVisible: boolean;
    rowsCount: number;
    visibleRowsCount: number;
  }>(`(() => {
    const dialog = document.querySelector(${JSON.stringify(SEL.PLAYLIST_PICKER_DIALOG)});
    const newBtn = document.querySelector(${JSON.stringify(SEL.PLAYLIST_NEW_BUTTON)});
    const rows = document.querySelectorAll(${JSON.stringify(SEL.PLAYLIST_ROWS)});
    let visibleRows = 0;
    for (const r of rows) { if (r.offsetParent !== null) visibleRows += 1; }
    return {
      dialogPresent: !!dialog,
      dialogVisible: !!(dialog && dialog.offsetParent !== null),
      newButtonPresent: !!newBtn,
      newButtonVisible: !!(newBtn && newBtn.offsetParent !== null),
      rowsCount: rows.length,
      visibleRowsCount: visibleRows,
    };
  })()`);
}

/** Open the picker. Throws if the dialog fails to mount. */
async function openPicker(page: RawCdpPage): Promise<void> {
  const coords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL.PLAYLIST_TRIGGER)});
    if (!el || el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!coords) throw new YTUploadError('select_playlist', 'playlist trigger not clickable');

  await humanClickAt(page, coords.x, coords.y);

  // Wait for the "New playlist" button to mount AND be visible — Studio
  // renders the outer ytcp-playlist-dialog in the DOM even when closed,
  // so "dialog exists" is not an honest interactive signal. Rows or
  // the New button becoming visible is.
  //
  // If the wait times out, surface the picker's last-seen DOM state
  // (which selectors matched, which were hidden) so a future failure
  // tells the operator what actually happened rather than "never held
  // within Nms". Callers who want to bail cleanly should pass
  // `skipPlaylist: true` at the upload layer (or `--no-playlist` at
  // the CLI).
  try {
    await waitForPredicate(
      page,
      `!!document.querySelector(${JSON.stringify(SEL.PLAYLIST_NEW_BUTTON)}) && document.querySelector(${JSON.stringify(SEL.PLAYLIST_NEW_BUTTON)}).offsetParent !== null`,
      { timeoutMs: PICKER_INTERACTIVE_TIMEOUT_MS, label: 'playlist picker interactive' },
    );
  } catch (err) {
    if (err instanceof YTTimeoutError) {
      let diag: Awaited<ReturnType<typeof readPickerDiag>> | null = null;
      let diagError: string | null = null;
      try {
        diag = await readPickerDiag(page);
      } catch (readErr) {
        diagError = readErr instanceof Error ? readErr.message : String(readErr);
      }
      const diagSummary = diag
        ? `dialog[present=${diag.dialogPresent},visible=${diag.dialogVisible}] `
          + `newButton[present=${diag.newButtonPresent},visible=${diag.newButtonVisible}] `
          + `rows[total=${diag.rowsCount},visible=${diag.visibleRowsCount}]`
        : `diagnostic read failed: ${diagError}`;
      throw new YTUploadError(
        'select_playlist',
        `playlist picker never became interactive within ${PICKER_INTERACTIVE_TIMEOUT_MS}ms (${diagSummary}). `
          + `Pass --no-playlist to skip the playlist step explicitly.`,
        { diag, diagError, timeoutMs: PICKER_INTERACTIVE_TIMEOUT_MS },
      );
    }
    throw err;
  }
}

interface PickerRow {
  id: string;           // playlist id from test-id attribute
  name: string;         // label text
  checked: boolean;
  coords: { x: number; y: number };
}

async function listRows(page: RawCdpPage): Promise<PickerRow[]> {
  return page.evaluate<PickerRow[]>(`(() => {
    const rows = [];
    for (const el of document.querySelectorAll(${JSON.stringify(SEL.PLAYLIST_ROWS)})) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const id = el.getAttribute('test-id') || '';
      if (!id) continue;
      // Label lives at aria-labelledby target — typically #checkbox-label-N.
      let name = '';
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const lbl = document.getElementById(labelledBy);
        if (lbl) name = (lbl.textContent || '').trim();
      }
      if (!name) name = (el.textContent || '').trim();
      const checked = el.hasAttribute('checked') || el.getAttribute('aria-checked') === 'true';
      rows.push({
        id,
        name,
        checked,
        coords: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      });
    }
    return rows;
  })()`);
}

/** Click Done, wait for picker to close. */
async function clickDone(page: RawCdpPage): Promise<void> {
  await humanClickSelector(page, SEL.PLAYLIST_DONE_BUTTON, { label: 'playlist Done' });
  // Dialog tears down async; rows vanish first.
  await waitForPredicate(
    page,
    `(() => {
      const rows = document.querySelectorAll(${JSON.stringify(SEL.PLAYLIST_ROWS)});
      for (const r of rows) { if (r.offsetParent !== null) return false; }
      return true;
    })()`,
    { timeoutMs: 4_000, label: 'playlist picker closed' },
  );
}

/**
 * Create a new playlist via the "New playlist" affordance.
 *
 * Empirical UX (Studio 2026-04): clicking "New playlist" surfaces a
 * small menu with visibility options (Public / Unlisted / Private);
 * picking one opens an inline name field. Some Studio branches skip
 * the menu and present a dialog with a name field + a visibility
 * select. We handle both by scanning for the name input after the
 * click and typing into whichever path materializes, then confirming
 * via the visible "Create" / "Save" button inside the creation UI.
 */
async function createPlaylist(
  page: RawCdpPage,
  name: string,
  visibility: PlaylistVisibility,
): Promise<void> {
  await humanClickSelector(page, SEL.PLAYLIST_NEW_BUTTON, { label: 'New playlist' });
  await sleepRandom(600, 1_200);

  // Path A: a visibility menu appeared — pick matching item.
  const menuCoords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const wanted = ${JSON.stringify(visibility)};
    const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"]');
    for (const el of items) {
      if (el.offsetParent === null) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t.startsWith(wanted)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  })()`);
  if (menuCoords) {
    await humanClickAt(page, menuCoords.x, menuCoords.y);
    await sleepRandom(500, 1_000);
  }

  // Scan for a visible name input that's not the page's global search.
  const inputFound = await waitForPredicate(
    page,
    `(() => {
      const inputs = document.querySelectorAll('ytcp-playlist-dialog input, ytcp-playlist-create-dialog input, tp-yt-paper-input input');
      for (const el of inputs) {
        if (el.offsetParent === null) continue;
        if (el.id === 'query-input') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        return true;
      }
      return false;
    })()`,
    { timeoutMs: 5_000, label: 'playlist name input' },
  ).then(() => true).catch(() => false);

  if (!inputFound) {
    throw new YTUploadError('select_playlist', 'playlist creation input never mounted');
  }

  // Focus + type the name.
  const focused = await page.evaluate<boolean>(`(() => {
    const inputs = document.querySelectorAll('ytcp-playlist-dialog input, ytcp-playlist-create-dialog input, tp-yt-paper-input input');
    for (const el of inputs) {
      if (el.offsetParent === null) continue;
      if (el.id === 'query-input') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      el.focus();
      if (el.value) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    }
    return false;
  })()`);
  if (!focused) throw new YTUploadError('select_playlist', 'could not focus playlist name input');

  await sleepRandom(200, 500);
  await humanType(page, name);
  await sleepRandom(400, 900);

  // Confirm via Create / Save / Done inside the creation UI.
  const confirmCoords = await page.evaluate<{ x: number; y: number } | null>(`(() => {
    const scopes = [
      document.querySelector('ytcp-playlist-create-dialog'),
      document.querySelector('ytcp-playlist-dialog'),
    ].filter(Boolean);
    for (const scope of scopes) {
      const btns = scope.querySelectorAll('ytcp-button, button, tp-yt-paper-button');
      for (const b of btns) {
        if (b.offsetParent === null) continue;
        const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim().toLowerCase();
        if (!/^(create|save)$/i.test(t)) continue;
        const inner = b.querySelector('button');
        const target = (inner && !inner.disabled) ? inner : b;
        const r = target.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  })()`);
  if (!confirmCoords) {
    throw new YTUploadError('select_playlist', 'playlist Create/Save button not found');
  }
  await humanClickAt(page, confirmCoords.x, confirmCoords.y);

  // After confirmation, Studio returns to the picker with the new row
  // visible (and usually pre-checked). Let it settle.
  await waitForSelector(page, SEL.PLAYLIST_ROWS, { timeoutMs: 5_000, label: 'playlist rows after create' });
  await sleep(500);
}

/**
 * Public entry point — the thing upload/index.ts calls during the
 * playlist_set stage, and publishDraft can call before the advance to
 * Visibility if a caller wants to re-bind at publish time.
 */
export async function selectPlaylist(
  page: RawCdpPage,
  opts: SelectPlaylistOptions,
): Promise<SelectPlaylistResult> {
  const wanted = opts.name.trim();
  if (!wanted) throw new YTUploadError('select_playlist', 'playlist name is empty');
  const wantedLower = wanted.toLowerCase();
  const createIfMissing = opts.createIfMissing ?? false;
  const createVisibility = opts.createVisibility ?? 'unlisted';

  await revealTrigger(page);

  // Idempotency: if the chip already shows the target name, don't even
  // open the picker. We still need the playlist id — caller can pass
  // it in via cache (next wiring iteration) or we'll resolve it the
  // next time we open the picker.
  const chipNames = await readChipNames(page);
  if (chipNames.some((n) => n.toLowerCase() === wantedLower)) {
    // Open the picker briefly to resolve the id, then close. A future
    // cache wiring can skip this round-trip entirely.
    await openPicker(page);
    const rows = await listRows(page);
    await clickDone(page);
    const hit = rows.find((r) => r.name.toLowerCase() === wantedLower && r.checked);
    if (hit) {
      return { playlistId: hit.id, created: false, alreadyBound: true };
    }
    // Chip said bound but rows disagree — fall through and rebind.
  }

  await openPicker(page);

  const rows = await listRows(page);
  let match = rows.find((r) => r.name.toLowerCase() === wantedLower);

  if (match) {
    if (!match.checked) {
      await humanClickAt(page, match.coords.x, match.coords.y);
      await sleepRandom(300, 700);
    }
    await clickDone(page);
    return { playlistId: match.id, created: false, alreadyBound: false };
  }

  if (!createIfMissing) {
    await clickDone(page);
    throw new YTUploadError(
      'select_playlist',
      `playlist "${wanted}" not found and createIfMissing is false`,
      { availableNames: rows.map((r) => r.name) },
    );
  }

  await createPlaylist(page, wanted, createVisibility);

  const afterRows = await listRows(page);
  match = afterRows.find((r) => r.name.toLowerCase() === wantedLower);
  if (!match) {
    await clickDone(page);
    throw new YTUploadError('select_playlist', `created playlist "${wanted}" but no matching row appeared`);
  }
  // Newly-created row is typically already checked. Defensive click only
  // if the creation UI didn't auto-bind.
  if (!match.checked) {
    await humanClickAt(page, match.coords.x, match.coords.y);
    await sleepRandom(300, 700);
  }
  await clickDone(page);
  return { playlistId: match.id, created: true, alreadyBound: false };
}
