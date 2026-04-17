#!/usr/bin/env node
/**
 * CDP probe for Threads (threads.com) DOM structure.
 * Attaches to the daemon's running debug Chrome at :9222, finds or
 * creates a tab in the logged-in profile, then systematically probes
 * the Threads UI for selectors needed by deterministic posting tools.
 *
 * Usage:
 *   node scripts/probe-threads-dom.mjs [--page home|compose|profile|search]
 *
 * Output: JSON to stdout with discovered selectors and DOM structure.
 */
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

let _nextId = 0;

function createCdpClient(ws) {
  const pending = new Map();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch { /* ignore */ }
  });

  async function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++_nextId;
      pending.set(id, { resolve, reject });
      const frame = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      ws.send(JSON.stringify(frame));
    });
  }

  return { send };
}

async function connectCdp(port = 9222) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const client = createCdpClient(ws);
  return { ws, ...client };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function evalIn(send, sessionId, expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  return r?.result?.value;
}

async function navigateTo(send, sessionId, url) {
  // Suppress beforeunload
  await evalIn(send, sessionId, 'window.onbeforeunload = null; true');
  await send('Page.navigate', { url }, sessionId);
  await sleep(4000);
}

async function screenshot(send, sessionId) {
  const r = await send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 70,
  }, sessionId);
  return r?.data;
}

// ---------------------------------------------------------------------------
// DOM probes
// ---------------------------------------------------------------------------

/** Discover all unique data-testid values on the page */
async function probeTestIds(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      const els = document.querySelectorAll('[data-testid]');
      return [...new Set(Array.from(els).map(e => e.getAttribute('data-testid')))];
    })()
  `);
}

/** Discover all aria-label values on interactive elements */
async function probeAriaLabels(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      const els = document.querySelectorAll('[aria-label]');
      return [...new Set(Array.from(els).map(e => {
        const tag = e.tagName.toLowerCase();
        const role = e.getAttribute('role') || '';
        const label = e.getAttribute('aria-label');
        return tag + (role ? '[role=' + role + ']' : '') + ': ' + label;
      }))].slice(0, 100);
    })()
  `);
}

/** Discover all role attributes used on the page */
async function probeRoles(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      const els = document.querySelectorAll('[role]');
      const roles = {};
      els.forEach(e => {
        const role = e.getAttribute('role');
        if (!roles[role]) roles[role] = 0;
        roles[role]++;
      });
      return roles;
    })()
  `);
}

/** Probe navigation links */
async function probeNavigation(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      const links = document.querySelectorAll('a[href], [role="link"]');
      return Array.from(links).map(e => ({
        href: e.getAttribute('href') || '',
        label: e.getAttribute('aria-label') || '',
        text: (e.textContent || '').trim().slice(0, 80),
        testid: e.getAttribute('data-testid') || '',
      })).filter(l => l.href.startsWith('/') || l.href.includes('threads'))
        .slice(0, 50);
    })()
  `);
}

/** Probe contenteditable / textarea elements (likely compose inputs) */
async function probeInputs(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      const results = [];
      // Contenteditable divs
      document.querySelectorAll('[contenteditable="true"]').forEach(e => {
        results.push({
          type: 'contenteditable',
          tag: e.tagName.toLowerCase(),
          testid: e.getAttribute('data-testid') || '',
          ariaLabel: e.getAttribute('aria-label') || '',
          placeholder: e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || '',
          role: e.getAttribute('role') || '',
          classes: e.className?.slice?.(0, 100) || '',
        });
      });
      // Textareas
      document.querySelectorAll('textarea').forEach(e => {
        results.push({
          type: 'textarea',
          tag: 'textarea',
          testid: e.getAttribute('data-testid') || '',
          ariaLabel: e.getAttribute('aria-label') || '',
          placeholder: e.placeholder || '',
          name: e.name || '',
        });
      });
      // Inputs
      document.querySelectorAll('input[type="text"], input:not([type])').forEach(e => {
        results.push({
          type: 'input',
          tag: 'input',
          testid: e.getAttribute('data-testid') || '',
          placeholder: e.placeholder || '',
          name: e.name || '',
        });
      });
      return results;
    })()
  `);
}

/** Probe buttons */
async function probeButtons(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      return Array.from(btns).map(e => ({
        text: (e.textContent || '').trim().slice(0, 60),
        testid: e.getAttribute('data-testid') || '',
        ariaLabel: e.getAttribute('aria-label') || '',
        type: e.getAttribute('type') || '',
        disabled: e.disabled || false,
      })).filter(b => b.text || b.testid || b.ariaLabel).slice(0, 80);
    })()
  `);
}

