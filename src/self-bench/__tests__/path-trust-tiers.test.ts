import { describe, it, expect, afterEach } from 'vitest';
import {
  resolvePathTier,
  getAllowedPrefixes,
  _setPathTierRegistryForTests,
} from '../path-trust-tiers.js';

afterEach(() => {
  _setPathTierRegistryForTests(null);
});

describe('resolvePathTier — default registry (behavior-preserving)', () => {
  it('maps every current allowlist path to tier-1', () => {
    const cases = [
      'src/self-bench/experiments/anything.ts',
      'src/self-bench/__tests__/anything.test.ts',
      'src/self-bench/auto-registry.ts',
      'src/self-bench/registries/migration-schema-registry.ts',
      'src/self-bench/registries/toolchain-test-registry.ts',
    ];
    for (const p of cases) {
      expect(resolvePathTier(p).tier, `path ${p}`).toBe('tier-1');
    }
  });

  it('maps every non-allowlisted path to tier-3 (deny-by-default)', () => {
    const cases = [
      'src/orchestrator/engine.ts',
      'src/api/routes/agents.ts',
      'src/db/migrations/001_init.sql',
      'package.json',
      'README.md',
      // A brand-new registry — not specifically listed — must not
      // slip in via a broad prefix match.
      'src/self-bench/registries/some-new-registry.ts',
    ];
    for (const p of cases) {
      expect(resolvePathTier(p).tier, `path ${p}`).toBe('tier-3');
    }
  });

  it('rejects path traversal and absolute paths as tier-3', () => {
    expect(resolvePathTier('../etc/passwd').tier).toBe('tier-3');
    expect(resolvePathTier('/etc/passwd').tier).toBe('tier-3');
    expect(resolvePathTier('src/self-bench/experiments/../engine.ts').tier).toBe('tier-3');
  });

  it('every default registry prefix resolves to its declared tier', () => {
    // Guards against logic drift in resolvePathTier: each registered
    // prefix must round-trip back to the same tier when probed. tier-2
    // entries are allowed (deliberate policy choices, see the audit
    // log alongside each one in path-trust-tiers.ts) but every entry
    // must resolve consistently.
    const allowed = getAllowedPrefixes();
    expect(allowed.length).toBeGreaterThan(0);
    for (const prefix of allowed) {
      const probePath = prefix.endsWith('/') ? `${prefix}x.ts` : prefix;
      const resolved = resolvePathTier(probePath);
      expect(resolved.entry).not.toBeNull();
      expect(resolved.tier).toBe(resolved.entry?.tier);
    }
  });
});

describe('resolvePathTier — test registry override', () => {
  it('longest-prefix wins when a tier-2 override sits inside a tier-1 dir', () => {
    _setPathTierRegistryForTests([
      {
        prefix: 'src/lib/',
        tier: 'tier-1',
        rationale: 'test: broad lib is tier-1',
      },
      {
        prefix: 'src/lib/dangerous/',
        tier: 'tier-2',
        rationale: 'test: narrow override needs a receipt',
      },
    ]);
    expect(resolvePathTier('src/lib/simple.ts').tier).toBe('tier-1');
    expect(resolvePathTier('src/lib/dangerous/risky.ts').tier).toBe('tier-2');
  });

  it('empty registry => everything is tier-3', () => {
    _setPathTierRegistryForTests([]);
    expect(resolvePathTier('src/self-bench/experiments/x.ts').tier).toBe('tier-3');
  });

  it('returns the matching entry on resolution so refusal messages can cite the rationale', () => {
    _setPathTierRegistryForTests([
      {
        prefix: 'src/lib/formatting/',
        tier: 'tier-2',
        rationale: 'pure formatters — autonomous ok with a finding',
      },
    ]);
    const r = resolvePathTier('src/lib/formatting/date.ts');
    expect(r.tier).toBe('tier-2');
    expect(r.entry?.rationale).toContain('pure formatters');
  });
});
