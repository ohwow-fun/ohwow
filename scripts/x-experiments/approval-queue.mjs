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
import { chat, ingestKnowledgeFile, resolveOhwow } from './_ohwow.mjs';
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';

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
    const { permalink, draft } = e.payload;
    const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
    const page = await findOrOpenXTab(browser);
    if (!page) throw new Error('no x.com tab');
    await page.installUnloadEscapes();
    await page.goto(`https://x.com${permalink}`);
    await sleep(3500);
    await page.clickSelector('[data-testid="reply"]', 8000);
    await sleep(1500);
    await page.focus(`document.querySelector('[data-testid="tweetTextarea_0"]')`);
    await page.typeText(draft);
    await sleep(600);
    const ok = await page.clickSelector('[data-testid="tweetButton"]', 8000);
    browser.close();
    return { posted: ok };
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
  console.log(`applying ${approved.length} approved entries…`);
  for (const e of approved) {
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
