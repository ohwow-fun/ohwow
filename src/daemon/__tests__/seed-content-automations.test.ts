/**
 * seed-content-automations tests. Verify shape + idempotence for the
 * in-process scheduler migrations (x-draft-distiller, content-cadence).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const listMock = vi.fn();
const createMock = vi.fn();
vi.mock('../../triggers/automation-service.js', () => ({
  AutomationService: class {
    list = listMock;
    create = createMock;
  },
}));

import {
  seedXDraftDistillerAutomation,
  seedContentCadenceAutomation,
  X_DRAFT_DISTILLER_AUTOMATION_NAME,
  CONTENT_CADENCE_AUTOMATION_NAME,
  X_DRAFT_DISTILLER_HANDLER,
  CONTENT_CADENCE_HANDLER,
} from '../seed-content-automations.js';

describe('seedXDraftDistillerAutomation', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
  });

  it('creates a run_internal automation with the canonical handler name', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'distiller-auto' });

    const id = await seedXDraftDistillerAutomation({} as never, 'ws-1');

    expect(id).toBe('distiller-auto');
    const input = createMock.mock.calls[0][0];
    expect(input.name).toBe(X_DRAFT_DISTILLER_AUTOMATION_NAME);
    expect(input.trigger_config.cron).toBe('0 * * * *');
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0].step_type).toBe('run_internal');
    expect(input.steps[0].action_config.handler_name).toBe(X_DRAFT_DISTILLER_HANDLER);
  });

  it('is idempotent', async () => {
    listMock.mockResolvedValue([{ id: 'existing', name: X_DRAFT_DISTILLER_AUTOMATION_NAME }]);

    const id = await seedXDraftDistillerAutomation({} as never, 'ws-1');

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('seedContentCadenceAutomation', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
  });

  it('creates a 15-min run_internal automation with the canonical handler name', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'cadence-auto' });

    const id = await seedContentCadenceAutomation({} as never, 'ws-1');

    expect(id).toBe('cadence-auto');
    const input = createMock.mock.calls[0][0];
    expect(input.name).toBe(CONTENT_CADENCE_AUTOMATION_NAME);
    expect(input.trigger_config.cron).toBe('*/15 * * * *');
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0].step_type).toBe('run_internal');
    expect(input.steps[0].action_config.handler_name).toBe(CONTENT_CADENCE_HANDLER);
  });

  it('is idempotent', async () => {
    listMock.mockResolvedValue([{ id: 'existing', name: CONTENT_CADENCE_AUTOMATION_NAME }]);

    const id = await seedContentCadenceAutomation({} as never, 'ws-1');

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
  });
});
