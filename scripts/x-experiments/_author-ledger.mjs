/**
 * Author ledger: workspace-local JSONL of every X author we've observed
 * across runs of the x-intel / x-authors-to-crm pipeline.
 *
 * This is the signal reservoir. It is NOT the CRM. The CRM holds only
 * *qualified* contacts — authors that passed the workspace's lead-gen
 * rubric. The ledger accumulates cheap engagement signals (score, bucket,
 * replies, likes, tags, source, touches) across runs with zero LLM cost,
 * so the qualifier can make a decision on richer evidence than a single
 * sidecar row and so we never re-classify an author we've seen before.
 *
 * File: ~/.ohwow/workspaces/<ws>/x-authors-ledger.jsonl
 * One row per handle (case-folded). Rewrites the whole file on each
 * upsert — cheap until a workspace sees >50k authors, at which point
 * we'd split by first-letter or move to sqlite.
 *
 * Row shape:
 *   {
 *     handle,              // case-folded key
 *     display_name,
 *     permalink,           // last seen
 *     bucket,              // last seen (or highest-signal if source==engager)
 *     score,               // max across all observations
 *     replies,             // max across all observations
 *     likes,               // max across all observations
 *     tags,                // union across observations
 *     sources,             // set of 'sidecar' | 'engager:own-post' | 'engager:competitor' | 'dm'
 *     touches,             // total observation count
 *     first_seen_ts,       // ISO
 *     last_seen_ts,        // ISO
 *     qualified_ts,        // ISO or null — when promoted to CRM
 *     crm_contact_id,      // string or null — set when promoted
 *   }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function ledgerPath(workspace) {
  return path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-authors-ledger.jsonl');
}

export function loadLedger(workspace) {
  const p = ledgerPath(workspace);
  if (!fs.existsSync(p)) return new Map();
  const map = new Map();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.handle) map.set(row.handle.toLowerCase(), row);
    } catch {}
  }
  return map;
}

export function saveLedger(workspace, ledger) {
  const p = ledgerPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const rows = [...ledger.values()];
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/**
 * Merge a freshly observed author row into the ledger. Returns the
 * updated row. Mutates the ledger map in place.
 *
 *   observation: {
 *     handle, display_name?, permalink?, bucket?,
 *     score?, replies?, likes?, tags?, source?
 *   }
 */
export function upsertAuthor(ledger, observation) {
  const handle = String(observation.handle || '').toLowerCase();
  if (!handle) throw new Error('upsertAuthor: handle is required');
  const now = new Date().toISOString();
  const prev = ledger.get(handle);
  const mergedTags = new Set([...(prev?.tags || []), ...(observation.tags || [])]);
  const mergedSources = new Set([...(prev?.sources || []), ...(observation.source ? [observation.source] : [])]);
  const next = {
    handle,
    display_name: observation.display_name || prev?.display_name || null,
    permalink: observation.permalink || prev?.permalink || null,
    bucket: observation.bucket || prev?.bucket || null,
    score: Math.max(prev?.score ?? 0, observation.score ?? 0),
    replies: Math.max(prev?.replies ?? 0, observation.replies ?? 0),
    likes: Math.max(prev?.likes ?? 0, observation.likes ?? 0),
    tags: [...mergedTags],
    sources: [...mergedSources],
    touches: (prev?.touches ?? 0) + 1,
    first_seen_ts: prev?.first_seen_ts || now,
    last_seen_ts: now,
    qualified_ts: prev?.qualified_ts ?? null,
    crm_contact_id: prev?.crm_contact_id ?? null,
  };
  ledger.set(handle, next);
  return next;
}

export function markQualified(ledger, handle, crmContactId) {
  const key = String(handle).toLowerCase();
  const row = ledger.get(key);
  if (!row) return null;
  row.qualified_ts = new Date().toISOString();
  row.crm_contact_id = crmContactId;
  ledger.set(key, row);
  return row;
}

export function isQualified(ledger, handle) {
  const row = ledger.get(String(handle).toLowerCase());
  return !!row && !!row.qualified_ts;
}
