/**
 * outreach-policy — cross-channel cooldown helper.
 *
 * Each outbound channel (X reply, X DM, email, whatever lands next)
 * runs on its own scheduler and approves/applies independently.
 * Without a shared gate, an agent that replies to a post AND DMs the
 * same author in the same hour looks like a bot to both the recipient
 * and X's spam heuristics. This helper is the one question every
 * channel asks before acting: "has anyone else in the system already
 * reached this contact recently?"
 *
 * Contract
 * --------
 * `isContactInCooldown(db, workspaceId, contactId, channel, override?)`
 * returns a CooldownCheck with `inCooldown: true` when at least one
 * of these events exists for the contact within the lookup window:
 *
 *   - outreach:proposed        (thermostat or similar proposer wrote one)
 *   - x:reached                (attribution hit endpoint fired)
 *   - dm:sent                  (x-dm-reply-dispatcher completed a send)
 *   - email:sent               (email-dispatcher completed a send)
 *   - dm_received              (contact replied inbound — don't pile on)
 *
 * The check is channel-agnostic across these kinds: a `dm:sent` blocks
 * a pending `x_reply` just like it blocks a pending `x_dm`. This is
 * intentional — the goal is "don't be annoying," not "respect
 * per-channel limits in isolation." Per-channel TUNING lives in the
 * cooldown-hours lookup, not in the event kind filter.
 *
 * Hours lookup
 * ------------
 * Resolution order:
 *   1. explicit `overrideHours` param
 *   2. runtime_config `outreach.cooldown_hours_by_channel`[channel]
 *      (JSON object, e.g. {"x_dm":72,"x_reply":48,"email":168})
 *   3. runtime_config `outreach.cooldown_hours_default`
 *   4. DEFAULT_COOLDOWN_HOURS (72)
 *
 * Callers: outreach-thermostat (pre-proposal gate), x-dm-reply-dispatcher
 * (pre-send gate), future x-reply-dispatcher + email-dispatcher.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from './logger.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';

export type OutreachChannel = 'x_dm' | 'x_reply' | 'email' | 'any';

export const DEFAULT_COOLDOWN_HOURS = 72;

export const COOLDOWN_CONFIG_KEYS = {
  defaultHours: 'outreach.cooldown_hours_default',
  byChannel: 'outreach.cooldown_hours_by_channel',
} as const;

/** Event kinds that count as "touched this contact already". */
export const COOLDOWN_EVENT_KINDS: ReadonlySet<string> = new Set([
  'outreach:proposed',
  'x:reached',
  'dm:sent',
  'email:sent',
  'dm_received',
]);

export interface CooldownCheck {
  inCooldown: boolean;
  /** Why — populated when inCooldown=true. */
  reason?: string;
  /** Kind of the most recent blocking event. */
  lastEventKind?: string;
  /** ISO timestamp of the most recent blocking event. */
  lastEventAt?: string;
  /** Hours actually used for the window. */
  windowHours: number;
}

/**
 * Resolve the cooldown window for a given channel. Synchronous because
 * getRuntimeConfig reads the module-level cache primed at daemon boot.
 * Never throws — any parsing error falls through to the next layer.
 */
export function resolveCooldownHours(
  channel: OutreachChannel,
  overrideHours?: number,
): number {
  if (typeof overrideHours === 'number' && overrideHours > 0) return overrideHours;
  const byChannel = getRuntimeConfig<Record<string, number> | null>(
    COOLDOWN_CONFIG_KEYS.byChannel,
    null,
  );
  if (byChannel && typeof byChannel === 'object') {
    const candidate = byChannel[channel];
    if (typeof candidate === 'number' && candidate > 0) return candidate;
  }
  const defaultHours = getRuntimeConfig<number>(
    COOLDOWN_CONFIG_KEYS.defaultHours,
    DEFAULT_COOLDOWN_HOURS,
  );
  if (typeof defaultHours === 'number' && defaultHours > 0) return defaultHours;
  return DEFAULT_COOLDOWN_HOURS;
}

interface EventRow {
  id: string;
  kind: string | null;
  occurred_at: string | null;
  created_at: string | null;
}

/**
 * Ask the cooldown gate. Returns {inCooldown: true} when at least one
 * COOLDOWN_EVENT_KINDS event exists for (workspaceId, contactId) within
 * the resolved window. Fail-closed on DB error: if the query throws,
 * the caller gets {inCooldown: true, reason: 'query_failed'} so a
 * transient DB hiccup can't trigger a burst of sends while the gate is
 * uncheckable.
 */
export async function isContactInCooldown(
  db: DatabaseAdapter,
  workspaceId: string,
  contactId: string,
  channel: OutreachChannel,
  overrideHours?: number,
): Promise<CooldownCheck> {
  const windowHours = resolveCooldownHours(channel, overrideHours);
  const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let rows: EventRow[] = [];
  try {
    const res = await db
      .from<EventRow>('agent_workforce_contact_events')
      .select('id, kind, occurred_at, created_at')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .gte('created_at', cutoffIso);
    rows = ((res as { data?: EventRow[] | null }).data ?? []) as EventRow[];
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, workspaceId, contactId, channel },
      '[outreach-policy] cooldown query failed — treating as in-cooldown',
    );
    return { inCooldown: true, reason: 'query_failed', windowHours };
  }

  let latest: EventRow | null = null;
  let latestMs = -Infinity;
  for (const r of rows) {
    if (!r.kind || !COOLDOWN_EVENT_KINDS.has(r.kind)) continue;
    const ts = Date.parse(r.occurred_at ?? r.created_at ?? '');
    if (!Number.isFinite(ts)) continue;
    if (ts < cutoffMs) continue;
    if (ts > latestMs) { latestMs = ts; latest = r; }
  }

  if (!latest) {
    return { inCooldown: false, windowHours };
  }
  return {
    inCooldown: true,
    reason: 'recent_touch',
    lastEventKind: latest.kind ?? undefined,
    lastEventAt: latest.occurred_at ?? latest.created_at ?? undefined,
    windowHours,
  };
}
