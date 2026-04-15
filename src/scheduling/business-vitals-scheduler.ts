/**
 * Business Vitals Scheduler
 *
 * Every 15 minutes, writes one row to `business_vitals` so the
 * homeostasis controller has real business signal to read. Each tick:
 *   1. Aggregates today's `agent_workforce_tasks.cost_cents` for this
 *      workspace. Always runs — no external creds needed.
 *   2. If STRIPE_API_KEY is set, fetches active Stripe subscriptions
 *      and derives MRR (cents) + ARR. If not set, skips silently.
 *
 * The row is written generically: the `source` column names the
 * producer ("stripe" when Stripe was reachable, otherwise
 * "tasks_aggregate"). No business-specific product/customer filters
 * are hardcoded; any filtering an operator needs lives in env
 * (STRIPE_PRODUCT_FILTER, comma-separated product IDs).
 *
 * The scheduler follows the same start/stop/tick pattern as
 * ConnectorSyncScheduler so the daemon can spin it up and tear it
 * down alongside the other schedulers.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export interface StripeMrrResult {
  ok: boolean;
  mrr_cents?: number;
  reason?: string;
}

export interface StripeMrrFetcher {
  (env: NodeJS.ProcessEnv): Promise<StripeMrrResult>;
}

export interface BusinessVitalsDeps {
  stripeFetcher?: StripeMrrFetcher;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export class BusinessVitalsScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    private deps: BusinessVitalsDeps = {},
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info('[BusinessVitalsScheduler] Starting');
    this.tick().catch((err) => {
      logger.error({ err }, '[BusinessVitalsScheduler] Initial tick failed');
    });
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, '[BusinessVitalsScheduler] Tick failed');
      });
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[BusinessVitalsScheduler] Stopped');
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const env = this.deps.env ?? process.env;
      const now = (this.deps.now ?? (() => new Date()))();
      const dailyCost = await this.aggregateDailyCostCents(now);

      const stripeFetcher = this.deps.stripeFetcher ?? defaultStripeFetcher;
      const stripeResult = env.STRIPE_API_KEY
        ? await stripeFetcher(env)
        : { ok: false, reason: 'STRIPE_API_KEY not set' };

      const source = stripeResult.ok ? 'stripe' : 'tasks_aggregate';
      const mrr = stripeResult.ok ? stripeResult.mrr_cents ?? null : null;
      const arr = mrr !== null ? mrr * 12 : null;

      await this.db.from('business_vitals').insert({
        workspace_id: this.workspaceId,
        ts: now.toISOString(),
        mrr,
        arr,
        active_users: null,
        daily_cost_cents: dailyCost,
        runway_days: null,
        source,
      });

      logger.info(
        { workspace_id: this.workspaceId, source, mrr, daily_cost_cents: dailyCost, stripe_skipped_reason: stripeResult.ok ? undefined : stripeResult.reason },
        '[BusinessVitalsScheduler] vital recorded',
      );
    } catch (err) {
      logger.error({ err }, '[BusinessVitalsScheduler] Tick errored');
    } finally {
      this.running = false;
    }
  }

  /**
   * Sum cost_cents across agent_workforce_tasks rows whose
   * completed_at falls on the same UTC date as `now`. Tasks with no
   * completed_at are ignored. Returns 0 when the table is empty or
   * unreachable.
   */
  async aggregateDailyCostCents(now: Date): Promise<number> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    try {
      const { data } = await this.db
        .from<{ cost_cents: number | null }>('agent_workforce_tasks')
        .select('cost_cents')
        .eq('workspace_id', this.workspaceId)
        .gte('completed_at', dayStart.toISOString())
        .lt('completed_at', dayEnd.toISOString());
      if (!data) return 0;
      return data.reduce((sum, row) => sum + (row.cost_cents ?? 0), 0);
    } catch (err) {
      logger.warn({ err }, '[BusinessVitalsScheduler] cost aggregation failed');
      return 0;
    }
  }
}

/**
 * Derive MRR in cents from the Stripe API by summing active
 * subscription items' `plan.amount * quantity`, normalized by
 * `plan.interval` (month=1, year=1/12, week=4.345, day=30).
 *
 * Uses fetch() directly against api.stripe.com — no SDK dep. All
 * error paths return `ok: false` with a reason; nothing throws.
 *
 * Generic by design: no product/customer filtering is baked in.
 * Operators who need to exclude certain products can set
 * STRIPE_PRODUCT_FILTER to a comma-separated list of product IDs to
 * keep (inclusive allow-list).
 */
export const defaultStripeFetcher: StripeMrrFetcher = async (env) => {
  const apiKey = env.STRIPE_API_KEY;
  if (!apiKey) return { ok: false, reason: 'STRIPE_API_KEY not set' };
  const allowProducts = (env.STRIPE_PRODUCT_FILTER || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowSet = allowProducts.length > 0 ? new Set(allowProducts) : null;
  try {
    let mrrCents = 0;
    let startingAfter: string | undefined;
    const base = 'https://api.stripe.com/v1/subscriptions?status=active&limit=100&expand[]=data.items.data.price.product';
    for (let page = 0; page < 20; page++) {
      const url = startingAfter ? `${base}&starting_after=${startingAfter}` : base;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!resp.ok) {
        return { ok: false, reason: `stripe_http_${resp.status}` };
      }
      const body = (await resp.json()) as StripeSubscriptionsResponse;
      for (const sub of body.data ?? []) {
        for (const item of sub.items?.data ?? []) {
          const price = item.price;
          if (!price?.recurring) continue;
          const productId = typeof price.product === 'string' ? price.product : price.product?.id;
          if (allowSet && productId && !allowSet.has(productId)) continue;
          const qty = item.quantity ?? 1;
          const amount = price.unit_amount ?? 0;
          mrrCents += normalizeToMonthly(amount, price.recurring.interval, price.recurring.interval_count ?? 1) * qty;
        }
      }
      if (!body.has_more || !body.data?.length) break;
      startingAfter = body.data[body.data.length - 1].id;
    }
    return { ok: true, mrr_cents: Math.round(mrrCents) };
  } catch (err) {
    return { ok: false, reason: `stripe_fetch_error: ${err instanceof Error ? err.message : String(err)}` };
  }
};

/** Normalize a recurring price amount into cents-per-month. */
export function normalizeToMonthly(amount: number, interval: string, intervalCount: number): number {
  const count = intervalCount || 1;
  switch (interval) {
    case 'month': return amount / count;
    case 'year': return (amount / count) / 12;
    case 'week': return (amount / count) * 4.345;
    case 'day': return (amount / count) * 30;
    default: return 0;
  }
}

interface StripeSubscriptionsResponse {
  data?: Array<{
    id: string;
    items?: {
      data?: Array<{
        quantity?: number;
        price?: {
          unit_amount?: number;
          recurring?: { interval: string; interval_count?: number };
          product?: string | { id: string };
        };
      }>;
    };
  }>;
  has_more?: boolean;
}
