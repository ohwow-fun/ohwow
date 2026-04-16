#!/usr/bin/env node
/**
 * x-authors-to-crm: promote qualified X authors into the local CRM.
 *
 * Pipeline:
 *   1. Read today's x-authors-<date>.jsonl sidecar written by x-intel.
 *   2. Merge observations into the workspace's author ledger
 *      (~/.ohwow/workspaces/<ws>/x-authors-ledger.jsonl). The ledger is
 *      the signal reservoir; the CRM is the qualified-lead destination.
 *   3. Apply the workspace's lead-gen rubric free-gates (zero LLM cost).
 *   4. For each fresh candidate, ask the classifier buyer_intent vs
 *      builder_curiosity vs adjacent_noise (one simple_classification
 *      call per author).
 *   5. Only buyer_intent above minConfidence proposes x_contact_create
 *      through _approvals. Auto-applied entries hit the daemon's HTTP
 *      route to create a never_sync contact + x:qualified event and
 *      the ledger row is flagged qualified so we never re-classify.
 *
 * DRY mode (default): writes per-author briefs to /tmp/x-authors-to-crm-<ts>/
 * and skips HTTP + approval-queue writes. Set DRY=0 for the live path.
 *
 * Usage:
 *   node scripts/x-experiments/x-authors-to-crm.mjs            # DRY=1 default
 *   DRY=0 node scripts/x-experiments/x-authors-to-crm.mjs      # live
 *
 * Engager harvest is intentionally a stub in this first cut. The
 * sidecar alone carries enough signal to validate the funnel; extending
 * _x-harvest with replier/quoter primitives is a follow-up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveOhwow, llm, extractJson } from './_ohwow.mjs';
import { propose, loadQueue } from './_approvals.mjs';
import { loadLedger, saveLedger, upsertAuthor, markQualified, isQualified } from './_author-ledger.mjs';
import { loadLeadGenConfig, freeGates, classifyIntent, acceptsIntent, buildAutoApproveGate, loadProposedHandles } from './_qualify.mjs';

const DRY = process.env.DRY !== '0';
const MAX_AUTHORS_PER_RUN = Number(process.env.X_AUTHORS_MAX_PER_RUN || 50);

function today() { return new Date().toISOString().slice(0, 10); }
function sidecarPath(workspace, date) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, `x-authors-${date}.jsonl`);
}
function readSidecar(workspace, date) {
  const p = sidecarPath(workspace, date);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Engager harvest. x-intel now scrapes replier pools on configured
 * competitor posts (profiles[].harvest_engagers in x-config.json) and
 * writes their rows into the same authors sidecar, tagged with
 * __source='engager:competitor:<handle>' so the freeGate boost fires.
 * Nothing separate to read here yet — kept as a hook for future own-
 * post + quoter surfaces that may land in their own sidecar.
 */
async function harvestEngagers(/* cfg */) {
  return [];
}

async function fetchExistingHandles(url, token) {
  // Fetch all contacts and pluck custom_fields.x_handle. The route now
  // supports custom_field_key/value filtering for targeted lookups, but
  // for a whole-run dedup pass it's cheaper to pull the full set once.
  // When workspaces accumulate enough X-sourced contacts for this to
  // matter, switch to per-handle targeted lookups inside the loop.
  const res = await fetch(`${url}/api/contacts`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`list contacts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { data } = await res.json();
  const handles = new Set();
  for (const row of data || []) {
    let cf = row.custom_fields;
    if (typeof cf === 'string') { try { cf = JSON.parse(cf); } catch { cf = {}; } }
    if (cf && typeof cf.x_handle === 'string') handles.add(cf.x_handle.toLowerCase());
  }
  return handles;
}

async function createContact(url, token, payload) {
  const res = await fetch(`${url}/api/contacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST contacts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).data;
}

async function createEvent(url, token, contactId, payload) {
  const res = await fetch(`${url}/api/contacts/${contactId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST events ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function writeBrief(dir, entry, extras = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${entry.id}.json`);
  fs.writeFileSync(f, JSON.stringify({ entry, ...extras }, null, 2));
}

/**
 * Bucket-priority ordering for the per-run cap. Live runs 1+2 + the
 * audit-log smoke-run all burned the cap on advancements/hacks-bucket
 * candidates because Map iteration order is sidecar-historic and the
 * higher-precision market_signal bucket lives later in the ledger.
 *
 * Resolution order for the priority list:
 *   1. cfg.freeGates.bucketPriority (ordered array, explicit)
 *   2. cfg.freeGates.allowedBuckets (the allowlist's order)
 *   3. fall through (every bucket equally prioritised)
 *
 * Within a bucket, secondary sort by score desc so the strongest
 * candidates inside the top bucket get the cap before weaker ones.
 */
