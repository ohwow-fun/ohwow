/**
 * approval-queue.mjs — operator CLI for the x-experiments shadow queue.
 *
 *   list                 — show pending entries with index
 *   show <idx|id>        — full detail for one entry
 *   approve <idx|id> [notes...]   — mark approved
 *   reject  <idx|id> [notes...]   — mark rejected
 *   stats                — per-kind counts
 *   apply                — dispatch all 'approved' entries, marking them 'applied'
 *
 * apply() routes by kind:
 *   reply            → open composer, type, post (uses existing raw-cdp helpers)
 *   knowledge_upload → ingestKnowledgeFile via _ohwow
 *   dm_dispatch      → chat() via _ohwow
 */
import { loadQueue, rate, stats } from './_approvals.mjs';
import { chat, ingestKnowledgeFile, resolveOhwow, daemonFetch } from './_ohwow.mjs';
import { postTweet, replyToPost } from './_x-harvest.mjs';
import { ensureXReady } from './_x-browser.mjs';
import crypto from 'node:crypto';

const [, , cmd, ...rest] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function resolveEntry(arg) {
  const all = loadQueue();
  if (!arg) return null;
  if (/^[0-9]+$/.test(arg)) return all.filter(e => e.status === 'pending')[Number(arg)] || null;
  return all.find(e => e.id.startsWith(arg)) || null;
}

async function applyEntry(e) {
  if (e.kind === 'knowledge_upload') {
    const { title, filename, body, replace } = e.payload;
    return ingestKnowledgeFile({ title, filename, body, replace: !!replace });
  }
  if (e.kind === 'dm_dispatch') {
    return chat({ message: e.payload.message });
  }
  if (e.kind === 'reply') {
    const { browser, page } = await ensureXReady();
    await replyToPost(page, e.payload.permalink, e.payload.draft);
    browser.close();
    return { posted: true };
  }
  if (e.kind === 'x_outbound_post') {
    const { browser, page } = await ensureXReady();
    await postTweet(page, e.payload.post_text);
    browser.close();
    return { posted: true };
  }
  if (e.kind === 'x_outbound_reply') {
    const { browser, page } = await ensureXReady();
    await replyToPost(page, e.payload.permalink, e.payload.reply_text);
    browser.close();
    return { posted: true };
  }
  if (e.kind === 'x_contact_create') {
    const { url, token } = resolveOhwow();
    const p = e.payload;
    const createRes = await daemonFetch(`${url}/api/contacts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: p.display_name || p.handle,
        contact_type: 'lead',
        status: 'active',
        tags: ['x', 'qualified', p.bucket, p.intent].filter(Boolean),
        custom_fields: {
          x_handle: p.handle,
          x_permalink: p.permalink,
          x_bucket: p.bucket,
          x_intent: p.intent,
          x_intent_confidence: p.confidence,
          x_source: p.source || 'author-ledger',
        },
        never_sync: true,
        outreach_token: p.outreach_token || crypto.randomUUID(),
      }),
    });
    if (!createRes.ok) throw new Error(`create contact ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
    const contact = (await createRes.json()).data;
    await daemonFetch(`${url}/api/contacts/${contact.id}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'x:qualified',
        source: 'approval-queue',
        title: `qualified from X (${p.bucket})`,
        payload: { intent: p.intent, confidence: p.confidence, reason: p.intent_reason },
      }),
    });
    return { contact_id: contact.id };
  }
  throw new Error(`unknown kind: ${e.kind}`);
}

if (cmd === 'list' || !cmd) {
  const pending = loadQueue().filter(e => e.status === 'pending');
  console.log(`${pending.length} pending in workspace ${resolveOhwow().workspace}:`);
  pending.forEach((e, i) => {
    console.log(`  [${i}] ${e.id.slice(0,8)} ${e.kind.padEnd(18)} · ${e.summary.slice(0, 80)}`);
  });
} else if (cmd === 'show') {
  const e = resolveEntry(rest[0]);
  if (!e) { console.error('not found'); process.exit(1); }
  console.log(JSON.stringify(e, null, 2));
} else if (cmd === 'approve' || cmd === 'reject') {
  const e = resolveEntry(rest[0]);
  if (!e) { console.error('not found'); process.exit(1); }
  const status = cmd === 'approve' ? 'approved' : 'rejected';
  const updated = rate({ id: e.id, status, notes: rest.slice(1).join(' ') || null });
  console.log(`${status}: ${updated.id.slice(0,8)} · ${updated.kind} · ${updated.summary.slice(0, 80)}`);
} else if (cmd === 'stats') {
  console.log(JSON.stringify(stats(), null, 2));
} else if (cmd === 'apply') {
  const approved = loadQueue().filter(e => e.status === 'approved');
  // Cap outbound posts/replies per apply run to avoid rapid-fire bot
  // appearance. CRM contacts are not visible externally, so no cap.
  const X_KINDS = new Set(['x_outbound_post', 'x_outbound_reply', 'reply']);
  const MAX_X_PER_APPLY = Number(process.env.MAX_X_PER_APPLY || 2);
  let xApplied = 0;
  const toApply = approved.filter(e => {
    if (X_KINDS.has(e.kind)) {
      if (xApplied >= MAX_X_PER_APPLY) return false;
      xApplied++;
    }
    return true;
  });
  console.log(`applying ${toApply.length} of ${approved.length} approved (max ${MAX_X_PER_APPLY} X actions per run)…`);
  let isFirstX = true;
  for (const e of toApply) {
    // Random 3-6 minute delay between X-visible actions so the
    // posting pattern looks human, not scripted.
    if (X_KINDS.has(e.kind) && !isFirstX) {
      const delayMs = (180 + Math.floor(Math.random() * 180)) * 1000;
      console.log(`  waiting ${Math.round(delayMs/1000)}s before next X action…`);
      await sleep(delayMs);
    }
    if (X_KINDS.has(e.kind)) isFirstX = false;
    try {
      const r = await applyEntry(e);
      rate({ id: e.id, status: 'applied', notes: `applied: ${JSON.stringify(r).slice(0, 200)}` });
      console.log(`  ✓ ${e.id.slice(0,8)} ${e.kind}`);
    } catch (err) {
      rate({ id: e.id, status: 'rejected', notes: `apply failed: ${err.message.slice(0, 200)}` });
      console.log(`  ✗ ${e.id.slice(0,8)} ${e.kind} — ${err.message}`);
    }
  }
} else {
  console.log('commands: list | show <idx|id> | approve <idx|id> [notes] | reject <idx|id> [notes] | stats | apply');
  process.exit(1);
}
