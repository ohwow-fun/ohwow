/**
 * YouTube Studio CDP probe — explore the upload flow deterministically.
 *
 * Phase 2: Channel exists. Map the Create → Upload → form → publish flow.
 *
 * Run: node --import tsx scripts/x-experiments/_yt-probe.mjs
 */
import { RawCdpBrowser } from '../../src/execution/browser/raw-cdp.ts';
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP_PORT = 9222;
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let shotIndex = 0;
async function shot(page, label) {
  shotIndex++;
  const name = `yt-probe-${String(shotIndex).padStart(2, '0')}-${label}.jpg`;
  const data = await page.screenshotJpeg(80);
  const filepath = path.join(SCREENSHOT_DIR, name);
  fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
  console.log(`[yt] screenshot: ${name}`);
  return filepath;
}

async function findYTTab(browser) {
  const targets = await browser.getTargets();
  const pages = targets.filter(t => t.type === 'page');
  console.log(`[yt] ${pages.length} page targets`);
  for (const p of pages) console.log(`  ${p.url.slice(0, 80)}`);

  // Prefer studio.youtube.com
  let tab = pages.find(t => /studio\.youtube\.com/.test(t.url));
  if (tab) {
    console.log('[yt] found YouTube Studio tab');
    return browser.attachToPage(tab.targetId);
  }

  // Any youtube.com tab
  tab = pages.find(t => /youtube\.com/.test(t.url));
  if (tab) {
    console.log('[yt] found youtube.com tab, navigating to Studio');
    const page = await browser.attachToPage(tab.targetId);
    await page.goto('https://studio.youtube.com');
    await sleep(4000);
    return page;
  }

  // Open new tab in same profile as x.com
  const xTab = pages.find(t => /https:\/\/(x|twitter)\.com/.test(t.url));
  if (xTab?.browserContextId) {
    console.log('[yt] opening Studio in x.com profile context');
    const targetId = await browser.createTargetInContext(xTab.browserContextId, 'https://studio.youtube.com');
    await sleep(4000);
    return browser.attachToPage(targetId);
  }

  throw new Error('no suitable tab or profile context found');
}

async function dumpInteractiveElements(page, label) {
  const info = await page.evaluate(`(() => {
    const els = [];
    // Buttons
    for (const b of document.querySelectorAll('button, [role="button"], ytcp-button, tp-yt-paper-button, tp-yt-paper-icon-button')) {
      const text = (b.textContent || '').trim().slice(0, 60);
      const ariaLabel = b.getAttribute('aria-label') || '';
      const id = b.id || '';
      if (!text && !ariaLabel && !id) continue;
      els.push({ type: 'button', tag: b.tagName, id, ariaLabel, text, visible: b.offsetParent !== null });
    }
    // Inputs
    for (const i of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
      els.push({
        type: 'input',
        tag: i.tagName,
        inputType: i.type || '',
        id: i.id || '',
        name: i.name || '',
        placeholder: i.placeholder || '',
        ariaLabel: i.getAttribute('aria-label') || '',
        accept: i.accept || '',
      });
    }
    // Menu items
    for (const m of document.querySelectorAll('[role="menuitem"], tp-yt-paper-item, ytcp-text-menu-item')) {
      const text = (m.textContent || '').trim().slice(0, 60);
      if (text) els.push({ type: 'menuitem', tag: m.tagName, text, id: m.id || '' });
    }
    return els;
  })()`);
  console.log(`\n[yt] === ${label} — interactive elements ===`);
  for (const el of info) {
    console.log(`  ${el.type}: ${JSON.stringify(el)}`);
  }
  return info;
}

