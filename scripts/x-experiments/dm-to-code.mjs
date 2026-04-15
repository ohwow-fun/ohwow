/**
 * dm-to-code.mjs — read X DMs, classify each conversation, and convert
 * feature-request / bug / integration-idea DMs into ohwow orchestrator
 * chat sessions with a structured code-suggestion prompt.
 *
 * Flow:
 *   1. Navigate to x.com/messages
 *   2. Enumerate conversation items (dm-conversation-item-*:*)
 *   3. For each conversation: click it, scrape the last ~30 messages
 *   4. LLM-classify: one of { feature_request, bug_report, integration_idea,
 *        feedback, support_question, social_chatter, spam }
 *   5. For code-worthy classes, either:
 *        - DRY=1 (default): write a proposed orchestrator brief to /tmp/dm-<id>.md
 *        - DRY=0        : POST /api/chat to kick off an async orchestrator
 *                         session in the active workspace with the DM as input
 *
 * Env:
 *   MAX_CONVS=5          how many convs to scan per run
 *   DRY=1                don't dispatch to orchestrator, only write briefs
 *   WORKSPACE_PITCH=...  what "we" are — shapes the classification prompt
 *   CODE_CLASSES='feature_request,bug_report,integration_idea'  which classes to dispatch
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
import { llm, chat, resolveOhwow, extractJson } from './_ohwow.mjs';
import { propose } from './_approvals.mjs';
import { loadLedger, saveLedger, upsertAuthor, markQualified, isQualified } from './_author-ledger.mjs';
import { loadLeadGenConfig, freeGates, classifyIntent, acceptsIntent } from './_qualify.mjs';

const MAX_CONVS = Number(process.env.MAX_CONVS || 5);
const DRY = process.env.DRY !== '0';
const PITCH = process.env.WORKSPACE_PITCH || 'ohwow: local-first AI runtime. TypeScript, Node, SQLite, Ink TUI, Vite web, Express API, MCP server. Multi-workspace, Ollama + Anthropic routing, browser + desktop automation.';
const CODE_CLASSES = new Set((process.env.CODE_CLASSES || 'feature_request,bug_report,integration_idea').split(',').map(s => s.trim()));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Resolve the handle of the DM peer from the open conversation view.
// X strips data-testid from DM headers, so we walk the header link that
// points to /<handle> and is not a tab-bar self-link. Falls back to
// parsing the conversation-item testid, which encodes user ids but not
// always handles — returning null is preferable to fabricating.
async function resolvePeerHandle(page, meHandle) {
  try {
    const h = await page.evaluate(`(() => {
      const self = ${JSON.stringify(meHandle || '')};
      const links = Array.from(document.querySelectorAll('header a[href^="/"], [data-testid="DM_Conversation_Header"] a[href^="/"]'));
      for (const a of links) {
        const slug = a.getAttribute('href').slice(1).split('/')[0];
        if (!slug) continue;
        if (slug === 'messages' || slug === 'home' || slug === 'i' || slug === self) continue;
        if (/^[A-Za-z0-9_]{1,15}$/.test(slug)) return slug;
      }
      return null;
    })()`);
    return typeof h === 'string' && h.length ? h : null;
  } catch { return null; }
}

(async () => {
  const { url, token, workspace } = resolveOhwow();
  const cfg = loadLeadGenConfig(workspace, { fs, os, path, logger: console });
  const ledger = loadLedger(workspace);
  console.log(`[dm] active workspace: ${workspace} · dry: ${DRY}`);

  const browser = await RawCdpBrowser.connect('http://localhost:9222', 5000);
  const page = await findOrOpenXTab(browser);
  if (!page) { console.error('no x.com tab'); process.exit(1); }
  await page.installUnloadEscapes();
  await page.goto('https://x.com/messages');
  await sleep(4000);

  const convs = await page.evaluate(`(() => Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"]')).slice(0, ${MAX_CONVS}).map(el => ({
    testid: el.getAttribute('data-testid'),
    text: (el.innerText || '').slice(0, 240).replace(/\\s+/g, ' '),
  })))()`);
  console.log(`[dm] found ${convs.length} conversations`);

  const results = [];

  for (const c of convs) {
    console.log(`\n[dm] ${c.testid} — ${c.text.slice(0, 80)}`);
    const clicked = await page.clickSelector(`[data-testid="${c.testid}"]`, 5000);
    if (!clicked) { console.log('  skip: could not open'); continue; }
    await sleep(3000);

    const msgs = await page.evaluate(`(() => {
      // X DM DOM strips data-testid / role / aria from message ancestors, so
      // we can't walk for a semantic signal. Direction is instead inferred
      // geometrically: inbound bubbles align to the LEFT wall of the DM
      // panel (minimum x-position across all messages in view), outbound
      // bubbles sit at least ~50px right of that wall. This adapts to any
      // panel width and survives class-name churn.
      const nodes = Array.from(document.querySelectorAll('[data-testid^="message-text-"]'));
      const handleLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const meHandle = handleLink ? handleLink.getAttribute('href').slice(1) : null;
      const rects = nodes.map(n => n.getBoundingClientRect());
      const minLeft = rects.length ? Math.min(...rects.map(r => r.left)) : 0;
      return {
        meHandle,
        count: nodes.length,
        messages: nodes.slice(-40).map((n, i) => {
          const origIdx = nodes.indexOf(n);
          const r = rects[origIdx];
          const outbound = r.left > minLeft + 50;
          return { outbound, text: (n.innerText || '').slice(0, 800) };
        }),
      };
    })()`);

    if (msgs.count === 0) { console.log('  no messages visible'); continue; }
    console.log(`  ${msgs.count} messages (me=@${msgs.meHandle})`);

    const transcript = msgs.messages.map(m => `${m.outbound ? 'ME' : 'THEM'}: ${m.text.replace(/\n/g, ' ')}`).join('\n');

    const sys = `You classify inbound X DMs for a product team.
We are: ${PITCH}

Given a DM transcript, output STRICT JSON:
{
  "class": "feature_request"|"bug_report"|"integration_idea"|"feedback"|"support_question"|"social_chatter"|"spam",
  "summary": "<=25 words, what THEY are asking for or reporting",
  "signal": 0..1,                  // how actionable for us (1 = drop what you're doing)
  "code_prompt": "<=120 words. If class is code-worthy, a precise prompt to pass to our orchestrator: describe the request, the likely affected subsystem (TUI, API route, orchestrator tool, browser driver, MCP tool, db migration), and any constraints. Empty string otherwise."
}
Never invent requests that aren't in the transcript. If you're unsure, pick a safer class with lower signal.`;

    // Stage A: cheap classify (simple_classification purpose → small fast model per workspace policy)
    const clsSys = `You classify inbound X DMs.
We are: ${PITCH}
Output STRICT JSON:
{"class":"feature_request"|"bug_report"|"integration_idea"|"feedback"|"support_question"|"social_chatter"|"spam","summary":"<=25 words what THEY want","signal":0..1}`;
    const clsResp = await llm({ purpose: 'simple_classification', system: clsSys, prompt: `Preview: ${c.text}\n\nTranscript:\n${transcript}` });
    let cls;
    try { cls = extractJson(clsResp.text); }
    catch (e) { console.log('  classifier parse failed:', e.message); continue; }
    cls.code_prompt = '';
    console.log(`  [A] class=${cls.class} signal=${cls.signal} · ${cls.summary} (${clsResp.model_used})`);

    // Stage B: only if code-worthy, ask reasoning model for a precise orchestrator prompt
    if (CODE_CLASSES.has(cls.class) && cls.signal >= 0.4) {
      const promptSys = `You write precise orchestrator prompts for a codebase team.
We are: ${PITCH}
Given a DM transcript + classification, output STRICT JSON: {"code_prompt":"<=120 words. Describe the request, the likely affected subsystem (TUI, API route, orchestrator tool, browser driver, MCP tool, db migration), and any constraints. No fluff."}`;
      try {
        const promptResp = await llm({ purpose: 'reasoning', system: promptSys, prompt: `Classification: ${cls.class} / ${cls.summary}\n\nTranscript:\n${transcript}` });
        cls.code_prompt = extractJson(promptResp.text).code_prompt || '';
        console.log(`  [B] drafted code_prompt via ${promptResp.model_used} (${cls.code_prompt.length} chars)`);
      } catch (e) { console.log('  [B] code_prompt failed:', e.message); }
    }
    results.push({ testid: c.testid, ...cls, transcript });

    // Single-funnel qualification: every inbound DM sender enters the
    // same lead-qualification rubric as X-author candidates do. source:
    // 'dm' triggers the engager-boost in _qualify, so DMs clear the
    // score floor even at low public engagement — the DM itself is the
    // signal. No side-door: dm_dispatch below remains, but we record
    // the sender as a CRM contact when they pass the funnel.
    const peerHandle = await resolvePeerHandle(page, msgs.meHandle);
    if (peerHandle) {
      upsertAuthor(ledger, {
        handle: peerHandle,
        display_name: null,
        permalink: `https://x.com/${peerHandle}`,
        bucket: null,
        score: 0,
        replies: 0,
        likes: 0,
        tags: [],
        source: 'dm',
      });
      const row = ledger.get(peerHandle.toLowerCase());
      if (row && !isQualified(ledger, peerHandle)) {
        const verdict = freeGates(cfg, row);
        if (verdict.decision === 'pass') {
          let intent = null;
          try {
            intent = await classifyIntent(row, cfg, async (args) => {
              const r = await llm(args);
              return r?.text ?? r;
            }, { extractJson });
          } catch (e) { console.log(`  [funnel] classify failed: ${e.message}`); }
          if (intent && acceptsIntent(intent, cfg)) {
            const outreachToken = crypto.randomUUID();
            const proposal = propose({
              kind: 'x_contact_create',
              summary: `@${peerHandle} (via DM) → ${intent.intent} (conf ${intent.confidence.toFixed(2)})`,
              payload: {
                handle: peerHandle,
                permalink: `https://x.com/${peerHandle}`,
                source: 'dm',
                intent: intent.intent,
                confidence: intent.confidence,
                intent_reason: intent.reason,
                free_gate_reason: verdict.reason,
                outreach_token: outreachToken,
              },
              autoApproveAfter: 3,
            });
            console.log(`  [funnel] @${peerHandle} ${proposal.status}`);
            if (!DRY && proposal.status === 'auto_applied') {
              try {
                const cRes = await fetch(`${url}/api/contacts`, {
                  method: 'POST',
                  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                  body: JSON.stringify({
                    name: peerHandle,
                    contact_type: 'lead',
                    status: 'active',
                    tags: ['x', 'dm', 'qualified', intent.intent],
                    custom_fields: {
                      x_handle: peerHandle,
                      x_permalink: `https://x.com/${peerHandle}`,
                      x_source: 'dm',
                      x_intent: intent.intent,
                      x_intent_confidence: intent.confidence,
                    },
                    never_sync: true,
                    outreach_token: outreachToken,
                  }),
                });
                if (!cRes.ok) throw new Error(`POST contacts ${cRes.status}`);
                const contact = (await cRes.json()).data;
                await fetch(`${url}/api/contacts/${contact.id}/events`, {
                  method: 'POST',
                  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                  body: JSON.stringify({
                    kind: 'dm:received',
                    source: 'dm-to-code',
                    title: `DM received from @${peerHandle}`,
                    payload: {
                      classification: cls,
                      intent: intent.intent,
                      confidence: intent.confidence,
                      dm_preview: transcript.slice(0, 200),
                    },
                  }),
                });
                markQualified(ledger, peerHandle, contact.id);
                console.log(`  [funnel] promoted contact=${contact.id}`);
              } catch (e) { console.log(`  [funnel] promote failed: ${e.message}`); }
            }
          }
        } else {
          console.log(`  [funnel] @${peerHandle} rejected: ${verdict.reason}`);
        }
      }
    }

    if (CODE_CLASSES.has(cls.class) && cls.code_prompt && cls.signal >= 0.4) {
      const briefPath = `/tmp/dm-${c.testid.replace(/[^\w-]/g, '_')}.md`;
      const brief = [
        `# DM → code suggestion`,
        `Workspace: \`${workspace}\``,
        `DM: \`${c.testid}\``,
        `Class: \`${cls.class}\` · signal: ${cls.signal}`,
        `Summary: ${cls.summary}`,
        ``,
        `## Orchestrator prompt`,
        cls.code_prompt,
        ``,
        `## Transcript`,
        '```',
        transcript,
        '```',
      ].join('\n');
      fs.writeFileSync(briefPath, brief);
      console.log(`  brief → ${briefPath}`);

      const orchestratorMsg = `An inbound X DM classified as ${cls.class} (signal=${cls.signal}) arrived. Please analyze and propose concrete code changes or an implementation plan for our codebase.\n\nSummary: ${cls.summary}\n\nPrompt: ${cls.code_prompt}\n\n--- raw transcript ---\n${transcript}`;
      const entry = propose({
        kind: 'dm_dispatch',
        summary: `${cls.class} · ${cls.summary.slice(0, 80)}`,
        payload: { dmTestid: c.testid, classification: cls, message: orchestratorMsg },
      });
      console.log(`  approval ${entry.status} · id=${entry.id.slice(0,8)}`);
      if (entry.status === 'auto_applied') {
        try {
          const r = await chat({ message: orchestratorMsg });
          console.log(`  auto-dispatched → orchestrator: ${String(r?.response || r?.message || '').slice(0, 120)}`);
        } catch (e) { console.log('  auto-dispatch failed:', e.message); }
      }
    }
  }

  if (!DRY) saveLedger(workspace, ledger);
  const outPath = `/tmp/dm-scan-${new Date().toISOString().slice(0, 10)}.jsonl`;
  fs.writeFileSync(outPath, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\n[dm] wrote ${results.length} classifications → ${outPath}`);
  browser.close();
})().catch(e => { console.error(e); process.exit(1); });
