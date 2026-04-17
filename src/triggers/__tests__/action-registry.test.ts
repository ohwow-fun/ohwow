import { describe, it, expect } from 'vitest';
import { ActionDispatcherRegistry, createDefaultRegistry } from '../action-registry.js';
import type { ActionDispatcher } from '../action-dispatcher.js';

describe('ActionDispatcherRegistry', () => {
  it('registers and finds dispatchers', () => {
    const registry = new ActionDispatcherRegistry();
    const dispatcher: ActionDispatcher = {
      actionType: 'test_action',
      execute: async () => ({ result: 'ok' }),
    };

    registry.register(dispatcher);
    expect(registry.has('test_action')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
  });

  it('throws on unknown action type', async () => {
    const registry = new ActionDispatcherRegistry();
    await expect(
      registry.execute('unknown', {}, {}, {} as never, {} as never),
    ).rejects.toThrow('Unknown action type: unknown');
  });

  it('delegates to the registered dispatcher', async () => {
    const registry = new ActionDispatcherRegistry();
    const dispatcher: ActionDispatcher = {
      actionType: 'echo',
      execute: async (config) => ({ echoed: config.value }),
    };

    registry.register(dispatcher);
    const result = await registry.execute(
      'echo',
      { value: 'hello' },
      {},
      {} as never,
      {} as never,
    );
    expect(result).toEqual({ echoed: 'hello' });
  });
});

describe('createDefaultRegistry', () => {
  it('registers all default action types', () => {
    const registry = createDefaultRegistry();
    const expectedTypes = [
      'run_agent', 'save_contact', 'update_contact', 'log_contact_event',
      'webhook_forward', 'transform_data', 'conditional', 'run_workflow',
      'create_task', 'send_notification', 'fill_pdf', 'save_attachment',
      'take_screenshot', 'agent_prompt', 'a2a_call', 'generate_chart',
      'shell_script',
    ];

    for (const type of expectedTypes) {
      expect(registry.has(type)).toBe(true);
    }
  });
});
