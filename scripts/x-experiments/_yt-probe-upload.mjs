/**
 * YouTube Studio CDP probe — Phase 2: Upload flow.
 *
 * Creates a minimal test MP4, injects it via CDP DOM.setFileInputFiles,
 * then maps every step of the metadata form (title, description, visibility).
 *
 * Run: node --import tsx scripts/x-experiments/_yt-probe-upload.mjs
 */
import { RawCdpBrowser } from '../../src/execution/browser/raw-cdp.ts';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP_PORT = 9222;
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let shotIndex = 0;
async function shot(page, label) {
  shotIndex++;
  const name = `yt-upload-${String(shotIndex).padStart(2, '0')}-${label}.jpg`;
  const data = await page.screenshotJpeg(80);
  const filepath = path.join(SCREENSHOT_DIR, name);
  fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
  console.log(`[yt] screenshot: ${name}`);
  return filepath;
}

function createTestVideo() {
  const testPath = path.join(os.tmpdir(), 'ohwow-yt-test.mp4');
  if (fs.existsSync(testPath)) return testPath;
  // Create a minimal 5-second 9:16 black video with ffmpeg
  try {
    execSync(`ffmpeg -y -f lavfi -i "color=c=black:s=1080x1920:d=5" -f lavfi -i "anullsrc=r=44100:cl=mono" -t 5 -c:v libx264 -preset ultrafast -crf 28 -c:a aac -shortest "${testPath}" 2>/dev/null`, { timeout: 15000 });
    console.log(`[yt] test video created: ${testPath}`);
  } catch (e) {
    console.log(`[yt] ffmpeg failed, trying without audio`);
    execSync(`ffmpeg -y -f lavfi -i "color=c=black:s=1080x1920:d=5" -c:v libx264 -preset ultrafast -crf 28 "${testPath}" 2>/dev/null`, { timeout: 15000 });
  }
  return testPath;
}

async function findStudioTab(browser) {
  const targets = await browser.getTargets();
  const tab = targets.find(t => t.type === 'page' && /studio\.youtube\.com/.test(t.url));
  if (tab) return browser.attachToPage(tab.targetId);
  throw new Error('no YouTube Studio tab found — run _yt-probe.mjs first');
}

async function openUploadDialog(page) {
  // Close any existing dialogs first
  await page.evaluate(`(() => {
    const closeBtn = document.querySelector('#ytcp-uploads-dialog-close-button button, ytcp-uploads-dialog [aria-label="Close"]');
    if (closeBtn) closeBtn.click();
  })()`);
  await sleep(1000);

  // Click Create
  await page.clickSelector('[aria-label="Create"]');
  await sleep(1500);

  // Click Upload videos
  await page.evaluate(`(() => {
    const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"]');
    for (const item of items) {
      if (/upload video/i.test(item.textContent || '')) {
        item.click();
        return true;
      }
    }
    return false;
  })()`);
  await sleep(2000);
}

async function injectFileViaCdp(page, browser, filePath) {
  console.log(`[yt] injecting file via CDP: ${filePath}`);

  // Method: Use Runtime to get the file input's object ID, then DOM.setFileInputFiles
  // First, we need to get the DOM node ID of the file input
  const nodeInfo = await page.evaluate(`(() => {
    const input = document.querySelector('input[type="file"][name="Filedata"]');
    if (!input) return null;
    return { found: true, id: input.id, name: input.name };
  })()`);
  console.log(`[yt] file input:`, nodeInfo);

  if (!nodeInfo) {
    console.log('[yt] ERROR: no file input found');
    return false;
  }

  // Get the DOM document and query for the file input
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: 0 });
  const searchResult = await page.send('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"][name="Filedata"]',
  });
  console.log(`[yt] found ${searchResult.nodeIds.length} file inputs by DOM query`);

  if (searchResult.nodeIds.length === 0) {
    // Try shadow DOM approach
    console.log('[yt] trying to resolve through shadow DOM...');
    const objectId = await page.send('Runtime.evaluate', {
      expression: `document.querySelector('input[type="file"][name="Filedata"]')`,
      returnByValue: false,
    });
    if (objectId.result?.objectId) {
      console.log(`[yt] got objectId: ${objectId.result.objectId.slice(0, 30)}...`);
      // Resolve to DOM node
      const domNode = await page.send('DOM.requestNode', { objectId: objectId.result.objectId });
      console.log(`[yt] resolved to DOM nodeId: ${domNode.nodeId}`);

      await page.send('DOM.setFileInputFiles', {
        files: [filePath],
        nodeId: domNode.nodeId,
      });
      console.log('[yt] file set via DOM.setFileInputFiles (objectId path)');
      return true;
    }
    return false;
  }

  // Use the first matching nodeId
  await page.send('DOM.setFileInputFiles', {
    files: [filePath],
    nodeId: searchResult.nodeIds[0],
  });
  console.log('[yt] file set via DOM.setFileInputFiles');
  return true;
}

