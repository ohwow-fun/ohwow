import { describe, it, expect, vi } from 'vitest';
import { syncResource } from '../sync-resources.js';
import type { LocalToolContext } from '../../orchestrator/local-tool-types.js';

function makeCtx(reportResource: ReturnType<typeof vi.fn>): LocalToolContext {
  return {
    controlPlane: { reportResource } as never,
    db: {} as never,
    workspaceId: 'ws-1',
    engine: {} as never,
    channels: {} as never,
  };
}

describe('syncResource — never_sync privacy gate', () => {
  it('skips reportResource when payload.never_sync === 1', async () => {
    const reportResource = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(reportResource);
    await syncResource(ctx, 'contact', 'upsert', { id: 'c-1', never_sync: 1 } as never);
    expect(reportResource).not.toHaveBeenCalled();
  });

  it('skips reportResource when payload.never_sync === true', async () => {
    const reportResource = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(reportResource);
    await syncResource(ctx, 'contact', 'upsert', { id: 'c-1', never_sync: true } as never);
    expect(reportResource).not.toHaveBeenCalled();
  });

  it('calls reportResource when never_sync is absent or 0', async () => {
    const reportResource = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(reportResource);
    await syncResource(ctx, 'contact', 'upsert', { id: 'c-2' });
    await syncResource(ctx, 'contact', 'upsert', { id: 'c-3', never_sync: 0 } as never);
    expect(reportResource).toHaveBeenCalledTimes(2);
  });
});
