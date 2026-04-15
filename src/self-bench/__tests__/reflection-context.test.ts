import { describe, it, expect } from 'vitest';
import { loadReflectionContext } from '../experiments/patch-author.js';

function mockDb(rows: Array<{ affect: string; content: string }> | null): { from: (t: string) => unknown } {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            order: () => ({
              limit: async () => ({ data: rows }),
            }),
          }),
        }),
      }),
    }),
  };
}

describe('loadReflectionContext', () => {
  it('returns null when no rows', async () => {
    expect(await loadReflectionContext(mockDb([]), 'ws')).toBeNull();
    expect(await loadReflectionContext(mockDb(null), 'ws')).toBeNull();
  });

  it('formats rows as a labelled bullet list', async () => {
    const out = await loadReflectionContext(
      mockDb([
        { affect: 'failed', content: 'certain tasks time out' },
        { affect: 'repeated', content: 'a common success pattern' },
      ]),
      'ws',
    );
    expect(out).toContain('Recent reflections');
    expect(out).toContain('- [failed] certain tasks time out');
    expect(out).toContain('- [repeated] a common success pattern');
  });

  it('returns null on query error', async () => {
    const bad = {
      from: () => {
        throw new Error('no table');
      },
    };
    expect(await loadReflectionContext(bad as never, 'ws')).toBeNull();
  });
});
