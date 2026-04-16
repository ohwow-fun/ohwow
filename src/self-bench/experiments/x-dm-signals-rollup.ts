/**
 * XDmSignalsRollupExperiment — bridges x_dm_signals → self_findings.
 *
 * Why this experiment exists
 * --------------------------
 * InnerThoughts' ContextSnapshot reads pending tasks, recent
 * completions, and overnight activity — it never queries
 * x_dm_signals. So trigger-phrase matches from inbound DMs are
 * invisible to the autonomous loop. This experiment writes one
 * summary self_findings row per trigger_phrase per window. The
 * finding-novelty scoring on writeFinding then surfaces sudden
 * spikes (e.g. "3 'pricing' signals in the last hour vs 0 baseline")
 * to anything that reads self_findings.
 *
 * Scope
 * -----
 * Rolls up trigger_phrase signals only. unknown_correspondent signals
 * are a different axis of noise (how many threads have no CRM match)
 * and should get their own probe if the signal earns its keep.
 *
 * Each run emits:
 *   - One per-phrase finding, subject='phrase:<trigger_phrase>',
 *     verdict='warning' when the 6h window contains >=3 signals,
 *     verdict='pass' otherwise. The per-phrase subject gives the
 *     novelty scorer a stable baseline to compare against, so a
 *     "pricing" spike from 0→5 in one window lights up hot.
 *   - One summary finding, subject='rollup', verdict='pass',
 *     summarizing how many phrases were rolled up. This is the
 *     ProbeResult the runner writes through the standard path; the
 *     per-phrase findings are direct writeFinding calls from inside
 *     businessProbe.
 *
 * Why write per-group directly vs. returning N ProbeResults
 * ---------------------------------------------------------
 * The runner expects one ProbeResult per probe(). Trying to squeeze
 * N groups into one result would give us only one novelty baseline
 * per run, collapsing all trigger phrases into a single signal —
 * exactly the wrong thing. Direct writeFinding per group keeps a
 * distinct (experiment_id, subject) baseline per phrase, so each
 * phrase spikes and decays on its own schedule.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import {
  BusinessExperiment,
  type BusinessExperimentOptions,
} from '../business-experiment.js';
import type {
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { writeFinding } from '../findings-store.js';

const MINUTE_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * MINUTE_MS;
const DEFAULT_WINDOW_MS = 6 * 60 * MINUTE_MS;
/** Per-phrase count that flips the per-group verdict to 'warning'. */
const WARNING_COUNT_THRESHOLD = 3;

interface SignalRow {
  trigger_phrase: string | null;
  conversation_pair: string;
  message_id: string;
  primary_name: string | null;
  text: string | null;
  contact_id: string | null;
  observed_at: string;
}

interface PhraseGroup {
  phrase: string;
  count: number;
  uniquePairs: number;
  contactsLinked: number;
  firstAt: string;
  lastAt: string;
  sampleTexts: string[];
}

export class XDmSignalsRollupExperiment extends BusinessExperiment {
  id = 'x-dm-signals-rollup';
  name = 'X DM trigger-phrase rollup';
  category: ExperimentCategory = 'dm_intel';
  hypothesis =
    'Trigger-phrase matches from inbound DMs carry operator-relevant '
    + 'signal (pricing asks, escalations) that the autonomous loop cannot '
    + 'see through ContextSnapshot. Rolling them into self_findings with '
    + 'per-phrase novelty baselines surfaces spikes to any reader of '
    + 'findings without wiring a separate consumer.';
  cadence: ExperimentCadence = {
    everyMs: DEFAULT_INTERVAL_MS,
    runOnBoot: true,
  };

  private readonly windowMs: number;

