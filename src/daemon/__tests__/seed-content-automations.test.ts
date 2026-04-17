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
const updateMock = vi.fn();
vi.mock('../../triggers/automation-service.js', () => ({
  AutomationService: class {
    list = listMock;
    create = createMock;
    update = updateMock;
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
    updateMock.mockReset();
  });

  it('creates a run_internal automation with the canonical handler name', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'distiller-auto' });

    const id = await seedXDraftDistillerAutomation({} as never, 'ws-1');

    expect(id).toBe('distiller-auto');
    const input = createMock.mock.calls[0][0];
    expect(input.name).toBe(X_DRAFT_DISTILLER_AUTOMATION_NAME);
    expect(input.trigger_config.cron).toBe('45 * * * *');
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0].step_type).toBe('run_internal');
    expect(input.steps[0].action_config.handler_name).toBe(X_DRAFT_DISTILLER_HANDLER);
  });

  it('is idempotent when existing cron matches the new default', async () => {
    listMock.mockResolvedValue([
      { id: 'existing', name: X_DRAFT_DISTILLER_AUTOMATION_NAME, trigger_config: { cron: '45 * * * *' } },
    ]);

    const id = await seedXDraftDistillerAutomation({} as never, 'ws-1');

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refreshes from the old :00 default to the new :45 stagger', async () => {
    listMock.mockResolvedValue([
      { id: 'existing', name: X_DRAFT_DISTILLER_AUTOMATION_NAME, trigger_config: { cron: '0 * * * *' } },
    ]);

    await seedXDraftDistillerAutomation({} as never, 'ws-1');

    expect(updateMock).toHaveBeenCalledWith('existing', { trigger_config: { cron: '45 * * * *' } });
  });
});

describe('seedContentCadenceAutomation', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
  });

  it('creates a staggered cadence automation (:07 :22 :37 :52)', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'cadence-auto' });

    const id = await seedContentCadenceAutomation({} as never, 'ws-1');

    expect(id).toBe('cadence-auto');
    const input = createMock.mock.calls[0][0];
    expect(input.name).toBe(CONTENT_CADENCE_AUTOMATION_NAME);
    expect(input.trigger_config.cron).toBe('7,22,37,52 * * * *');
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0].step_type).toBe('run_internal');
    expect(input.steps[0].action_config.handler_name).toBe(CONTENT_CADENCE_HANDLER);
  });

  it('is idempotent when existing cron matches the new default', async () => {
    listMock.mockResolvedValue([
      { id: 'existing', name: CONTENT_CADENCE_AUTOMATION_NAME, trigger_config: { cron: '7,22,37,52 * * * *' } },
    ]);

    const id = await seedContentCadenceAutomation({} as never, 'ws-1');

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refreshes from the old */15 default to the new staggered cron', async () => {
    listMock.mockResolvedValue([
      { id: 'existing', name: CONTENT_CADENCE_AUTOMATION_NAME, trigger_config: { cron: '*/15 * * * *' } },
    ]);

    await seedContentCadenceAutomation({} as never, 'ws-1');

    expect(updateMock).toHaveBeenCalledWith('existing', { trigger_config: { cron: '7,22,37,52 * * * *' } });
  });
});