async function main() {
  console.log('[yt] connecting to CDP...');
  const browser = await RawCdpBrowser.connect(`http://localhost:${CDP_PORT}`, 5000);

  const page = await findYTTab(browser);
  await page.installUnloadEscapes();

  // Step 1: Navigate to Studio
  const currentUrl = await page.url();
  console.log(`[yt] current URL: ${currentUrl}`);
  if (!/studio\.youtube\.com/.test(currentUrl)) {
    console.log('[yt] navigating to YouTube Studio...');
    await page.goto('https://studio.youtube.com');
    await sleep(4000);
  }
  await shot(page, 'studio-landing');
  const studioUrl = await page.url();
  console.log(`[yt] Studio URL: ${studioUrl}`);
  await dumpInteractiveElements(page, 'Studio Landing');

  // Step 2: Click Create button
  console.log('\n[yt] === Clicking CREATE button ===');
  let clicked = await page.clickSelector('#create-icon');
  if (!clicked) clicked = await page.clickSelector('[aria-label="Create"]');
  if (!clicked) clicked = await page.clickSelector('ytcp-button#create-icon');
  if (!clicked) {
    // Studio has a different create button
    clicked = await page.evaluate(`(() => {
      const btns = document.querySelectorAll('button, [role="button"], ytcp-button');
      for (const b of btns) {
        const text = (b.textContent || '').trim();
        const label = b.getAttribute('aria-label') || '';
        if (/^create$/i.test(text) || /^create$/i.test(label) || /upload/i.test(text + label)) {
          b.click();
          return true;
        }
      }
      return false;
    })()`);
  }
  console.log(`[yt] create button clicked: ${clicked}`);
  await sleep(2000);
  await shot(page, 'after-create');
  await dumpInteractiveElements(page, 'After Create Click');

  // Step 3: Click "Upload videos" menu item
  console.log('\n[yt] === Looking for Upload videos option ===');
  const uploadClicked = await page.evaluate(`(() => {
    const items = document.querySelectorAll('[role="menuitem"], tp-yt-paper-item, ytcp-text-menu-item, a, [role="option"]');
    for (const item of items) {
      const text = (item.textContent || '').trim();
      if (/upload video/i.test(text)) {
        item.click();
        return text;
      }
    }
    // Also try links
    const links = document.querySelectorAll('a[href*="upload"]');
    for (const l of links) {
      l.click();
      return 'link: ' + l.href;
    }
    return null;
  })()`);
  console.log(`[yt] upload option clicked: ${uploadClicked}`);
  await sleep(3000);
  await shot(page, 'upload-dialog');

  // Step 4: Probe the upload dialog in detail
  console.log('\n[yt] === Upload dialog deep probe ===');
  const dialogInfo = await page.evaluate(`(() => {
    const info = {};

    // Dialogs
    const dialogs = document.querySelectorAll('[role="dialog"], ytcp-uploads-dialog, ytcp-dialog');
    info.dialogs = Array.from(dialogs).map(d => ({
      tag: d.tagName,
      id: d.id || '',
      ariaLabel: d.getAttribute('aria-label') || '',
      classes: d.className?.slice?.(0, 120) || '',
      visible: d.offsetParent !== null || d.style?.display !== 'none',
    }));

    // File inputs (even hidden ones)
    const fileInputs = document.querySelectorAll('input[type="file"]');
    info.fileInputs = Array.from(fileInputs).map(f => ({
      id: f.id || '',
      name: f.name || '',
      accept: f.accept || '',
      multiple: f.multiple,
      hidden: f.hidden || f.style?.display === 'none',
    }));

    // Drop zones
    const dropZones = document.querySelectorAll('[id*="drop"], [class*="drop"], [id*="upload"], [class*="upload-area"]');
    info.dropZones = Array.from(dropZones).slice(0, 5).map(d => ({
      tag: d.tagName,
      id: d.id || '',
      text: (d.textContent || '').trim().slice(0, 100),
    }));

    // Select files button
    const selectBtns = document.querySelectorAll('#select-files-button, [id*="select-files"], [id*="choose-files"]');
    info.selectButtons = Array.from(selectBtns).map(b => ({
      tag: b.tagName,
      id: b.id || '',
      text: (b.textContent || '').trim().slice(0, 60),
    }));

    // Page title for context
    info.title = document.title;
    info.url = window.location.href;

    return info;
  })()`);
  console.log(`[yt] dialog probe:`, JSON.stringify(dialogInfo, null, 2));
  await dumpInteractiveElements(page, 'Upload Dialog');

  // Step 5: If we have a file input, note its selector for later use
  if (dialogInfo.fileInputs?.length > 0) {
    console.log('\n[yt] === FILE INPUT FOUND ===');
    console.log('[yt] We can use CDP DOM.setFileInputFiles to upload programmatically');
    for (const fi of dialogInfo.fileInputs) {
      console.log(`  input: id="${fi.id}" accept="${fi.accept}" multiple=${fi.multiple}`);
    }
  }

  await shot(page, 'final');
  console.log('\n[yt] === Probe complete ===');
  browser.close();
}

main().catch(err => {
  console.error('[yt] fatal:', err.message);
  process.exit(1);
});
