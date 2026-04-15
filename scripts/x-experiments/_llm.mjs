/**
 * LLM helper for x-experiments. Resolution order:
 *   1. ohwow daemon /api/llm (workspace-routed, logs to activity, applies model_policy)
 *   2. ANTHROPIC_API_KEY direct
 *   3. OPENROUTER_API_KEY direct (or ~/.ohwow/config.json openRouterApiKey)
 *
 * Set OHWOW_LLM=0 to force the direct path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { llm as ohwowLlm } from './_ohwow.mjs';

function loadOhwowConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ohwow', 'config.json'), 'utf8')); }
  catch { return {}; }
}

export async function complete({ system, user, maxTokens = 800, model, purpose = 'generation' }) {
  const tryOhwow = process.env.OHWOW_LLM !== '0';
  if (tryOhwow) {
    try {
      const r = await ohwowLlm({ purpose, system, prompt: user });
      return r.text || '';
    } catch (e) {
      if (process.env.OHWOW_LLM === '1') throw e;
      // else soft-fall through
      console.error('[llm] ohwow failed, falling back:', e.message);
    }
  }
  const cfg = loadOhwowConfig();
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY || cfg.openRouterApiKey;
  if (anthropic) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropic, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).content?.[0]?.text || '';
  }
  if (orKey) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orKey}` },
      body: JSON.stringify({
        model: model || process.env.LLM_MODEL || 'anthropic/claude-sonnet-4.5',
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).choices?.[0]?.message?.content || '';
  }
  throw new Error('no LLM path available (ohwow daemon unreachable; no ANTHROPIC_API_KEY / OPENROUTER_API_KEY)');
}

export function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in: ${String(text).slice(0, 200)}`);
  return JSON.parse(m[0]);
}