  constructor(opts: BusinessExperimentOptions & { windowMs?: number } = {}) {
    super(opts);
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const nowMs = Date.now();
    const windowStartIso = new Date(nowMs - this.windowMs).toISOString();
    const rows = await this.readRecentSignals(ctx.db, ctx.workspaceId, windowStartIso);
    const groups = rollupByPhrase(rows);

    // Emit one finding per phrase so the novelty scorer has a
    // stable baseline per subject. supersedeDuplicates in
    // writeFinding will collapse back-to-back runs with identical
    // (experiment_id, subject, summary) into one active row.
    const ranAtIso = new Date(nowMs).toISOString();
    const writtenGroups: Array<{ phrase: string; verdict: Verdict; findingId: string }> = [];
    for (const group of groups) {
      const verdict: Verdict = group.count >= WARNING_COUNT_THRESHOLD ? 'warning' : 'pass';
      try {
        const findingId = await writeFinding(ctx.db, {
          experimentId: this.id,
          category: this.category,
          subject: `phrase:${group.phrase}`,
          hypothesis: this.hypothesis,
          verdict,
          summary:
            `${group.count} '${group.phrase}' signal${group.count === 1 ? '' : 's'} in last `
            + `${Math.round(this.windowMs / MINUTE_MS)}m across ${group.uniquePairs} thread${group.uniquePairs === 1 ? '' : 's'} `
            + `(${group.contactsLinked} linked to contacts)`,
          evidence: {
            phrase: group.phrase,
            count: group.count,
            unique_pairs: group.uniquePairs,
            contacts_linked: group.contactsLinked,
            window_ms: this.windowMs,
            first_at: group.firstAt,
            last_at: group.lastAt,
            sample_texts: group.sampleTexts,
          },
          interventionApplied: null,
          ranAt: ranAtIso,
          durationMs: 0,
        });
        writtenGroups.push({ phrase: group.phrase, verdict, findingId });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, phrase: group.phrase },
          '[XDmSignalsRollupExperiment] per-group writeFinding failed',
        );
      }
    }

    return {
      subject: 'rollup',
      summary:
        `Rolled up ${groups.length} trigger-phrase group${groups.length === 1 ? '' : 's'} `
        + `from ${rows.length} signal${rows.length === 1 ? '' : 's'} in the last `
        + `${Math.round(this.windowMs / MINUTE_MS)}m`,
      evidence: {
        signals_total: rows.length,
        phrase_count: groups.length,
        window_ms: this.windowMs,
        warning_groups: writtenGroups.filter((g) => g.verdict === 'warning').length,
        per_group: writtenGroups,
      },
    };
  }

  protected businessJudge(_result: ProbeResult, _history: Finding[]): Verdict {
    // The summary finding itself is always 'pass' — per-group findings
    // carry the per-phrase verdicts. Escalating the summary row too
    // would create two novelty signals for the same underlying event
    // (the phrase spike), muddying whatever reads findings.
    return 'pass';
  }

  private async readRecentSignals(
    db: DatabaseAdapter,
    workspaceId: string,
    sinceIso: string,
  ): Promise<SignalRow[]> {
    const { data } = await db
      .from<SignalRow>('x_dm_signals')
      .select('trigger_phrase, conversation_pair, message_id, primary_name, text, contact_id, observed_at')
      .eq('workspace_id', workspaceId)
      .eq('signal_type', 'trigger_phrase')
      .gte('observed_at', sinceIso);
    return (data ?? []) as SignalRow[];
  }
}

/** Pure helper — exported for unit tests. */
export function rollupByPhrase(rows: SignalRow[]): PhraseGroup[] {
  const byPhrase = new Map<string, {
    pairs: Set<string>;
    contacts: Set<string>;
    count: number;
    firstAt: string;
    lastAt: string;
    sampleTexts: string[];
  }>();

  for (const row of rows) {
    const phrase = row.trigger_phrase?.trim();
    if (!phrase) continue;
    let entry = byPhrase.get(phrase);
    if (!entry) {
      entry = {
        pairs: new Set(),
        contacts: new Set(),
        count: 0,
        firstAt: row.observed_at,
        lastAt: row.observed_at,
        sampleTexts: [],
      };
      byPhrase.set(phrase, entry);
    }
    entry.count++;
    entry.pairs.add(row.conversation_pair);
    if (row.contact_id) entry.contacts.add(row.contact_id);
    if (row.observed_at < entry.firstAt) entry.firstAt = row.observed_at;
    if (row.observed_at > entry.lastAt) entry.lastAt = row.observed_at;
    if (entry.sampleTexts.length < 3 && row.text) {
      entry.sampleTexts.push(row.text.slice(0, 120));
    }
  }

  return [...byPhrase.entries()]
    .map(([phrase, e]) => ({
      phrase,
      count: e.count,
      uniquePairs: e.pairs.size,
      contactsLinked: e.contacts.size,
      firstAt: e.firstAt,
      lastAt: e.lastAt,
      sampleTexts: e.sampleTexts,
    }))
    .sort((a, b) => b.count - a.count);
}
