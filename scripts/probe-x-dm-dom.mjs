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
    if (r.exceptionDetails) {
      console.error('[probe] evaluate threw:', JSON.stringify(r.exceptionDetails, null, 2));
    }
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

    threadProbe = await evalIn(`(() => { try {
      // Conversation header (correspondent display name)
      const username = document.querySelector('[data-testid="dm-conversation-username"]');
      const headerText = username?.textContent?.trim().slice(0, 120) || null;

      // Handle probe: the @handle is not in dm-conversation-username (that's
      // display name only). Try several candidates and report what each
      // yields so we can pick a stable selector.
      const handleCandidates = {};
      // 1. Siblings of username within the same header row
      if (username) {
        const header = username.closest('[data-testid="DM_Conversation_Header"]')
          || username.parentElement?.parentElement
          || username.parentElement;
        if (header) {
          // 1a. Collect every visible text token that looks like "@something"
          const atMatches = [];
          for (const el of header.querySelectorAll('*')) {
            const t = (el.textContent || '').trim();
            if (/^@[a-zA-Z0-9_]{1,15}$/.test(t)) atMatches.push({ tag: el.tagName.toLowerCase(), text: t });
          }
          handleCandidates.header_at_tokens = atMatches.slice(0, 5);

          // 1b. Profile links inside the header
          const links = Array.from(header.querySelectorAll('a[href^="/"]'))
            .map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 60) }))
            .filter((x) => x.href && !x.href.includes('/i/') && !x.href.includes('/home'));
          handleCandidates.header_profile_links = links.slice(0, 5);
        }
      }

      // 2. data-testid="UserName" — X's standard profile username container.
      // May or may not render inside DM header.
      const userNameContainer = document.querySelector('[data-testid="UserName"]');
      handleCandidates.UserName_testid = userNameContainer
        ? { text: (userNameContainer.textContent || '').trim().slice(0, 120) }
        : null;

      // 3. Aria-label on header-like elements that may embed both name + handle
      const ariaCandidates = Array.from(document.querySelectorAll('[aria-label]'))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          label: el.getAttribute('aria-label') || '',
          has_at: /@[a-zA-Z0-9_]{1,15}/.test(el.getAttribute('aria-label') || ''),
        }))
        .filter((x) => x.has_at)
        .slice(0, 10);
      handleCandidates.aria_labels_with_at = ariaCandidates;

      // 4. Broadest fallback: any @handle-shaped text token in the top 600px
      // of the viewport, where the header lives.
      const topTokens = [];
      for (const el of document.querySelectorAll('span, a, div')) {
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.top > 600) continue;
        const t = (el.textContent || '').trim();
        if (/^@[a-zA-Z0-9_]{1,15}$/.test(t)) {
          topTokens.push({ tag: el.tagName.toLowerCase(), text: t, top: Math.round(r.top), left: Math.round(r.left) });
        }
      }
      handleCandidates.top_viewport_at_tokens = topTokens.slice(0, 10);

      // 5. Avatar image alt text — X uses alt for accessibility; sometimes
      // it contains the handle, sometimes display name.
      const topImages = Array.from(document.querySelectorAll('img[alt]'))
        .filter((img) => {
          const r = img.getBoundingClientRect();
          return r.top >= 0 && r.top < 400;
        })
        .slice(0, 6)
        .map((img) => ({
          alt: img.getAttribute('alt'),
          src: (img.getAttribute('src') || '').slice(0, 80),
          top: Math.round(img.getBoundingClientRect().top),
        }));
      handleCandidates.top_avatar_alts = topImages;

      // 6. ALL profile hrefs on the page — looking for /<handle> shape
      // (not /i/ or /home or /compose). The conversation header typically
      // wraps the display name in a link to the correspondent's profile.
      // Use RegExp() instead of a /.../ literal to avoid template-literal
      // eating the backslash before the forward slash.
      const profileShape = new RegExp('^/[A-Za-z0-9_]{1,15}($|/)');
      const skipPrefixes = ['/i/','/home','/compose','/notifications','/messages','/settings','/explore','/search','/following','/followers','/bookmarks','/jobs','/premium'];
      const profileHrefs = Array.from(document.querySelectorAll('a[href^="/"]'))
        .map((a) => a.getAttribute('href') || '')
        .filter((href) => profileShape.test(href) && !skipPrefixes.some((p) => href.startsWith(p)));
      handleCandidates.page_profile_hrefs = [...new Set(profileHrefs)].slice(0, 10);

      // 7. Probe the header element directly — dump testids of likely
      // header ancestors so we can find the right container next time.
      if (username) {
        const ancestors = [];
        let cur = username;
        for (let i = 0; i < 6 && cur; i++) {
          ancestors.push({
            tag: cur.tagName.toLowerCase(),
            testid: cur.getAttribute('data-testid') || null,
            cls: (cur.className || '').toString().slice(0, 80),
          });
          cur = cur.parentElement;
        }
        handleCandidates.username_ancestors = ancestors;
      }

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

      return { headerText, handleCandidates, messageCount: messageRoots.length, messages, viewport };
    } catch (err) { return { probeError: String(err && err.stack || err) }; } })()`);
  }

  console.log(JSON.stringify({ inboxProbe, threadProbe }, null, 2));

  // Cleanup: close the probe tab
  await send('Target.closeTarget', { targetId });
  ws.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
