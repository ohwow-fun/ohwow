/**
 * Budget notifications — operator-visible bridge for the four LLM
 * budget band transitions. Gap 13 follow-up.
 *
 * The budget middleware in `budget-middleware.ts` produces pulse events
 * for every band crossing (warn / degrade / pause / halt). Historically
 * those events only reached a `pino` log line, so a founder running the
 * dashboard never saw the daily cap approach, demote, or halt until
 * they opened the daemon logs. This helper adapts the pulse events
 * into EventBus emissions (`budget:llm-*`), which the websocket bridge
 * in `src/api/websocket.ts` forwards to connected dashboards, which
 * `useEventToasts.ts` renders as in-app toasts.
 *
 * Copy is deliberately warm and direct: no "please", no em dashes, no
 * "Failed to". The founder should read these at a glance and know what
 * happened and what to try next. Per CLAUDE.md, the summary string on
 * each event ends with a next-step hint when the band requires action.
 *
 * Wiring: daemon boot constructs `createEventBusBudgetNotifier(bus)`
 * and passes it as `deps.budget.emitPulse` into every `runLlmCall`
 * site that goes through the autonomous path (tool-dispatch/llm-
 * executor + scheduler-driven tools). Interactive call sites skip the
 * middleware, so they never reach this notifier — operator-initiated
 * work does not generate budget toasts, which is the intent.
 */

import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { BudgetPulseEvent } from './budget-middleware.js';
import type { EmailSender } from '../integrations/email/resend.js';
import { logger } from '../lib/logger.js';

/**
 * Shape shared by every budget notification payload the EventBus carries.
 * Downstream toast / email renderers can use `summary` as the one-line
 * operator message and `band` to pick a style/severity.
 */
export interface BudgetNotificationPayload {
  workspaceId: string;
  band: 'warn' | 'degrade' | 'pause' | 'halt';
  spentUsd: number;
  limitUsd: number;
  /** 0-1 utilization snapshot at the moment the transition fired. */
  utilization: number;
  /** Task class that triggered a degrade, when known. Undefined for the other bands. */
  taskClass?: string;
  /** Demoted-to model at the 85-95% band. Undefined for the other bands. */
  substitutedModel?: string;
  /** One-line operator message. Safe to render verbatim in a toast. */
  summary: string;
  /** UTC ISO-8601 wall clock when the pulse was built. */
  ts: string;
}

function buildSummary(event: BudgetPulseEvent): string {
  const spend = `$${event.spentUsd.toFixed(2)}`;
  const cap = `$${event.limitUsd.toFixed(2)}`;
  switch (event.type) {
    case 'budget.warn':
      return `Today's autonomous LLM spend is ${spend} of the ${cap} cap. Heads up, not yet limiting.`;
    case 'budget.degrade':
      return `Autonomous LLM spend is ${spend} of ${cap}. Demoting ${event.taskClass} from ${event.originalModel} to ${event.substitutedModel} for the rest of the day.`;
    case 'budget.pause':
      return `Autonomous LLM work is paused for today. Spend ${spend} is at or above 95% of the ${cap} cap. Raise the cap in workspace.json or wait for the day to roll over.`;
    case 'budget.halt':
      return `Autonomous LLM work is halted for today. Spend ${spend} hit the ${cap} cap. Raise the cap to resume.`;
  }
}

function pulseToPayload(event: BudgetPulseEvent): BudgetNotificationPayload {
  const base: BudgetNotificationPayload = {
    workspaceId: event.workspaceId,
    band: event.type === 'budget.warn' ? 'warn'
        : event.type === 'budget.degrade' ? 'degrade'
        : event.type === 'budget.pause' ? 'pause'
        : 'halt',
    spentUsd: event.spentUsd,
    limitUsd: event.limitUsd,
    utilization: event.utilization,
    summary: buildSummary(event),
    ts: new Date().toISOString(),
  };
  if (event.type === 'budget.degrade') {
    base.taskClass = event.taskClass;
    base.substitutedModel = event.substitutedModel;
  }
  return base;
}

/**
 * Build an `emitPulse` callback that fans a `BudgetPulseEvent` out onto
 * the runtime EventBus. The websocket bridge (`src/api/websocket.ts`)
 * must list the four `budget:llm-*` names in its FORWARDED_EVENTS
 * array so the cloud dashboard sees them. The TUI picks them up the
 * same way it picks up any other runtime event.
 *
 * Kept intentionally thin. Email delivery on pause/halt lives in
 * `createEmailBudgetNotifier` below; the daemon wiring in
 * `src/daemon/init.ts` composes both into a single emitPulse callback
 * (the middleware accepts one function, so both delivery legs share
 * the same BudgetPulseEvent emission).
 */
