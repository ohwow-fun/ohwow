/**
 * seed-x-automations tests. Stubs AutomationService so we verify the
 * shape of each seeded automation without touching a real DB.
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
  seedXIntelAutomation,
  seedXForecastAutomation,
  seedXHumorAutomation,
  X_INTEL_AUTOMATION_NAME,
  X_FORECAST_AUTOMATION_NAME,
  X_HUMOR_AUTOMATION_NAME,
} from '../seed-x-automations.js';

describe('seedXIntelAutomation', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
  });

  it('creates the automation when it does not exist yet', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'new-auto' });

    const id = await seedXIntelAutomation({} as never, 'ws-1');

    expect(id).toBe('new-auto');
    expect(createMock).toHaveBeenCalledTimes(1);
    const input = createMock.mock.calls[0][0];
    expect(input.name).toBe(X_INTEL_AUTOMATION_NAME);
    expect(input.trigger_type).toBe('schedule');
    expect(input.trigger_config.cron).toBe('0 */3 * * *');
    expect(input.steps.map((s: { id: string }) => s.id)).toEqual([
      'x_intel',
      'x_authors_to_crm',
      'x_compose',
      'x_reply',
    ]);
    expect(input.steps[0].step_type).toBe('shell_script');
    expect(input.steps[0].action_config.heartbeat_filename).toBe('x-intel-last-run.json');
    expect(input.steps[2].action_config.env).toEqual({ DRY: '0' });
    expect(input.steps[3].action_config.env).toEqual({ DRY: '0' });
  });

  it('is idempotent: skips creation when an automation with the canonical name already exists', async () => {
    listMock.mockResolvedValue([{ id: 'existing', name: X_INTEL_AUTOMATION_NAME, trigger_config: { cron: '0 */6 * * *' } }]);

    const id = await seedXIntelAutomation({} as never, 'ws-1');

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('omits chain steps that are disabled via options', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'new-auto' });

    await seedXIntelAutomation({} as never, 'ws-1', {
      authorsToCrm: false,
      compose: false,
      reply: false,
    });

    const input = createMock.mock.calls[0][0];
    expect(input.steps.map((s: { id: string }) => s.id)).toEqual(['x_intel']);
  });

  it('honors a custom cron override', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'new-auto' });

    await seedXIntelAutomation({} as never, 'ws-1', { cron: '*/30 * * * *' });

    const input = createMock.mock.calls[0][0];
    expect(input.trigger_config.cron).toBe('*/30 * * * *');
  });

  it('refreshes an existing row when its cron matches a prior default', async () => {
    listMock.mockResolvedValue([
      { id: 'existing', name: X_INTEL_AUTOMATION_NAME, trigger_config: { cron: 'OLD_CRON' } },
    ]);

    const id = await seedXIntelAutomation({} as never, 'ws-1', {
      cron: 'NEW_CRON',
      refreshableFrom: ['OLD_CRON'],
    });

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith('existing', { trigger_config: { cron: 'NEW_CRON' } });
  });

  it('leaves operator-edited crons alone (no match in refreshableFrom)', async () => {
    listMock.mockResolvedValue([
      { id: 'existing', name: X_INTEL_AUTOMATION_NAME, trigger_config: { cron: 'OPERATOR_EDITED' } },
    ]);

    await seedXIntelAutomation({} as never, 'ws-1', {
      cron: 'NEW_CRON',
      refreshableFrom: ['OLD_CRON'],
    });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not call update when existing cron already equals new cron', async () => {
    listMock.mockResolvedValue([
      { id: 'existing', name: X_INTEL_AUTOMATION_NAME, trigger_config: { cron: 'SAME_CRON' } },
    ]);

    await seedXIntelAutomation({} as never, 'ws-1', {
      cron: 'SAME_CRON',
      refreshableFrom: ['SAME_CRON', 'OLD_CRON'],
    });

    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('seedXForecastAutomation', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
  });

  it('creates a single-step forecast automation at 00:30 UTC by default', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'forecast-auto' });

    const id = await seedXForecastAutomation({} as never, 'ws-1');

    expect(id).toBe('forecast-auto');
    const input = createMock.mock.calls[0][0];
    expect(input.name).toBe(X_FORECAST_AUTOMATION_NAME);
    expect(input.trigger_config.cron).toBe('30 0 * * *');
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0].action_config.script_path).toBe('scripts/x-experiments/x-forecast-scorer.mjs');
    expect(input.steps[0].action_config.heartbeat_filename).toBe('x-forecast-last-run.json');
  });

  it('is idempotent', async () => {
    listMock.mockResolvedValue([{ id: 'existing', name: X_FORECAST_AUTOMATION_NAME }]);

    const id = await seedXForecastAutomation({} as never, 'ws-1');

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('seedXHumorAutomation', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
  });

  it('creates a humor-scoped compose automation at :20 past the hour by default', async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({ id: 'humor-auto' });

    const id = await seedXHumorAutomation({} as never, 'ws-1');

    expect(id).toBe('humor-auto');
    const input = createMock.mock.calls[0][0];
    expect(input.name).toBe(X_HUMOR_AUTOMATION_NAME);
    expect(input.trigger_config.cron).toBe('20 * * * *');
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0].action_config.script_path).toBe('scripts/x-experiments/x-compose.mjs');
    expect(input.steps[0].action_config.env).toEqual({
      SHAPES: 'humor',
      MAX_DRAFTS: '1',
      DRY: '0',
    });
    expect(input.steps[0].action_config.heartbeat_filename).toBe('x-humor-last-run.json');
  });

  it('is idempotent', async () => {
    listMock.mockResolvedValue([{ id: 'existing', name: X_HUMOR_AUTOMATION_NAME }]);

    const id = await seedXHumorAutomation({} as never, 'ws-1');

    expect(id).toBe('existing');
    expect(createMock).not.toHaveBeenCalled();
  });
});