export function bucketRank(cfg, bucket) {
  const order = cfg?.freeGates?.bucketPriority;
  if (Array.isArray(order) && order.length > 0) {
    const i = order.indexOf(bucket);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }
  const allow = cfg?.freeGates?.allowedBuckets;
  if (Array.isArray(allow) && allow.length > 0) {
    const i = allow.indexOf(bucket);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }
  return 0;
}

export function sortByBucketPriority(cfg, candidates) {
  return [...candidates].sort((a, b) => {
    const r = bucketRank(cfg, a.row.bucket) - bucketRank(cfg, b.row.bucket);
    if (r !== 0) return r;
    return (b.row.score ?? 0) - (a.row.score ?? 0);
  });
}

/**
 * Per-author classifier audit row. Appended once per fresh candidate on
 * the live (DRY=0) path. Captures the full lifecycle of the decision —
 * classifier verdict, accept-gate result, and downstream promotion
 * outcome — so future runs aren't opaque about WHICH handle the rubric
 * rejected and WHY. JSONL at
 * ~/.ohwow/workspaces/<ws>/x-authors-classifier-log.jsonl.
 */
function classifierLogPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-authors-classifier-log.jsonl');
}
export function appendClassifierAudit(workspace, audit) {
  const p = classifierLogPath(workspace);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(audit) + '\n');
  } catch (e) {
    // Audit writes must never wedge the live loop.
    console.warn(`[x-authors-to-crm] classifier audit write failed: ${e.message}`);
  }
}

