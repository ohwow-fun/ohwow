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
 * Kept intentionally thin. If a future round adds email or SMS
 * delivery, compose another notifier and call both from the daemon
 * wiring (the middleware accepts a single `emitPulse` function today;
 * bundle two together if needed).
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
