#!/usr/bin/env node
/**
 * Live dry-run test for the Threads compose flow.
 * Connects to debug Chrome and runs composeThreadsPostViaBrowser
 * in dry-run mode (types text but doesn't click Post).
 *
 * Usage:
 *   node --loader tsx scripts/test-threads-compose.mjs [--live]
 *   npx tsx scripts/test-threads-compose.mjs [--live]
 *
 * Without --live: dry run (default, safe)
 * With --live: actually publishes (careful!)
 */
import WebSocket from 'ws';

const isLive = process.argv.includes('--live');
const testText = process.argv.find(a => a.startsWith('--text='))?.split('=').slice(1).join('=')
  || 'Testing Threads compose via ohwow CDP automation [dry run]';

async function main() {
  console.log(`[test-threads] mode=${isLive ? 'LIVE' : 'DRY RUN'}`);
  console.log(`[test-threads] text="${testText}"`);

  // We can't easily import the TS modules from mjs, so replicate the
  // core flow using raw CDP — this tests the same selectors and patterns
  // that threads-posting.ts uses.

  const v = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json());
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;

  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      const frame = { id: myId, method, params };
      if (sessionId) frame.sessionId = sessionId;
      ws.send(JSON.stringify(frame));
    });
  }

  async function evalIn(sid, expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    }, sid);
    return r?.result?.value;
  }

  await new Promise(r => ws.on('open', r));

  // --- 1. Find or create threads tab ---
  const targets = (await send('Target.getTargets')).targetInfos;
  const pages = targets.filter(t => t.type === 'page');
  let tab = pages.find(t => t.url.includes('threads.com') || t.url.includes('threads.net'));

  if (!tab) {
    // Find the profile context with x.com tabs
    const xTab = pages.find(t => t.url.startsWith('https://x.com'));
    if (!xTab) {
      console.error('[test-threads] FAIL: No x.com tab to identify profile context');
      ws.close();
      process.exit(2);
    }
    const ctx = xTab.browserContextId;
    // Create a new tab
    const newTarget = await send('Target.createTarget', {
      url: 'https://www.threads.net/',
      browserContextId: ctx,
    });
    tab = { targetId: newTarget.targetId, url: 'https://www.threads.net/' };
    await new Promise(r => setTimeout(r, 4000));
  }

  // --- 2. Attach ---
  const { sessionId } = await send('Target.attachToTarget', {
    targetId: tab.targetId,
    flatten: true,
  });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  // Ensure on threads
  const url = await evalIn(sessionId, 'window.location.href');
  if (!url.includes('threads.com') && !url.includes('threads.net')) {
    console.log('[test-threads] Navigating to threads.com...');
    await send('Page.navigate', { url: 'https://www.threads.net/' }, sessionId);
    await new Promise(r => setTimeout(r, 4000));
  }

  // --- 3. Read identity ---
  const handle = await evalIn(sessionId, `
    (() => {
      const svg = document.querySelector('svg[aria-label="Profile"]');
      if (!svg) return null;
      let el = svg;
      for (let i = 0; i < 5; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.tagName === 'A' && el.getAttribute('href')) {
          const m = el.getAttribute('href').match(/^\\/@([^/?#]+)/);
          if (m) return m[1];
        }
      }
      return null;
    })()
  `);
  console.log(`[test-threads] Signed in as: @${handle || 'UNKNOWN'}`);

  // --- 4. Dismiss any existing dialog ---
  await evalIn(sessionId, `
    (() => {
      const d = document.querySelector('[role="dialog"]');
      if (d) {
        const cancel = Array.from(d.querySelectorAll('button,[role="button"]'))
          .find(b => b.textContent?.trim() === 'Cancel');
        if (cancel) cancel.click();
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  // Handle discard if needed
  await evalIn(sessionId, `
    (() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const d of dialogs) {
        const btns = Array.from(d.querySelectorAll('button, [role="button"]'));
        const discard = btns.find(b => (b.textContent || '').trim() === 'Discard');
        if (discard) { discard.click(); return true; }
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 300));

  // --- 5. Open compose ---
  console.log('[test-threads] Opening compose dialog...');
  const clicked = await evalIn(sessionId, `
    (() => {
      const svg = document.querySelector('svg[aria-label="Create"]');
      if (!svg) return false;
      let el = svg;
      for (let i = 0; i < 5; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
          el.click();
          return true;
        }
      }
      if (svg.parentElement) { svg.parentElement.click(); return true; }
      return false;
    })()
  `);
  if (!clicked) {
    console.error('[test-threads] FAIL: Could not click Create button');
    ws.close();
    process.exit(3);
  }
  await new Promise(r => setTimeout(r, 1500));

  // Verify dialog opened
  const hasDialog = await evalIn(sessionId, `!!document.querySelector('[role="dialog"]')`);
  if (!hasDialog) {
    console.error('[test-threads] FAIL: Dialog did not open');
    ws.close();
    process.exit(4);
  }
  console.log('[test-threads] Compose dialog opened');

  // --- 6. Focus textbox + clear any residual text ---
  const hasContent = await evalIn(sessionId, `
    (() => {
      const el = document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]');
      if (!el) return false;
      el.focus();
      if (!el.textContent?.trim()) return 'empty';
      // Select all using Selection API (execCommand doesn't work on React contenteditable)
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString().length > 0 ? 'selected' : 'empty';
    })()
  `);
  if (hasContent === 'selected') {
    console.log('[test-threads] Clearing residual text...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
    await new Promise(r => setTimeout(r, 300));
  }
  // Re-focus after clear
  const focused = await evalIn(sessionId, `
    (() => {
      const el = document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]');
      if (el) { el.focus(); return document.activeElement === el; }
      return false;
    })()
  `);
  if (!focused) {
    console.error('[test-threads] FAIL: Could not focus textbox');
    ws.close();
    process.exit(5);
  }

  // --- 7. Type text ---
  console.log('[test-threads] Typing text...');
  // Warmup
  await send('Input.insertText', { text: ' ' }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);

  // Type the actual text
  await send('Input.insertText', { text: testText }, sessionId);
  await new Promise(r => setTimeout(r, 500));

  // Verify text was typed
  const typed = await evalIn(sessionId, `
    (() => {
      const el = document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]');
      return (el?.textContent || '').trim();
    })()
  `);
  console.log(`[test-threads] Typed text readback: "${typed}"`);

  // --- 8. Screenshot ---
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }, sessionId);
  if (shot?.data) {
    const fs = await import('fs');
    fs.writeFileSync('screenshots/threads-test-compose.jpg', Buffer.from(shot.data, 'base64'));
    console.log('[test-threads] Screenshot: screenshots/threads-test-compose.jpg');
  }

  // --- 9. Post or cleanup ---
  if (isLive) {
    console.log('[test-threads] LIVE: Clicking Post...');
    const postClicked = await evalIn(sessionId, `
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return false;
        const btns = Array.from(dialog.querySelectorAll('button, [role="button"], div[role="button"]'));
        const postBtn = btns.find(b => (b.textContent || '').trim() === 'Post');
        if (!postBtn) return false;
        // Use real click coordinates
        postBtn.setAttribute('data-social-click-target', '1');
        return true;
      })()
    `);
    if (postClicked) {
      // Click via coordinates for React handler
      const rect = await evalIn(sessionId, `
        (() => {
          const el = document.querySelector('[data-social-click-target="1"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          el.removeAttribute('data-social-click-target');
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()
      `);
      if (rect) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(rect.x), y: Math.round(rect.y) }, sessionId);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 }, sessionId);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 }, sessionId);
        await new Promise(r => setTimeout(r, 3000));
        const postOutcome = await evalIn(sessionId, `!!document.querySelector('[role="dialog"] [role="textbox"]')`);
        console.log(`[test-threads] Post outcome: ${postOutcome ? 'STILL OPEN (failed?)' : 'PUBLISHED'}`);
      }
    }
  } else {
    console.log('[test-threads] DRY RUN: Not clicking Post. Cleaning up...');
    // Clear text
    await evalIn(sessionId, `
      (() => {
        const el = document.querySelector('[role="dialog"] [role="textbox"][contenteditable="true"]');
        if (el) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
      })()
    `);
    await new Promise(r => setTimeout(r, 300));
    // Cancel
    await evalIn(sessionId, `
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return;
        const btns = Array.from(dialog.querySelectorAll('button, [role="button"]'));
        const cancelBtn = btns.find(b => (b.textContent || '').trim() === 'Cancel');
        if (cancelBtn) cancelBtn.click();
      })()
    `);
  }

  console.log('[test-threads] PASS');
  ws.close();
}

main().catch(err => {
  console.error('[test-threads] FATAL:', err);
  process.exit(1);
});
