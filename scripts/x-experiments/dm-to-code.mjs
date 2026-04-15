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
import { RawCdpBrowser, findOrOpenXTab } from '../../src/execution/browser/raw-cdp.ts';
import { llm, chat, resolveOhwow, extractJson } from './_ohwow.mjs';
import { propose } from './_approvals.mjs';

const MAX_CONVS = Number(process.env.MAX_CONVS || 5);
const DRY = process.env.DRY !== '0';
const PITCH = process.env.WORKSPACE_PITCH || 'ohwow: local-first AI runtime. TypeScript, Node, SQLite, Ink TUI, Vite web, Express API, MCP server. Multi-workspace, Ollama + Anthropic routing, browser + desktop automation.';
const CODE_CLASSES = new Set((process.env.CODE_CLASSES || 'feature_request,bug_report,integration_idea').split(',').map(s => s.trim()));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { workspace } = resolveOhwow();
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

  const outPath = `/tmp/dm-scan-${new Date().toISOString().slice(0, 10)}.jsonl`;
  fs.writeFileSync(outPath, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\n[dm] wrote ${results.length} classifications → ${outPath}`);
  browser.close();
})().catch(e => { console.error(e); process.exit(1); });