async function probeMetadataForm(page) {
  console.log('\n[yt] === Probing metadata form ===');

  const formInfo = await page.evaluate(`(() => {
    const info = {};

    // Title input
    const titleInputs = document.querySelectorAll('#title-textarea, #textbox[aria-label*="title" i], [aria-label*="Title" i], ytcp-social-suggestions-textbox');
    info.titleInputs = Array.from(titleInputs).map(t => ({
      tag: t.tagName,
      id: t.id || '',
      ariaLabel: t.getAttribute('aria-label') || '',
      text: (t.textContent || '').trim().slice(0, 80),
      contentEditable: t.contentEditable || '',
    }));

    // Description input
    const descInputs = document.querySelectorAll('#description-textarea, [aria-label*="description" i], #description-container');
    info.descInputs = Array.from(descInputs).map(d => ({
      tag: d.tagName,
      id: d.id || '',
      ariaLabel: d.getAttribute('aria-label') || '',
      contentEditable: d.contentEditable || '',
    }));

    // Visibility / privacy radio buttons
    const radios = document.querySelectorAll('[name="VIDEO_MADE_FOR_KIDS_MFK"], tp-yt-paper-radio-button, [role="radio"]');
    info.radios = Array.from(radios).map(r => ({
      tag: r.tagName,
      name: r.name || '',
      text: (r.textContent || '').trim().slice(0, 60),
      checked: r.checked || r.getAttribute('aria-checked') === 'true',
    }));

    // Stepper/tabs (Details, Video elements, Checks, Visibility)
    const steps = document.querySelectorAll('tp-yt-paper-tab, #step-badge-0, #step-badge-1, #step-badge-2, #step-badge-3, [id*="step-title"]');
    info.steps = Array.from(steps).map(s => ({
      tag: s.tagName,
      id: s.id || '',
      text: (s.textContent || '').trim().slice(0, 40),
      ariaSelected: s.getAttribute('aria-selected') || '',
    }));

    // Next/Done/Publish buttons
    const actionBtns = document.querySelectorAll('#next-button, #done-button, #save-button, #back-button');
    info.actionBtns = Array.from(actionBtns).map(b => ({
      tag: b.tagName,
      id: b.id,
      text: (b.textContent || '').trim().slice(0, 40),
      disabled: b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true',
      visible: b.offsetParent !== null,
    }));

    // Upload progress
    const progress = document.querySelectorAll('.progress-bar, [class*="progress"], ytcp-video-upload-progress, #processing-status');
    info.progress = Array.from(progress).slice(0, 5).map(p => ({
      tag: p.tagName,
      id: p.id || '',
      text: (p.textContent || '').trim().slice(0, 80),
      classes: p.className?.slice?.(0, 80) || '',
    }));

    // Any error messages
    const errors = document.querySelectorAll('[class*="error"], [id*="error"]');
    info.errors = Array.from(errors).filter(e => e.offsetParent !== null).slice(0, 3).map(e => ({
      text: (e.textContent || '').trim().slice(0, 100),
      id: e.id || '',
    }));

    // Page state
    info.url = window.location.href;
    info.title = document.title;

    return info;
  })()`);

  for (const [key, val] of Object.entries(formInfo)) {
    if (Array.isArray(val) && val.length > 0) {
      console.log(`[yt] ${key}:`, JSON.stringify(val, null, 2));
    } else if (!Array.isArray(val)) {
      console.log(`[yt] ${key}: ${val}`);
    }
  }

  return formInfo;
}

