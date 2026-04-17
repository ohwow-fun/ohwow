/**
 * seed-x-intel-automation tests. Stubs AutomationService so we verify
 * the shape of what would be created without touching a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger to suppress output during tests
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

import { seedXIntelAutomation, X_INTEL_AUTOMATION_NAME } from '../seed-x-intel-automation.js';

describe('seedXIntelAutomation', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
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
    // Compose + reply should set DRY=0 to match the old chain env
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
});
