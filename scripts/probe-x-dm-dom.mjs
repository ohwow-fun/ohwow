#!/usr/bin/env node
/**
 * Temporary probe for the X DM DOM. Attaches to the daemon's running
 * Chrome at :9222, opens a new tab in the user's logged-in profile,
 * inspects /i/chat (inbox) and /i/chat/<pair> (thread) DOM structure
 * to discover correct selectors for primaryName + per-message reads.
 *
 * Output is JSON to stdout; safe to delete this file after.
 */
import WebSocket from 'ws';

async function rpc(ws, msg) {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === id) {
          ws.off('message', handler);
          if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
          else resolve(parsed.result);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

async function main() {
  const v = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json());
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  let nextId = 0;
  const send = (method, params, sessionId) => rpc(ws, {
    id: ++nextId, method, params: params || {}, ...(sessionId ? { sessionId } : {}),
  });

  // 1. Pick an x.com tab in the active profile
  const targets = (await send('Target.getTargets')).targetInfos;
  const xTabs = targets.filter((t) => t.type === 'page' && t.url.startsWith('https://x.com'));
  if (xTabs.length === 0) {
    console.error('No x.com tab open. Open one in the @ohwow_fun profile first.');
    process.exit(2);
  }
  const expectedCtx = xTabs[0].browserContextId;
  console.error(`[probe] using browserContextId=${expectedCtx?.slice(0, 8)} url=${xTabs[0].url}`);

  // 2. Open a fresh tab in same context so we don't disrupt whatever
  // the daemon is doing in the existing tab.
  const newTarget = await send('Target.createTarget', { url: 'about:blank', browserContextId: expectedCtx });
  const targetId = newTarget.targetId;
  const attachRes = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attachRes.sessionId;
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result?.value;
  };

  // 3. Inbox probe
  console.error('[probe] navigating to /i/chat');
  await send('Page.navigate', { url: 'https://x.com/i/chat' }, sessionId);
  await new Promise((r) => setTimeout(r, 4000));

  const inboxProbe = await evalIn(`(() => {
    const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"]'));
    return items.slice(0, 3).map((it) => {
      const testid = it.getAttribute('data-testid') || '';
      const pair = testid.replace(/^dm-conversation-item-/, '');
      const parts = Array.from(it.querySelectorAll('span, div')).slice(0, 30).map((el) => ({
        tag: el.tagName.toLowerCase(),
        dir: el.getAttribute('dir'),
        cls: (el.className || '').toString().slice(0, 60),
        text: (el.textContent || '').trim().slice(0, 80),
      })).filter((p) => p.text.length > 0).slice(0, 12);
      return { pair, raw: (it.textContent || '').trim().slice(0, 200), parts };
    });
  })()`);

  // 4. Open the first thread (if any)
  let threadProbe = null;
  if (inboxProbe && inboxProbe.length > 0 && inboxProbe[0].pair) {
    const pair = inboxProbe[0].pair.replace(/:/g, '-');
    console.error(`[probe] navigating to thread ${pair}`);
    await send('Page.navigate', { url: `https://x.com/i/chat/${pair}` }, sessionId);
    await new Promise((r) => setTimeout(r, 4500));

    threadProbe = await evalIn(`(() => {
      // Conversation header (correspondent display name)
      const username = document.querySelector('[data-testid="dm-conversation-username"]');
      const headerText = username?.textContent?.trim().slice(0, 120) || null;

      // Message rows: testid is message-<uuid>; child message-text-<uuid> holds text.
      const messageRoots = Array.from(document.querySelectorAll('[data-testid^="message-"]'))
        .filter((el) => /^message-[0-9a-f-]+$/.test(el.getAttribute('data-testid') || ''));

      const messages = messageRoots.slice(-6).map((root) => {
        const id = (root.getAttribute('data-testid') || '').replace(/^message-/, '');
        const textEl = root.querySelector('[data-testid="message-text-' + id + '"]');
        const text = textEl?.textContent?.trim().slice(0, 240) || null;

        // Author hints — outbound messages typically right-align via class.
        const rect = root.getBoundingClientRect();
        const flex = root.querySelector('[class*="justify-end"], [class*="justify-start"]');
        const flexCls = flex ? (flex.className || '').toString().slice(0, 80) : null;

        // Timestamps — X uses both <time> elements and aria-labels with absolute date.
        const timeEl = root.querySelector('time');
        const ts_iso = timeEl?.getAttribute('datetime') || null;
        const ts_text = timeEl?.textContent?.trim() || null;
        const aria = root.querySelector('[aria-label]');
        const ariaLabel = aria?.getAttribute('aria-label') || null;

        return { id, text, ts_iso, ts_text, ariaLabel, flexCls, x: Math.round(rect.x), w: Math.round(rect.width) };
      });

      // Viewport for context (helps interpret left/right alignment of x).
      const viewport = { w: window.innerWidth, h: window.innerHeight };

      return { headerText, messageCount: messageRoots.length, messages, viewport };
    })()`);
  }

  console.log(JSON.stringify({ inboxProbe, threadProbe }, null, 2));

  // Cleanup: close the probe tab
  await send('Target.closeTarget', { targetId });
  ws.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
