/**
 * Deterministic Chrome + YouTube Studio session for yt-experiments scripts.
 *
 * ensureYTReady() guarantees: debug Chrome running on :9222 with a
 * studio.youtube.com tab that has a logged-in session. Returns a
 * RawCdpPage ready for upload operations.
 *
 * uploadShort({ filePath, title, description, visibility }) drives the
 * full upload wizard: inject file → fill details → navigate to visibility
 * → select visibility → publish. Returns the video URL on success.
 *
 * Used by: yt-compose (upcoming).
 */
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP_PORT = 9222;
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');

// --- Helpers ---------------------------------------------------------------

async function saveScreenshot(page, name) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const data = await page.screenshotJpeg(80);
  const filepath = path.join(SCREENSHOT_DIR, `yt-${name}.jpg`);
  fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
  return filepath;
}

// --- ensureYTReady ---------------------------------------------------------

async function findOrOpenYTStudioTab(browser) {
  const targets = await browser.getTargets();
  const pages = targets.filter(t => t.type === 'page');

  // Prefer existing Studio tab
  const studioTab = pages.find(t => /studio\.youtube\.com/.test(t.url));
  if (studioTab) {
    return browser.attachToPage(studioTab.targetId);
  }

  // Open Studio in the same profile context as x.com
  const xTab = pages.find(t => /https:\/\/(x|twitter)\.com/.test(t.url));
  if (xTab?.browserContextId) {
    const targetId = await browser.createTargetInContext(
      xTab.browserContextId,
      'https://studio.youtube.com'
    );
    await sleep(5000);
    return browser.attachToPage(targetId);
  }

  // Last resort: open without context
  await browser.send('Target.createTarget', { url: 'https://studio.youtube.com' });
  await sleep(5000);
  const refreshed = await browser.getTargets();
  const newTab = refreshed.find(t => t.type === 'page' && /studio\.youtube\.com/.test(t.url));
  if (newTab) return browser.attachToPage(newTab.targetId);
  throw new Error('could not open YouTube Studio tab');
}

/**
 * Returns { browser, page } with a live YouTube Studio tab.
 * Reuses existing Chrome debug session on :9222.
 */
export async function ensureYTReady() {
  const browser = await RawCdpBrowser.connect(`http://localhost:${CDP_PORT}`, 5000);
  const page = await findOrOpenYTStudioTab(browser);
  await page.installUnloadEscapes();

  // Make sure we're on Studio (not regular youtube.com)
  const url = await page.url();
  if (!/studio\.youtube\.com/.test(url)) {
    await page.goto('https://studio.youtube.com');
    await sleep(4000);
  }

  return { browser, page };
}

// --- Upload flow -----------------------------------------------------------

async function closeDialogs(page) {
  // Close any open upload dialog
  await page.evaluate(`(() => {
    const btn = document.querySelector('#ytcp-uploads-dialog-close-button button');
    if (btn && btn.offsetParent !== null) { btn.click(); return 'closed'; }
    return 'none';
  })()`);
  await sleep(800);
  // Discard if prompted
  await page.evaluate(`(() => {
    const btn = document.querySelector('[aria-label="Discard"], #discard-button button');
    if (btn) { btn.click(); return 'discarded'; }
    return 'none';
  })()`);
  await sleep(800);
}

async function openUploadDialog(page) {
  await closeDialogs(page);

  // Click Create
  await page.clickSelector('[aria-label="Create"]');
  await sleep(1500);

  // Click "Upload videos"
  const clicked = await page.evaluate(`(() => {
    const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"]');
    for (const item of items) {
      if (/upload video/i.test(item.textContent || '')) {
        item.click();
        return true;
      }
    }
    return false;
  })()`);
  if (!clicked) throw new Error('could not find "Upload videos" menu item');
  await sleep(2000);

  // Verify dialog opened
  const hasFileInput = await page.evaluate(`!!document.querySelector('input[type="file"][name="Filedata"]')`);
  if (!hasFileInput) throw new Error('upload dialog did not open (no file input)');
}

async function injectFile(page, filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`video file not found: ${filePath}`);

  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: 0 });
  const result = await page.send('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"][name="Filedata"]',
  });

  if (result.nodeIds.length > 0) {
    await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: result.nodeIds[0] });
    return;
  }

  // Shadow DOM fallback
  const objResult = await page.send('Runtime.evaluate', {
    expression: `document.querySelector('input[type="file"][name="Filedata"]')`,
    returnByValue: false,
  });
  if (objResult.result?.objectId) {
    const domNode = await page.send('DOM.requestNode', { objectId: objResult.result.objectId });
    await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: domNode.nodeId });
    return;
  }

  throw new Error('could not find file input in upload dialog');
}

async function fillTitle(page, title) {
  await page.evaluate(`(() => {
    const textbox = document.querySelector('#title-textarea #textbox');
    if (!textbox) throw new Error('title textbox not found');
    textbox.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(title)});
  })()`);
}

async function fillDescription(page, desc) {
  await page.evaluate(`(() => {
    const textbox = document.querySelector('#description-textarea #textbox');
    if (!textbox) return;
    textbox.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(desc)});
  })()`);
}

async function setNotMadeForKids(page) {
  await page.evaluate(`(() => {
    const radios = document.querySelectorAll('tp-yt-paper-radio-button');
    for (const r of radios) {
      if (r.name === 'VIDEO_MADE_FOR_KIDS_NOT_MFK') { r.click(); return; }
    }
    for (const r of radios) {
      if (/not made for kids/i.test(r.textContent || '')) { r.click(); return; }
    }
  })()`);
}

