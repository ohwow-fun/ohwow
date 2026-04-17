/**
 * run_internal dispatcher tests. Covers handler lookup, config passing,
 * unknown-handler error path, and config validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runInternalDispatcher } from '../dispatchers/run-internal.js';
import {
  registerInternalHandler,
  resetInternalHandlerRegistry,
} from '../internal-handler-registry.js';
import type { DispatcherDeps } from '../action-dispatcher.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';

const deps = {} as DispatcherDeps;
const trigger = { id: 't1', name: 'test' } as LocalTrigger;

describe('runInternalDispatcher', () => {
  beforeEach(() => {
    resetInternalHandlerRegistry();
  });

  it('invokes the registered handler with the config payload', async () => {
    let seenConfig: Record<string, unknown> | null = null;
    registerInternalHandler('my.handler', async ({ config }) => {
      seenConfig = config;
      return { drafted: 3 };
    });

    const out = await runInternalDispatcher.execute(
      { handler_name: 'my.handler', config: { limit: 5 } },
      {},
      deps,
      trigger,
    );

    expect(seenConfig).toEqual({ limit: 5 });
    expect(out.handler_name).toBe('my.handler');
    expect(out.status).toBe('ok');
    expect(out.drafted).toBe(3);
    expect(typeof out.duration_ms).toBe('number');
  });

  it('passes an empty config if the step omits it', async () => {
    let seenConfig: Record<string, unknown> | null = null;
    registerInternalHandler('empty.handler', async ({ config }) => {
      seenConfig = config;
      return {};
    });

    await runInternalDispatcher.execute(
      { handler_name: 'empty.handler' },
      {},
      deps,
      trigger,
    );

    expect(seenConfig).toEqual({});
  });

  it('throws with a helpful message for an unknown handler', async () => {
    registerInternalHandler('one', async () => ({}));
    registerInternalHandler('two', async () => ({}));

    await expect(
      runInternalDispatcher.execute(
        { handler_name: 'three' },
        {},
        deps,
        trigger,
      ),
    ).rejects.toThrow(/unknown handler "three".*one.*two/);
  });

  it('rejects config missing handler_name', async () => {
    await expect(
      runInternalDispatcher.execute({}, {}, deps, trigger),
    ).rejects.toThrow(/invalid config/);
  });

  it('propagates handler errors as dispatcher errors', async () => {
    registerInternalHandler('broken', async () => {
      throw new Error('kaboom');
    });

    await expect(
      runInternalDispatcher.execute(
        { handler_name: 'broken' },
        {},
        deps,
        trigger,
      ),
    ).rejects.toThrow('kaboom');
  });
});
