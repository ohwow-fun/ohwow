/**
 * YouTube Studio CDP probe — Phase 3: Complete upload flow.
 *
 * Navigate through all 4 steps properly, handling "made for kids" and visibility.
 * Does NOT publish — stops at the visibility step and screenshots the state.
 *
 * Run: node --import tsx scripts/x-experiments/_yt-probe-full-flow.mjs
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
  const name = `yt-flow-${String(shotIndex).padStart(2, '0')}-${label}.jpg`;
  const data = await page.screenshotJpeg(80);
  const filepath = path.join(SCREENSHOT_DIR, name);
  fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
  console.log(`[yt] screenshot: ${name}`);
  return filepath;
}

function ensureTestVideo() {
  const testPath = path.join(os.tmpdir(), 'ohwow-yt-test.mp4');
  if (fs.existsSync(testPath)) return testPath;
  execSync(`ffmpeg -y -f lavfi -i "color=c=black:s=1080x1920:d=5" -c:v libx264 -preset ultrafast -crf 28 "${testPath}" 2>/dev/null`, { timeout: 15000 });
  return testPath;
}

async function findStudioTab(browser) {
  const targets = await browser.getTargets();
  const tab = targets.find(t => t.type === 'page' && /studio\.youtube\.com/.test(t.url));
  if (tab) return browser.attachToPage(tab.targetId);
  throw new Error('no YouTube Studio tab found');
}

async function closeExistingDialogs(page) {
  // Close any upload dialog that might be open
  await page.evaluate(`(() => {
    // Close button on upload dialog
    const closeBtn = document.querySelector('#ytcp-uploads-dialog-close-button button');
    if (closeBtn && closeBtn.offsetParent !== null) {
      closeBtn.click();
      return 'closed upload dialog';
    }
    // Welcome dialog
    const welcomeClose = document.querySelector('#welcome-dialog #close-button button');
    if (welcomeClose) {
      welcomeClose.click();
      return 'closed welcome';
    }
    return 'nothing to close';
  })()`);
  await sleep(1000);

  // Handle any confirmation dialog about discarding
  await page.evaluate(`(() => {
    const discardBtn = document.querySelector('[aria-label="Discard"], #discard-button button');
    if (discardBtn) {
      discardBtn.click();
      return 'discarded';
    }
    return 'no discard needed';
  })()`);
  await sleep(1000);
}

async function openUploadDialog(page) {
  await closeExistingDialogs(page);

  // Click Create
  const createClicked = await page.clickSelector('[aria-label="Create"]');
  console.log(`[yt] Create clicked: ${createClicked}`);
  await sleep(1500);

  // Click Upload videos
  const uploadClicked = await page.evaluate(`(() => {
    const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"]');
    for (const item of items) {
      if (/upload video/i.test(item.textContent || '')) {
        item.click();
        return true;
      }
    }
    return false;
  })()`);
  console.log(`[yt] Upload videos clicked: ${uploadClicked}`);
  await sleep(2000);
  return uploadClicked;
}

async function injectFile(page, filePath) {
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: 0 });
  const result = await page.send('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"][name="Filedata"]',
  });

  if (result.nodeIds.length === 0) {
    // Shadow DOM fallback
    const objResult = await page.send('Runtime.evaluate', {
      expression: `document.querySelector('input[type="file"][name="Filedata"]')`,
      returnByValue: false,
    });
    if (objResult.result?.objectId) {
      const domNode = await page.send('DOM.requestNode', { objectId: objResult.result.objectId });
      await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: domNode.nodeId });
      return true;
    }
    return false;
  }

  await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: result.nodeIds[0] });
  return true;
}

async function setTitle(page, title) {
  const result = await page.evaluate(`(() => {
    const textbox = document.querySelector('#title-textarea #textbox');
    if (!textbox) return 'not found';
    textbox.focus();
    // Select all existing text and replace
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(title)});
    return textbox.textContent.trim();
  })()`);
  console.log(`[yt] title set: "${result}"`);
  return result;
}

async function setDescription(page, desc) {
  const result = await page.evaluate(`(() => {
    const textbox = document.querySelector('#description-textarea #textbox');
    if (!textbox) return 'not found';
    textbox.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(desc)});
    return textbox.textContent.trim().slice(0, 60);
  })()`);
  console.log(`[yt] description set: "${result}"`);
  return result;
}

async function setNotMadeForKids(page) {
  const result = await page.evaluate(`(() => {
    // Find the "No, it's not made for kids" radio button
    const radios = document.querySelectorAll('tp-yt-paper-radio-button');
    for (const r of radios) {
      if (r.name === 'VIDEO_MADE_FOR_KIDS_NOT_MFK') {
        r.click();
        return 'clicked NOT_MFK';
      }
    }
    // Fallback: try by text
    for (const r of radios) {
      if (/not made for kids/i.test(r.textContent || '')) {
        r.click();
        return 'clicked by text';
      }
    }
    return 'not found';
  })()`);
  console.log(`[yt] made for kids: ${result}`);
  return result;
}

async function clickNext(page) {
  const clicked = await page.clickSelector('#next-button');
  if (!clicked) {
    // Try the second next button (there are sometimes two)
    await page.evaluate(`(() => {
      const btns = document.querySelectorAll('#next-button');
      for (const b of btns) {
        if (b.offsetParent !== null) {
          b.querySelector('button')?.click() || b.click();
          return true;
        }
      }
      return false;
    })()`);
  }
  return clicked;
}

async function getCurrentStep(page) {
  return page.evaluate(`(() => {
    const badges = document.querySelectorAll('[id^="step-badge-"]');
    for (const b of badges) {
      if (b.getAttribute('aria-selected') === 'true') {
        return { id: b.id, text: b.textContent.trim() };
      }
    }
    // Try checking the step titles
    const titles = document.querySelectorAll('[id^="step-title-"]');
    return { id: 'unknown', text: 'unknown', allSteps: Array.from(titles).map(t => t.textContent.trim()) };
  })()`);
}

async function probeVisibilityOptions(page) {
  return page.evaluate(`(() => {
    const info = {};

    // All radio buttons on the visibility page
    const radios = document.querySelectorAll('tp-yt-paper-radio-button, [role="radio"]');
    info.radios = Array.from(radios).map(r => ({
      name: r.name || r.getAttribute('name') || '',
      text: (r.textContent || '').trim().slice(0, 80),
      checked: r.getAttribute('aria-checked') === 'true' || r.hasAttribute('checked') || r.checked,
      visible: r.offsetParent !== null,
      id: r.id || '',
    })).filter(r => r.visible);

    // The save/publish button
    const doneBtn = document.querySelector('#done-button');
    info.doneButton = doneBtn ? {
      text: (doneBtn.textContent || '').trim(),
      disabled: doneBtn.hasAttribute('disabled') || doneBtn.getAttribute('aria-disabled') === 'true',
      visible: doneBtn.offsetParent !== null,
    } : null;

    // Any schedule-related elements
    const allText = document.querySelector('ytcp-uploads-dialog')?.textContent || '';
    info.hasPublicOption = /public/i.test(allText);
    info.hasUnlistedOption = /unlisted/i.test(allText);
    info.hasPrivateOption = /private/i.test(allText);
    info.hasScheduleOption = /schedule/i.test(allText);

    // Check for the visibility section specifically
    const visSection = document.querySelector('#privacy-radios, [id*="privacy"], .visibility-section');
    info.visSectionFound = !!visSection;
    if (visSection) {
      info.visSectionHTML = visSection.innerHTML?.slice(0, 500) || '';
    }

    return info;
  })()`);
}

async function main() {
  const testVideo = ensureTestVideo();
  console.log(`[yt] test video: ${testVideo}`);

  const browser = await RawCdpBrowser.connect(`http://localhost:${CDP_PORT}`, 5000);
  const page = await findStudioTab(browser);
  await page.installUnloadEscapes();

  // Reload Studio fresh
  console.log('[yt] reloading Studio...');
  await page.goto('https://studio.youtube.com');
  await sleep(4000);
  await shot(page, 'fresh-studio');

  // Open upload dialog
  console.log('\n=== STEP 1: Open upload dialog ===');
  await openUploadDialog(page);
  await shot(page, 'upload-dialog');

  // Inject file
  console.log('\n=== STEP 2: Inject file ===');
  const injected = await injectFile(page, testVideo);
  console.log(`[yt] file injected: ${injected}`);
  await sleep(5000); // Wait for upload + auto-save
  await shot(page, 'file-injected');

  // We're now on "Details" step
  let step = await getCurrentStep(page);
  console.log(`[yt] current step: ${JSON.stringify(step)}`);

  // Set title
  console.log('\n=== STEP 3: Fill details ===');
  await setTitle(page, 'yt probe test — delete me');
  await setDescription(page, 'Automated probe test. Safe to delete.');

  // Set "not made for kids"
  await setNotMadeForKids(page);
  await sleep(1000);
  await shot(page, 'details-filled');

  // Scroll down to make sure audience section is visible
  await page.evaluate(`(() => {
    const scrollContainer = document.querySelector('#scrollable-content, .scrollable-content, ytcp-uploads-dialog #scrollable-content');
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      return 'scrolled';
    }
    return 'no scroll container';
  })()`);
  await sleep(500);
  await shot(page, 'details-scrolled');

  // Navigate: Details → Video elements
  console.log('\n=== STEP 4: Navigate to Video elements ===');
  await clickNext(page);
  await sleep(2000);
  step = await getCurrentStep(page);
  console.log(`[yt] step after 1st Next: ${JSON.stringify(step)}`);
  await shot(page, 'video-elements');

  // Probe what's on Video elements step
  const videoElemInfo = await page.evaluate(`(() => {
    const cards = document.querySelectorAll('ytcp-video-metadata-editor-sidepanel-card, ytcp-card');
    return Array.from(cards).map(c => ({
      tag: c.tagName,
      text: (c.textContent || '').trim().slice(0, 100),
    }));
  })()`);
  console.log(`[yt] video elements cards:`, JSON.stringify(videoElemInfo?.slice(0, 3)));

  // Navigate: Video elements → Checks
  console.log('\n=== STEP 5: Navigate to Checks ===');
  await clickNext(page);
  await sleep(2000);
  step = await getCurrentStep(page);
  console.log(`[yt] step after 2nd Next: ${JSON.stringify(step)}`);
  await shot(page, 'checks');

  // Navigate: Checks → Visibility
  console.log('\n=== STEP 6: Navigate to Visibility ===');
  await clickNext(page);
  await sleep(2000);
  step = await getCurrentStep(page);
  console.log(`[yt] step after 3rd Next: ${JSON.stringify(step)}`);
  await shot(page, 'visibility');

  // Deep probe visibility
  console.log('\n=== STEP 7: Probe visibility options ===');
  const visInfo = await probeVisibilityOptions(page);
  console.log(`[yt] visibility info:`, JSON.stringify(visInfo, null, 2));

  // Scroll the visibility panel
  await page.evaluate(`(() => {
    const scrollable = document.querySelector('#scrollable-content');
    if (scrollable) scrollable.scrollTop = 0;
  })()`);
  await sleep(500);
  await shot(page, 'visibility-top');

  // Dump ALL visible radio buttons with their names
  const allRadios = await page.evaluate(`(() => {
    const all = document.querySelectorAll('tp-yt-paper-radio-button');
    return Array.from(all).map(r => ({
      name: r.name || '',
      text: (r.textContent || '').trim().slice(0, 80),
      checked: r.getAttribute('aria-checked') === 'true',
      visible: r.offsetParent !== null,
      parent: r.parentElement?.id || r.parentElement?.className?.slice(0, 40) || '',
    }));
  })()`);
  console.log(`\n[yt] ALL radio buttons (${allRadios.length}):`);
  for (const r of allRadios) {
    const mark = r.checked ? '●' : '○';
    const vis = r.visible ? '' : ' (hidden)';
    console.log(`  ${mark} name="${r.name}" ${r.text.slice(0, 50)}${vis}`);
  }

  // Check the Save/Publish button
  const saveBtn = await page.evaluate(`(() => {
    const btn = document.querySelector('#done-button');
    if (!btn) return null;
    const inner = btn.querySelector('button');
    return {
      outerText: (btn.textContent || '').trim(),
      innerText: inner ? inner.textContent.trim() : '',
      disabled: btn.hasAttribute('disabled'),
      innerDisabled: inner?.disabled ?? false,
      visible: btn.offsetParent !== null,
      ariaLabel: inner?.getAttribute('aria-label') || '',
    };
  })()`);
  console.log(`\n[yt] Save button:`, JSON.stringify(saveBtn));

  await shot(page, 'final');

  console.log('\n=== PROBE COMPLETE ===');
  console.log('Findings summary:');
  console.log('  - File inject: DOM.setFileInputFiles on input[name="Filedata"]');
  console.log('  - Title: execCommand("insertText") on #title-textarea #textbox');
  console.log('  - Description: execCommand("insertText") on #description-textarea #textbox');
  console.log('  - Not for kids: click tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]');
  console.log('  - Navigation: #next-button × 3 to reach Visibility');
  console.log('  - Publish: #done-button (need to check visibility radio selection)');
  console.log('\n[yt] The test upload is saved as PRIVATE. Delete from Studio > Content.');

  browser.close();
}

main().catch(err => {
  console.error('[yt] fatal:', err.message);
  process.exit(1);
});