async function probeVisibilityStep(page) {
  console.log('\n[yt] === Probing visibility step ===');

  const visInfo = await page.evaluate(`(() => {
    const info = {};

    // Visibility radio buttons
    const radios = document.querySelectorAll('tp-yt-paper-radio-button, [role="radio"]');
    info.visibilityOptions = Array.from(radios).map(r => ({
      tag: r.tagName,
      name: r.name || '',
      text: (r.textContent || '').trim().slice(0, 80),
      checked: r.getAttribute('aria-checked') === 'true' || r.hasAttribute('checked'),
      id: r.id || '',
    }));

    // Schedule options
    const scheduleEls = document.querySelectorAll('[id*="schedule"], [class*="schedule"]');
    info.schedule = Array.from(scheduleEls).slice(0, 5).map(s => ({
      tag: s.tagName,
      id: s.id || '',
      text: (s.textContent || '').trim().slice(0, 60),
    }));

    // Publish / Save button state
    const doneBtn = document.querySelector('#done-button');
    info.doneButton = doneBtn ? {
      text: (doneBtn.textContent || '').trim(),
      disabled: doneBtn.hasAttribute('disabled'),
      visible: doneBtn.offsetParent !== null,
    } : null;

    return info;
  })()`);
  console.log('[yt] visibility info:', JSON.stringify(visInfo, null, 2));
  return visInfo;
}

async function main() {
  // Step 0: Create test video
  const testVideo = createTestVideo();
  console.log(`[yt] test video: ${testVideo} (${(fs.statSync(testVideo).size / 1024).toFixed(0)}KB)`);

  // Connect
  console.log('[yt] connecting to CDP...');
  const browser = await RawCdpBrowser.connect(`http://localhost:${CDP_PORT}`, 5000);
  const page = await findStudioTab(browser);
  await page.installUnloadEscapes();

  const currentUrl = await page.url();
  console.log(`[yt] current URL: ${currentUrl}`);

  // Step 1: Open upload dialog
  console.log('\n[yt] === Opening upload dialog ===');
  await openUploadDialog(page);
  await shot(page, 'upload-dialog');

  // Step 2: Inject test video file
  console.log('\n[yt] === Injecting test video ===');
  const injected = await injectFileViaCdp(page, browser, testVideo);
  if (!injected) {
    console.log('[yt] FAILED to inject file');
    browser.close();
    return;
  }

  // Wait for upload to start processing
  console.log('[yt] waiting for upload to process...');
  await sleep(5000);
  await shot(page, 'after-inject');

  // Step 3: Probe the metadata form
  const formInfo = await probeMetadataForm(page);
  await shot(page, 'metadata-form');

  // Step 4: Try to navigate through steps
  // Check if Next button is available
  if (formInfo.actionBtns?.some(b => b.id === 'next-button' && b.visible)) {
    console.log('\n[yt] === Step navigation available ===');

    // Fill title first
    const titleFilled = await page.evaluate(`(() => {
      // YouTube Studio title is inside a contenteditable div inside #title-textarea
      const textbox = document.querySelector('#title-textarea #textbox, #title-textarea [contenteditable="true"]');
      if (textbox) {
        textbox.focus();
        textbox.textContent = '';
        document.execCommand('insertText', false, 'ohwow test upload - delete me');
        return 'filled via contenteditable';
      }
      // Fallback: try input
      const input = document.querySelector('#title-textarea input, [aria-label*="Title"] input');
      if (input) {
        input.value = 'ohwow test upload - delete me';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled via input';
      }
      return null;
    })()`);
    console.log(`[yt] title fill result: ${titleFilled}`);
    await shot(page, 'title-filled');

    // Click Next through steps to reach Visibility
    for (let step = 1; step <= 3; step++) {
      console.log(`\n[yt] === Clicking Next (step ${step}) ===`);
      const nextClicked = await page.clickSelector('#next-button');
      console.log(`[yt] next clicked: ${nextClicked}`);
      await sleep(2000);
      await shot(page, `step-${step + 1}`);

      // Dump step content
      const stepContent = await page.evaluate(`(() => {
        const steps = document.querySelectorAll('[id*="step-title"], tp-yt-paper-tab');
        const active = Array.from(steps).find(s => s.getAttribute('aria-selected') === 'true' || s.classList?.contains('iron-selected'));
        return {
          activeStep: active ? active.textContent.trim() : 'unknown',
          stepTexts: Array.from(steps).map(s => ({
            text: s.textContent.trim().slice(0, 30),
            selected: s.getAttribute('aria-selected') === 'true',
          })),
        };
      })()`);
      console.log(`[yt] active step:`, stepContent.activeStep);
    }

    // Now we should be on Visibility step
    await probeVisibilityStep(page);
    await shot(page, 'visibility-step');
  }

  console.log('\n[yt] === Upload probe complete ===');
  console.log('[yt] DO NOT publish — close the dialog manually or let it sit');
  console.log('[yt] Check screenshots/ for the full flow');

  browser.close();
}

main().catch(err => {
  console.error('[yt] fatal:', err.message);
  process.exit(1);
});