async function main() {
  const t0 = Date.now();
  // In DRY mode the daemon is not required (no HTTP calls happen), so
  // a missing daemon.token must not wedge the run. Fall back to a
  // resolved-by-env shape that exposes only the workspace name.
  let resolved;
  try { resolved = resolveOhwow(); }
  catch (e) {
    if (!DRY) throw e;
    const workspace = process.env.OHWOW_WORKSPACE || 'default';
    resolved = { url: '', token: '', workspace };
  }
  const { url, token, workspace } = resolved;
  const cfg = loadLeadGenConfig(workspace, { fs, os, path, logger: console });

  const date = today();
  const sidecarRows = readSidecar(workspace, date);
  const engagerRows = await harvestEngagers(cfg);

  // Upsert every observation into the ledger (cheap, no LLM).
  const ledger = loadLedger(workspace);
  let ledgerNew = 0;
  let ledgerUpdated = 0;
  for (const r of [...sidecarRows, ...engagerRows]) {
    if (!r || !r.handle) continue;
    const existed = ledger.has(r.handle.toLowerCase());
    upsertAuthor(ledger, {
      handle: r.handle,
      display_name: r.display_name,
      permalink: r.permalink,
      bucket: r.bucket,
      score: r.score,
      replies: r.replies,
      likes: r.likes,
      tags: r.tags,
      source: r.__source || 'sidecar',
    });
    if (existed) ledgerUpdated++; else ledgerNew++;
  }
  saveLedger(workspace, ledger);

  // Free-gate pass.
  const passed = [];
  let rejected = 0;
  for (const row of ledger.values()) {
    if (isQualified(ledger, row.handle)) continue;
    const verdict = freeGates(cfg, row);
    if (verdict.decision === 'pass') passed.push({ row, reason: verdict.reason });
    else rejected++;
  }

  // Server-side dedup against the CRM.
  let existingHandles = new Set();
  if (!DRY) {
    try { existingHandles = await fetchExistingHandles(url, token); }
    catch (e) { console.warn('[x-authors-to-crm] could not fetch existing handles:', e.message); }
  }
  // Sticky-accept dedup. Handles already proposed through the approval
  // queue (pending/approved/applied/auto_applied) shouldn't be
  // re-classified: that wastes a simple_classification LLM call and, more
  // importantly, risks the model returning a different verdict for
  // identical input and silently dropping a qualified lead. Rejected
  // entries intentionally pass through — operator override should not be
  // re-invented by this cache.
  const proposedHandles = DRY ? new Set() : loadProposedHandles(workspace, { loadQueue });
  const cachedSkips = [];
  const fresh = sortByBucketPriority(cfg, passed)
    .filter(({ row }) => {
      if (existingHandles.has(row.handle)) return false;
      if (proposedHandles.has(row.handle.toLowerCase())) {
        cachedSkips.push(row.handle);
        return false;
      }
      return true;
    })
    .slice(0, MAX_AUTHORS_PER_RUN);

  // Intent classification — one LLM call per fresh author.
  const briefDir = DRY ? `/tmp/x-authors-to-crm-${Date.now()}` : null;
  let llmCalls = 0;
  let promoted = 0;
  let pending = 0;
  let intentRejected = 0;
  let autoApproved = 0;
  const llmFn = async (args) => {
    llmCalls++;
    const r = await llm(args);
    return r?.text ?? r;
  };
  // Auto-approve gate for x_contact_create. Construction snapshots
  // today's already-auto-applied count from the queue so the daily cap
  // is enforced cross-run. Empty config → always returns false.
  const autoApproveRunState = { thisRunAutoApplied: 0 };
  const autoApproveGate = buildAutoApproveGate(cfg, workspace, autoApproveRunState, { loadQueue });

  for (const { row, reason } of fresh) {
    // DRY mode writes a per-candidate brief describing what WOULD happen.
    // It intentionally does not call the LLM: the point of DRY is a fast,
    // zero-cost preview of free-gate decisions. Flip DRY=0 for the live
    // run where classification + CRM writes happen.
    if (DRY) {
      writeBrief(briefDir, {
        id: `dry-${row.handle}`,
        status: 'would_classify_and_propose',
        kind: 'x_contact_create',
        summary: `@${row.handle} passed free-gates (${reason}), bucket ${row.bucket}`,
      }, { row });
      continue;
    }

    const audit = {
      ts: new Date().toISOString(),
      workspace,
      handle: row.handle,
      bucket: row.bucket,
      score: row.score,
      touches: row.touches,
      free_gate_reason: reason,
      intent: null,
      confidence: null,
      intent_reason: null,
      accepted: false,
      classify_error: null,
      proposed: false,
      auto_applied: false,
      promoted: false,
      promote_error: null,
    };

    try {
      let intent;
      try {
        intent = await classifyIntent(row, cfg, llmFn, { extractJson });
        audit.intent = intent.intent;
        audit.confidence = intent.confidence;
        audit.intent_reason = intent.reason;
      } catch (e) {
        audit.classify_error = e.message;
        console.warn(`[x-authors-to-crm] classify failed for @${row.handle}:`, e.message);
        continue;
      }

      audit.accepted = acceptsIntent(intent, cfg);
      if (!audit.accepted) { intentRejected++; continue; }

      const outreachToken = crypto.randomUUID();
      const proposal = {
        kind: 'x_contact_create',
        summary: `@${row.handle} → ${intent.intent} (conf ${intent.confidence.toFixed(2)}, bucket ${row.bucket})`,
        payload: {
          handle: row.handle,
          display_name: row.display_name,
          permalink: row.permalink,
          bucket: row.bucket,
          score: row.score,
          touches: row.touches,
          sources: row.sources,
          intent: intent.intent,
          confidence: intent.confidence,
          intent_reason: intent.reason,
          free_gate_reason: reason,
          outreach_token: outreachToken,
        },
      };

      const entry = propose({
        ...proposal,
        autoApproveAfter: 0,
        bucketBy: 'bucket',
        maxPriorRejected: 0,
        gate: autoApproveGate,
      });
      audit.proposed = true;
      audit.auto_applied = entry.status === 'auto_applied';
      if (audit.auto_applied) {
        autoApproveRunState.thisRunAutoApplied++;
        autoApproved++;
      } else { pending++; continue; }

      try {
        const contact = await createContact(url, token, {
          name: row.display_name || row.handle,
          contact_type: 'lead',
          status: 'active',
          tags: ['x', 'qualified', row.bucket, intent.intent].filter(Boolean),
          custom_fields: {
            x_handle: row.handle,
            x_permalink: row.permalink,
            x_bucket: row.bucket,
            x_score: row.score,
            x_intent: intent.intent,
            x_intent_confidence: intent.confidence,
            x_touches: row.touches,
            x_source: 'author-ledger',
          },
          never_sync: true,
          outreach_token: outreachToken,
        });
        await createEvent(url, token, contact.id, {
          kind: 'x:qualified',
          source: 'x-authors-to-crm',
          title: `qualified from X (${row.bucket})`,
          payload: {
            score: row.score,
            touches: row.touches,
            intent: intent.intent,
            confidence: intent.confidence,
            reason: intent.reason,
            permalink: row.permalink,
          },
        });
        markQualified(ledger, row.handle, contact.id);
        audit.promoted = true;
        promoted++;
      } catch (e) {
        audit.promote_error = e.message;
        console.error(`[x-authors-to-crm] promote failed for @${row.handle}:`, e.message);
      }
    } finally {
      appendClassifierAudit(workspace, audit);
    }
  }

  if (!DRY) saveLedger(workspace, ledger);

  const report = {
    workspace,
    date,
    dry: DRY,
    durationMs: Date.now() - t0,
    sidecarRows: sidecarRows.length,
    engagerRows: engagerRows.length,
    ledgerNew,
    ledgerUpdated,
    ledgerTotal: ledger.size,
    freeGatePassed: passed.length,
    freeGateRejected: rejected,
    existingCrm: existingHandles.size,
    alreadyProposed: cachedSkips.length,
    fresh: fresh.length,
    llmCalls,
    intentRejected,
    autoApproved,
    promoted,
    pending,
    briefDir,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

// Run main() only when invoked as a script, not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('x-authors-to-crm.mjs');
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { main, readSidecar, harvestEngagers, fetchExistingHandles };