/** Probe for logged-in user identity */
async function probeIdentity(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      const results = {};
      // Profile link in nav
      const profileLinks = document.querySelectorAll('a[href^="/@"]');
      results.profileLinks = Array.from(profileLinks).map(e => ({
        href: e.getAttribute('href'),
        label: e.getAttribute('aria-label') || '',
        text: (e.textContent || '').trim().slice(0, 60),
      }));
      // Look for avatar images with alt text
      const avatars = document.querySelectorAll('img[alt]');
      results.avatars = Array.from(avatars)
        .filter(e => e.width < 100 && e.width > 16)
        .map(e => ({
          alt: e.alt,
          src: e.src?.slice(0, 80),
          width: e.width,
        })).slice(0, 10);
      // Meta tags
      const meta = document.querySelector('meta[property="og:url"]');
      results.ogUrl = meta?.getAttribute('content') || '';
      return results;
    })()
  `);
}

/** Probe the feed / post structure */
async function probeFeed(send, sessionId) {
  return evalIn(send, sessionId, `
    (() => {
      // Look for article or post-like containers
      const articles = document.querySelectorAll('article, [role="article"]');
      const result = { articleCount: articles.length, samples: [] };
      Array.from(articles).slice(0, 3).forEach(art => {
        const testids = Array.from(art.querySelectorAll('[data-testid]'))
          .map(e => e.getAttribute('data-testid'));
        const links = Array.from(art.querySelectorAll('a[href]'))
          .map(e => e.getAttribute('href')).filter(Boolean);
        const text = (art.textContent || '').trim().slice(0, 200);
        result.samples.push({ testids, links: links.slice(0, 5), text });
      });
      return result;
    })()
  `);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pageArg = process.argv.find(a => a.startsWith('--page='))?.split('=')[1] || 'home';

  console.error('[probe-threads] connecting to Chrome at :9222...');
  const { ws, send } = await connectCdp();

  // Find threads.com or x.com tabs to identify the ogsus profile context
  const targets = (await send('Target.getTargets')).targetInfos;
  const pages = targets.filter(t => t.type === 'page');

  // Find the ogsus profile context (has x.com tabs)
  const xTab = pages.find(t => t.url.startsWith('https://x.com'));
  if (!xTab) {
    console.error('[probe-threads] No x.com tab found — cannot identify profile context');
    ws.close();
    process.exit(2);
  }
  const expectedCtx = xTab.browserContextId;
  console.error(`[probe-threads] profile context: ${expectedCtx?.slice(0, 8)}`);

  // Find existing threads tab or repurpose a tab in the context
  let threadTab = pages.find(t =>
    t.browserContextId === expectedCtx &&
    (t.url.includes('threads.com') || t.url.includes('threads.net'))
  );
  let targetId;

  if (threadTab) {
    targetId = threadTab.targetId;
    console.error(`[probe-threads] found existing threads tab: ${threadTab.url}`);
  } else {
    // Repurpose a newtab or create in context
    const newTab = pages.find(t => t.browserContextId === expectedCtx && t.url.includes('newtab'));
    if (newTab) {
      targetId = newTab.targetId;
      console.error('[probe-threads] repurposing newtab');
    } else {
      // Try to create a target in context
      try {
        const created = await send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: expectedCtx,
        });
        targetId = created.targetId;
        console.error('[probe-threads] created new tab in context');
      } catch (err) {
        console.error('[probe-threads] Cannot create tab:', err.message);
        ws.close();
        process.exit(3);
      }
    }
  }

  // Attach
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  // Navigate based on page arg
  const urls = {
    home: 'https://www.threads.net/',
    compose: 'https://www.threads.net/', // compose is a modal, not a URL
    profile: 'https://www.threads.net/@ohwow_fun',
    search: 'https://www.threads.net/search',
  };
  const targetUrl = urls[pageArg] || urls.home;
  console.error(`[probe-threads] navigating to ${targetUrl} (page=${pageArg})...`);
  await navigateTo(send, sessionId, targetUrl);

  // Wait for hydration
  await sleep(2000);

  const currentUrl = await evalIn(send, sessionId, 'window.location.href');
  const title = await evalIn(send, sessionId, 'document.title');
  console.error(`[probe-threads] landed: ${currentUrl} — "${title}"`);

  // Run all probes
  const result = {
    url: currentUrl,
    title,
    page: pageArg,
    timestamp: new Date().toISOString(),
  };

  console.error('[probe-threads] running probes...');
  result.testIds = await probeTestIds(send, sessionId);
  result.ariaLabels = await probeAriaLabels(send, sessionId);
  result.roles = await probeRoles(send, sessionId);
  result.navigation = await probeNavigation(send, sessionId);
  result.inputs = await probeInputs(send, sessionId);
  result.buttons = await probeButtons(send, sessionId);
  result.identity = await probeIdentity(send, sessionId);
  result.feed = await probeFeed(send, sessionId);

  // Take a screenshot
  const screenshotB64 = await screenshot(send, sessionId);
  if (screenshotB64) {
    const fs = await import('fs');
    const dir = new URL('../screenshots/', import.meta.url).pathname;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}threads-${pageArg}.jpg`, Buffer.from(screenshotB64, 'base64'));
    console.error(`[probe-threads] screenshot saved to screenshots/threads-${pageArg}.jpg`);
  }

  // Output
  console.log(JSON.stringify(result, null, 2));

  ws.close();
}

main().catch(err => {
  console.error('[probe-threads] fatal:', err);
  process.exit(1);
});
