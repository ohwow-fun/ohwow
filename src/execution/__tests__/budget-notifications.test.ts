/**
 * Budget-notifications dispatcher tests. Gap 13 follow-up.
 *
 * The notifier adapts BudgetPulseEvent → EventBus emissions so the
 * daemon can surface warn/degrade/pause/halt transitions as in-app
 * toasts instead of burying them in pino logs. These tests pin the
 * mapping one event at a time, verify the summary copy follows the
 * house style (no em dashes, no "please", no "Failed to"), and check
 * that payload enrichment (taskClass, substitutedModel) lands only on
 * the degrade band.
 */

import { describe, it, expect } from 'vitest';
import { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import { createEventBusBudgetNotifier } from '../budget-notifications.js';
import type { BudgetPulseEvent } from '../budget-middleware.js';

type BudgetNotificationPayloadLoose = Record<string, unknown>;

function captureEvents(bus: TypedEventBus<RuntimeEvents>): {
  events: Array<{ name: string; payload: BudgetNotificationPayloadLoose }>;
} {
  const events: Array<{ name: string; payload: BudgetNotificationPayloadLoose }> = [];
  const names = ['budget:llm-warn', 'budget:llm-degrade', 'budget:llm-pause', 'budget:llm-halt'] as const;
  for (const name of names) {
    bus.on(name, (payload) => {
      events.push({ name, payload: payload as BudgetNotificationPayloadLoose });
    });
  }
  return { events };
}

describe('createEventBusBudgetNotifier', () => {
  const WS = 'ws-test';

  it('maps budget.warn → budget:llm-warn with a warm summary', () => {
    const bus = new TypedEventBus<RuntimeEvents>();
    const { events } = captureEvents(bus);
    const notify = createEventBusBudgetNotifier(bus);

    const event: BudgetPulseEvent = {
      type: 'budget.warn',
      workspaceId: WS,
      spentUsd: 37.5,
      limitUsd: 50,
      utilization: 0.75,
    };
    notify(event);

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('budget:llm-warn');
    expect(events[0].payload.band).toBe('warn');
    expect(events[0].payload.workspaceId).toBe(WS);
    expect(events[0].payload.spentUsd).toBe(37.5);
    expect(events[0].payload.limitUsd).toBe(50);
    const summary = String(events[0].payload.summary);
    expect(summary).toContain('$37.50');
    expect(summary).toContain('$50.00');
    // House style: no em/en dashes in user-facing copy.
    expect(summary).not.toMatch(/—|–/);
    // House style: no "Failed to" phrasing.
    expect(summary).not.toMatch(/^Failed to /i);
    // House style: no "please" in validation / notification copy.
    expect(summary).not.toMatch(/\bplease\b/i);
  });

  it('maps budget.degrade → budget:llm-degrade with taskClass + substitutedModel', () => {
    const bus = new TypedEventBus<RuntimeEvents>();
    const { events } = captureEvents(bus);
    const notify = createEventBusBudgetNotifier(bus);

    notify({
      type: 'budget.degrade',
      workspaceId: WS,
      spentUsd: 45,
      limitUsd: 50,
      utilization: 0.9,
      taskClass: 'agentic_coding',
      originalModel: 'claude-sonnet-4-6',
      substitutedModel: 'gemini-3.1-pro',
    });

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('budget:llm-degrade');
    expect(events[0].payload.band).toBe('degrade');
    expect(events[0].payload.taskClass).toBe('agentic_coding');
    expect(events[0].payload.substitutedModel).toBe('gemini-3.1-pro');
    const summary = String(events[0].payload.summary);
    expect(summary).toContain('gemini-3.1-pro');
    expect(summary).toContain('agentic_coding');
    expect(summary).not.toMatch(/—|–/);
  });

  it('maps budget.pause → budget:llm-pause with a next-step hint', () => {
    const bus = new TypedEventBus<RuntimeEvents>();
    const { events } = captureEvents(bus);
    const notify = createEventBusBudgetNotifier(bus);

    notify({
      type: 'budget.pause',
      workspaceId: WS,
      spentUsd: 48,
      limitUsd: 50,
      utilization: 0.96,
    });

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('budget:llm-pause');
    expect(events[0].payload.band).toBe('pause');
    const summary = String(events[0].payload.summary);
    expect(summary.toLowerCase()).toContain('paused');
    // Pause is actionable: the operator needs to know the two ways out.
    expect(summary.toLowerCase()).toMatch(/raise the cap|day to roll over/);
    expect(summary).not.toMatch(/—|–/);
  });

  it('maps budget.halt → budget:llm-halt with a next-step hint', () => {
    const bus = new TypedEventBus<RuntimeEvents>();
    const { events } = captureEvents(bus);
    const notify = createEventBusBudgetNotifier(bus);

    notify({
      type: 'budget.halt',
      workspaceId: WS,
      spentUsd: 51,
      limitUsd: 50,
      utilization: 1.02,
    });

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('budget:llm-halt');
    expect(events[0].payload.band).toBe('halt');
    const summary = String(events[0].payload.summary);
    expect(summary.toLowerCase()).toContain('halt');
    expect(summary.toLowerCase()).toContain('raise the cap');
    expect(summary).not.toMatch(/—|–/);
  });

  it('stamps an ISO-8601 ts on every payload', () => {
    const bus = new TypedEventBus<RuntimeEvents>();
    const { events } = captureEvents(bus);
    const notify = createEventBusBudgetNotifier(bus);

    notify({
      type: 'budget.warn',
      workspaceId: WS,
      spentUsd: 35,
      limitUsd: 50,
      utilization: 0.7,
    });

    expect(events).toHaveLength(1);
    const ts = String(events[0].payload.ts);
    // Matches YYYY-MM-DDTHH:MM:SS.sssZ
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