async function clickNext(page) {
  // There can be two #next-button elements; click the visible one
  const clicked = await page.evaluate(`(() => {
    const btns = document.querySelectorAll('#next-button');
    for (const b of btns) {
      if (b.offsetParent !== null) {
        const inner = b.querySelector('button');
        if (inner) { inner.click(); return true; }
        b.click();
        return true;
      }
    }
    return false;
  })()`);
  if (!clicked) throw new Error('Next button not found or not visible');
  await sleep(1500);
}

async function getCurrentStepIndex(page) {
  return page.evaluate(`(() => {
    const badges = document.querySelectorAll('[id^="step-badge-"]');
    for (const b of badges) {
      if (b.getAttribute('aria-selected') === 'true') {
        return parseInt(b.id.replace('step-badge-', ''), 10);
      }
    }
    return -1;
  })()`);
}

async function selectVisibility(page, visibility) {
  const nameMap = { private: 'PRIVATE', unlisted: 'UNLISTED', public: 'PUBLIC' };
  const radioName = nameMap[visibility.toLowerCase()];
  if (!radioName) throw new Error(`invalid visibility: ${visibility}`);

  await page.evaluate(`(() => {
    const radios = document.querySelectorAll('tp-yt-paper-radio-button');
    for (const r of radios) {
      if (r.name === ${JSON.stringify(radioName)}) { r.click(); return; }
    }
    throw new Error('visibility radio not found: ' + ${JSON.stringify(radioName)});
  })()`);
  await sleep(500);
}

async function clickSave(page) {
  const clicked = await page.evaluate(`(() => {
    const btns = document.querySelectorAll('#done-button');
    for (const b of btns) {
      if (b.offsetParent !== null && !b.hasAttribute('disabled')) {
        const inner = b.querySelector('button');
        if (inner && !inner.disabled) { inner.click(); return true; }
        b.click();
        return true;
      }
    }
    return false;
  })()`);
  if (!clicked) throw new Error('Save/Publish button not clickable');
  await sleep(3000);
}

async function extractVideoUrl(page) {
  return page.evaluate(`(() => {
    // Prefer Shorts URL (9:16 uploads are Shorts)
    const shortsLinks = document.querySelectorAll('a[href*="youtube.com/shorts/"]');
    for (const l of shortsLinks) return l.href;

    // Fallback: any youtube link
    const links = document.querySelectorAll('a[href*="youtu.be/"], a[href*="youtube.com/watch"]');
    for (const l of links) return l.href;

    // Text fallback
    const allText = document.querySelector('ytcp-uploads-dialog')?.textContent || '';
    const match = allText.match(/https:\\/\\/(?:www\\.)?youtube\\.com\\/shorts\\/([\\w-]+)/);
    if (match) return match[0];
    const match2 = allText.match(/https:\\/\\/youtu\\.be\\/([\\w-]+)/);
    if (match2) return match2[0];
    return null;
  })()`);
}

/**
 * Upload a Short to YouTube via Studio.
 *
 * @param {RawCdpPage} page - Attached Studio page from ensureYTReady()
 * @param {Object} opts
 * @param {string} opts.filePath - Absolute path to MP4 (9:16 = auto-Short)
 * @param {string} opts.title - Video title (max 100 chars)
 * @param {string} [opts.description] - Video description (max 5000 chars)
 * @param {'private'|'unlisted'|'public'} [opts.visibility='unlisted'] - Publish visibility
 * @param {boolean} [opts.screenshot=false] - Save screenshots at each step
 * @returns {{ videoUrl: string|null, visibility: string }}
 */
export async function uploadShort(page, { filePath, title, description = '', visibility = 'unlisted', screenshot = false }) {
  const sc = screenshot ? (label) => saveScreenshot(page, label) : () => {};

  // Step 1: Open upload dialog
  await openUploadDialog(page);
  await sc('01-dialog-open');

  // Step 2: Inject file
  await injectFile(page, filePath);
  await sleep(5000); // Wait for upload to start + auto-save
  await sc('02-file-injected');

  // Step 3: Fill details
  await fillTitle(page, title);
  if (description) await fillDescription(page, description);
  await setNotMadeForKids(page);
  await sleep(1000);
  await sc('03-details-filled');

  // Step 4: Navigate to Visibility (3 × Next)
  let step = await getCurrentStepIndex(page);
  while (step < 3) {
    await clickNext(page);
    step = await getCurrentStepIndex(page);
    if (step === -1) throw new Error('lost track of wizard steps');
  }
  await sc('04-visibility');

  // Step 5: Select visibility
  await selectVisibility(page, visibility);
  await sleep(500);
  await sc('05-visibility-selected');

  // Extract video URL before publishing (it's visible in the sidebar)
  const videoUrl = await extractVideoUrl(page);

  // Step 6: Save/Publish
  await clickSave(page);
  await sc('06-published');

  // Wait for the processing confirmation dialog, then close it
  await sleep(2000);
  await page.evaluate(`(() => {
    // Close the "Video processing" confirmation dialog
    const closeBtn = document.querySelector('ytcp-prechecks-warning-dialog #close-button button, tp-yt-paper-dialog [aria-label="Close"]');
    if (closeBtn) { closeBtn.click(); return 'closed confirmation'; }
    // Or a generic Close button on any visible dialog
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if (b.textContent.trim() === 'Close' && b.offsetParent !== null) {
        b.click();
        return 'closed generic';
      }
    }
    return 'none';
  })()`);

  return { videoUrl, visibility };
}

// --- Cleanup ---------------------------------------------------------------

/**
 * Close the upload dialog without publishing. Handles the discard confirmation.
 */
export async function cancelUpload(page) {
  await closeDialogs(page);
}
