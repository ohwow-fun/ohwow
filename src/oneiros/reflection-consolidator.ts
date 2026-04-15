/**
 * Reflection consolidator — the hippocampus pass during oneiros sleep.
 *
 * Runs during deep_sleep / REM (caller's responsibility to gate on
 * SleepCycle.shouldConsolidate / shouldDream). Reads the last 24h of
 *  - <dataDir>/diary.jsonl (task-completion entries from diary-hook)
 *  - self_findings rows (experiment verdicts from the live loop)
 *
 * Calls the LLM exactly once to extract 3-7 structured observations:
 *  - "what repeated" — patterns the runtime keeps hitting
 *  - "what surprised" — outlier findings or unexpected wins
 *  - "what failed" — recurring failures that warrant attention
 *
 * Each observation lands as an `affective_memories` row (the table
 * has had no writer until now — this is its first producer) and the
 * batch is announced on the event bus as `reflection:consolidated`.
 *
 * Graceful degradation: missing diary file, empty findings, LLM
 * failure — all log warnings and return a structured result; nothing
 * throws.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export interface ReflectionConsolidatorBus {
  emit(event: 'reflection:consolidated', payload: ReflectionConsolidatedEvent): void;
}

export interface ReflectionConsolidatedEvent {
  workspace_id: string;
  window_start: string;
  window_end: string;
  diary_entries: number;
  findings_count: number;
  observations_written: number;
}

export type ObservationKind = 'repeated' | 'surprised' | 'failed';

export interface ReflectionObservation {
  kind: ObservationKind;
  text: string;
  evidence?: string[];
}

export interface ReflectionLLM {
  (prompt: string): Promise<string>;
}

export interface ConsolidateReflectionOptions {
  db: DatabaseAdapter;
  workspaceId: string;
  dataDir: string;
  bus?: ReflectionConsolidatorBus;
  llm: ReflectionLLM;
  /** Lookback window, defaults to 24h. */
  lookbackMs?: number;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface ConsolidateReflectionResult {
  ok: boolean;
  observations: ReflectionObservation[];
  diaryEntries: number;
  findingsCount: number;
  reason?: string;
}

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function consolidateReflection(
  opts: ConsolidateReflectionOptions,
): Promise<ConsolidateReflectionResult> {
  const now = (opts.now ?? (() => new Date()))();
  const windowMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const windowStart = new Date(now.getTime() - windowMs);

  const diaryEntries = readDiaryWindow(opts.dataDir, windowStart, now);
  const findings = await readFindingsWindow(opts.db, windowStart, now);

  if (diaryEntries.length === 0 && findings.length === 0) {
    logger.info({ workspaceId: opts.workspaceId }, '[reflection] nothing to consolidate in window');
    return { ok: true, observations: [], diaryEntries: 0, findingsCount: 0, reason: 'empty_window' };
  }

  const prompt = buildReflectionPrompt(diaryEntries, findings, windowStart, now);
  let rawResponse: string;
  try {
    rawResponse = await opts.llm(prompt);
  } catch (err) {
    logger.warn({ err }, '[reflection] LLM call failed');
    return {
      ok: false,
      observations: [],
      diaryEntries: diaryEntries.length,
      findingsCount: findings.length,
      reason: `llm_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const observations = parseObservations(rawResponse);
  if (observations.length === 0) {
    logger.warn({ rawResponse: rawResponse.slice(0, 200) }, '[reflection] no observations extracted');
    return {
      ok: false,
      observations: [],
      diaryEntries: diaryEntries.length,
      findingsCount: findings.length,
      reason: 'no_observations_parsed',
    };
  }

  let written = 0;
  for (const obs of observations) {
    try {
      await opts.db.from('affective_memories').insert({
        workspace_id: opts.workspaceId,
        experience_id: `reflection:${now.toISOString()}:${written}`,
        affect: obs.kind,
        valence: obs.kind === 'failed' ? -0.4 : obs.kind === 'surprised' ? 0.2 : 0.0,
        arousal: obs.kind === 'surprised' ? 0.6 : 0.3,
        content: obs.text,
      });
      written++;
    } catch (err) {
      logger.warn({ err }, '[reflection] failed to insert observation');
    }
  }

  const payload: ReflectionConsolidatedEvent = {
    workspace_id: opts.workspaceId,
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
    diary_entries: diaryEntries.length,
    findings_count: findings.length,
    observations_written: written,
  };
  opts.bus?.emit('reflection:consolidated', payload);

  logger.info(payload, '[reflection] consolidation complete');
  return {
    ok: true,
    observations,
    diaryEntries: diaryEntries.length,
    findingsCount: findings.length,
  };
}

/**
 * Read diary.jsonl and filter to entries with ts inside [start, end].
 * Missing file is not an error — returns [].
 */
export function readDiaryWindow(dataDir: string, start: Date, end: Date): Array<Record<string, unknown>> {
  const diaryPath = path.join(dataDir, 'diary.jsonl');
  if (!fs.existsSync(diaryPath)) return [];
  try {
    const raw = fs.readFileSync(diaryPath, 'utf-8');
    const entries: Array<Record<string, unknown>> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const ts = typeof obj.ts === 'string' ? new Date(obj.ts) : null;
        if (!ts || Number.isNaN(ts.getTime())) continue;
        if (ts >= start && ts <= end) entries.push(obj);
      } catch {
        // Skip malformed lines silently — one bad line should not
        // block the consolidator on all the good ones.
      }
    }
    return entries;
  } catch (err) {
    logger.warn({ err }, '[reflection] failed to read diary');
    return [];
  }
}

async function readFindingsWindow(
  db: DatabaseAdapter,
  start: Date,
  end: Date,
): Promise<Array<Record<string, unknown>>> {
  try {
    const { data } = await db
      .from<Record<string, unknown>>('self_findings')
      .select('id, experiment_id, category, subject, verdict, summary, ran_at')
      .gte('ran_at', start.toISOString())
      .lte('ran_at', end.toISOString());
    return data ?? [];
  } catch (err) {
    logger.warn({ err }, '[reflection] failed to read self_findings');
    return [];
  }
}

export function buildReflectionPrompt(
  diary: Array<Record<string, unknown>>,
  findings: Array<Record<string, unknown>>,
  start: Date,
  end: Date,
): string {
  const diarySlice = diary.slice(-80).map((d) =>
    `- [${d.ts}] ${d.status} | ${d.agent_name ?? d.agent_id} | ${d.title ?? ''}`,
  ).join('\n');
  const findingsSlice = findings.slice(-80).map((f) =>
    `- [${f.ran_at}] ${f.verdict} | ${f.experiment_id} | ${f.subject ?? ''} | ${f.summary ?? ''}`,
  ).join('\n');
  return `You are the reflection pass of an autonomous runtime. Read the last
${((end.getTime() - start.getTime()) / 3_600_000).toFixed(0)}h of this operator's runtime activity and
return 3 to 7 short structured observations.

Each observation must fall into exactly one kind:
  - "repeated" — a pattern that kept happening (tasks, failures, surprises)
  - "surprised" — an outlier or unexpected outcome worth remembering
  - "failed" — a recurring failure mode worth flagging

Output STRICT JSON, an array of objects with this shape:
  { "kind": "repeated" | "surprised" | "failed", "text": "<= 240 chars", "evidence": ["optional short pointers"] }

Do not include prose, code fences, or keys other than kind / text / evidence.

Generic phrasing only. Do not name specific customers, products, or amounts;
refer to patterns ("a class of tasks", "a particular agent") rather than
proper nouns.

=== diary.jsonl (${diary.length} entries) ===
${diarySlice || '(empty)'}

=== self_findings (${findings.length} rows) ===
${findingsSlice || '(empty)'}
`;
}

/** Tolerant parser: extracts the first JSON array and maps to observations. */
export function parseObservations(raw: string): ReflectionObservation[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ReflectionObservation[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    const text = rec.text;
    if (kind !== 'repeated' && kind !== 'surprised' && kind !== 'failed') continue;
    if (typeof text !== 'string' || text.length === 0) continue;
    const evidence = Array.isArray(rec.evidence)
      ? (rec.evidence.filter((e) => typeof e === 'string') as string[])
      : undefined;
    out.push({ kind, text: text.slice(0, 240), evidence });
    if (out.length >= 7) break;
  }
  return out;
}
