/**
 * ops-knobs.ts — Registry of operational levers the autonomous loop
 * can observe, and later, nominate changes to.
 *
 * Foundation file for the ops-telos phase. The goal is to make ohwow's
 * real-world operational behaviour (X posting cadence, approval
 * auto-accept thresholds, outreach dispatch rate, budget caps) visible
 * to the self-bench loop as structured knobs rather than scattered
 * config files. Once the loop can see them, it can propose changes
 * with receipts (same pattern as tier-2 patch-author + Fixes-Finding-Id).
 *
 * This file does NOT mutate anything. It only reads. Mutation happens
 * later behind a dedicated experiment with its own gate.
 *
 * A knob is a declarative tuple:
 *   key          — stable identifier, dotted (e.g. 'x_compose.weekly_target')
 *   description  — one-sentence explanation of what the knob controls
 *   read         — async function returning the current value (or null)
 *   unit         — 'count' | 'cents' | 'ratio' | 'hours' | 'bool'
 *   saneRange    — optional [min, max] for observability (not enforced)
 *
 * Add a knob here when a new ops surface becomes observable. Keep the
 * registry narrow — each entry should point at a single, named knob
 * whose change would visibly shift an outcome (posts landed, replies
 * received, dollars burned, deals closed).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type OpsKnobUnit = 'count' | 'cents' | 'ratio' | 'hours' | 'bool';

export interface OpsKnob {
  key: string;
  description: string;
  unit: OpsKnobUnit;
  saneRange?: [number, number];
  read: () => Promise<number | boolean | null>;
}

export interface OpsKnobReading {
  key: string;
  description: string;
  unit: OpsKnobUnit;
  saneRange: [number, number] | null;
  value: number | boolean | null;
  in_range: boolean | null;
}

function workspaceDir(): string {
  return path.join(
    os.homedir(),
    '.ohwow',
    'workspaces',
    process.env.OHWOW_WORKSPACE ?? 'default',
  );
}

function readJsonField<T>(file: string, field: string): T | null {
  try {
    const raw = fs.readFileSync(path.join(workspaceDir(), file), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (parsed[field] as T) ?? null;
  } catch { return null; }
}

export const OPS_KNOBS: readonly OpsKnob[] = [
  {
    key: 'x_compose.weekly_target',
    description: 'Target X posts per week. Drives the autonomy-ramp allowlist.',
    unit: 'count',
    saneRange: [3, 21],
    read: async () => {
      const v = readJsonField<number>('x-autonomy-allowlist.json', 'weekly_target');
      return typeof v === 'number' ? v : null;
    },
  },
  {
    key: 'x_compose.weekly_actual',
    description: 'Posts observed in the last 7d (outcome, not a lever — tracked so the loop can compare against target).',
    unit: 'count',
    saneRange: [0, 50],
    read: async () => {
      const v = readJsonField<number>('x-autonomy-allowlist.json', 'weekly_actual');
      return typeof v === 'number' ? v : null;
    },
  },
  {
    key: 'x_compose.weekly_deficit',
    description: 'weekly_target minus weekly_actual. Positive = under-posting; negative = over-posting.',
    unit: 'count',
    saneRange: [-5, 5],
    read: async () => {
      const v = readJsonField<number>('x-autonomy-allowlist.json', 'weekly_deficit');
      return typeof v === 'number' ? v : null;
    },
  },
  {
    key: 'burn.daily_cap_cents',
    description: 'Hard cap on daily LLM spend. Null = no cap; env var OHWOW_BURN_DAILY_CAP_CENTS or runtime-config burn.daily_cap_cents activates the BurnGuardExperiment throttle.',
    unit: 'cents',
    saneRange: [1000, 50000],
    read: async () => {
      const env = process.env.OHWOW_BURN_DAILY_CAP_CENTS;
      if (env && env.trim() !== '') {
        const parsed = Number(env);
        if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
      }
      return null;
    },
  },
];

export async function readAllKnobs(): Promise<OpsKnobReading[]> {
  const out: OpsKnobReading[] = [];
  for (const knob of OPS_KNOBS) {
    let value: number | boolean | null = null;
    try { value = await knob.read(); } catch { value = null; }
    const inRange = (() => {
      if (value === null || typeof value === 'boolean' || !knob.saneRange) return null;
      return value >= knob.saneRange[0] && value <= knob.saneRange[1];
    })();
    out.push({
      key: knob.key,
      description: knob.description,
      unit: knob.unit,
      saneRange: knob.saneRange ?? null,
      value,
      in_range: inRange,
    });
  }
  return out;
}