export function createEventBusBudgetNotifier(
  bus: TypedEventBus<RuntimeEvents>,
): (event: BudgetPulseEvent) => void {
  return (event: BudgetPulseEvent) => {
    const payload = pulseToPayload(event);
    switch (event.type) {
      case 'budget.warn':
        bus.emit('budget:llm-warn', payload);
        return;
      case 'budget.degrade':
        bus.emit('budget:llm-degrade', payload);
        return;
      case 'budget.pause':
        bus.emit('budget:llm-pause', payload);
        return;
      case 'budget.halt':
        bus.emit('budget:llm-halt', payload);
        return;
    }
  };
}

/**
 * Options for the email-delivery leg of the notifier.
 *
 * The operator only wants email on the pause/halt bands — warn/degrade
 * are visible in the dashboard and don't need an inbox ping. The
 * notifier enforces this filter itself rather than relying on callers
 * to compose it correctly.
 *
 * Idempotency: `${workspaceId}:${band}:${yyyy-mm-dd}` is forwarded as
 * Resend's Idempotency-Key header so a daemon restart that re-fires the
 * same band on the same UTC day doesn't double-send. The emittedToday
 * tracker in `budget-middleware.ts` already guarantees one pulse per
 * band per day per workspace, so this header is belt-and-suspenders.
 */
export interface EmailBudgetNotifierOptions {
  emailSender: EmailSender;
  /** Operator inbox. Undefined means skip. */
  toAddress: string;
  /** Sent-by name + address. Resend requires a verified sender. */
  fromAddress: string;
}

function formatIdempotencyKey(event: BudgetPulseEvent): string {
  const band = event.type === 'budget.pause' ? 'pause' : 'halt';
  const day = new Date().toISOString().slice(0, 10);
  return `budget:${event.workspaceId}:${band}:${day}`;
}

function buildEmailBody(event: BudgetPulseEvent): { subject: string; text: string } {
  const spend = `$${event.spentUsd.toFixed(2)}`;
  const cap = `$${event.limitUsd.toFixed(2)}`;
  const isHalt = event.type === 'budget.halt';
  const subject = isHalt
    ? `ohwow: autonomous LLM work halted today (${spend} of ${cap})`
    : `ohwow: autonomous LLM work paused today (${spend} of ${cap})`;
  const action = 'Raise the cap in Settings, Runtime tab, or wait for the UTC day to roll over.';
  const text = [
    isHalt
      ? `Autonomous LLM work is halted for today. Spend ${spend} hit the ${cap} daily cap for workspace ${event.workspaceId}.`
      : `Autonomous LLM work is paused for today. Spend ${spend} is at or above 95% of the ${cap} daily cap for workspace ${event.workspaceId}.`,
    '',
    action,
    '',
    'Sent by your ohwow daemon. Interactive calls from the dashboard and TUI are unaffected.',
  ].join('\n');
  return { subject, text };
}

/**
 * Build an `emitPulse` callback that delivers an email on the pause/halt
 * bands via the provided Resend-shaped `EmailSender`. Warn/degrade events
 * are ignored — those bands are dashboard-only. Errors inside `send` are
 * swallowed with a log line; a mailer hiccup must not break the hot path
 * the middleware is on.
 *
 * Compose with `createEventBusBudgetNotifier` at the daemon boundary so
 * both deliveries fire off the same BudgetPulseEvent. See the wiring in
 * `src/daemon/init.ts`.
 */
export function createEmailBudgetNotifier(
  opts: EmailBudgetNotifierOptions,
): (event: BudgetPulseEvent) => void {
  return (event: BudgetPulseEvent) => {
    if (event.type !== 'budget.pause' && event.type !== 'budget.halt') return;
    const { subject, text } = buildEmailBody(event);
    const idempotencyKey = formatIdempotencyKey(event);
    // Fire-and-forget. The middleware doesn't want to wait for the
    // mailer, and the emittedToday tracker upstream already debounces
    // duplicates so a failed send won't leave a hole the next tick fills.
    void opts.emailSender({
      to: opts.toAddress,
      subject,
      text,
      idempotencyKey,
      tags: [
        { name: 'kind', value: 'budget' },
        { name: 'band', value: event.type === 'budget.pause' ? 'pause' : 'halt' },
      ],
    })
      .then((result) => {
        if (!result.ok) {
          logger.warn(
            { band: event.type, reason: result.reason, status: result.status },
            '[budget-notifications] email send failed',
          );
        } else {
          logger.info(
            { band: event.type, providerId: result.providerId, to: opts.toAddress },
            '[budget-notifications] operator email sent',
          );
        }
      })
      .catch((err) => {
        logger.warn({ err, band: event.type }, '[budget-notifications] email send threw');
      });
  };
}
