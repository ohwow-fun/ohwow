/**
 * Toolchain test probe registry.
 *
 * Each row maps an orchestrator-tool slug to a vitest-driven probe via
 * ToolchainTestProbeExperiment. daemon/start.ts (via auto-registry.ts)
 * instantiates one probe per row at boot.
 *
 * Why this exists
 * ---------------
 * Same slop-collapse as the migration-schema registry: the autonomous
 * author was emitting a full TypeScript file per tool, all near-
 * identical except for the slug. Moving them here cuts duplicate
 * source and makes the ghost-test class of bug structurally
 * impossible — see the test in __tests__/toolchain-test-probe.test.ts
 * which asserts every registered slug resolves to a real test file
 * on disk.
 *
 * Ghost cleanup history
 * ---------------------
 * a46f61a deleted 9 toolchain probes that referenced non-existent
 * test files (permanent verdict='fail' on every tick). This refactor
 * found 4 more (schedules, state, synthesize-for-goal, whatsapp) and
 * dropped them on the floor — no row here for any slug whose test
 * file does not currently exist. The Rule 4 fix in 2b5786b should
 * prevent the proposal generator from re-emitting them, but if a
 * future ghost slips in, the registry's coverage test will fail and
 * surface it before the daemon registers another permanent-fail
 * probe.
 *
 * Maintaining this file
 * ---------------------
 * Append-only by convention. When a new orchestrator-tool test lands
 * in src/orchestrator/tools/__tests__/, add a row here. Eventually
 * the proposal generator's Rule 4 should be wired to append directly
 * here — pending Layer 1+2 of the autonomous-fixing safety floor.
 */

import type { ToolchainTestProbeConfig } from '../experiments/toolchain-test-probe.js';

export const TOOLCHAIN_TEST_REGISTRY: readonly ToolchainTestProbeConfig[] = [
  { slug: 'agents' },
  { slug: 'collective-intelligence' },
  { slug: 'human-growth' },
  { slug: 'investigate-shell-allowlist' },
  { slug: 'list-deliverables-since' },
  { slug: 'observation' },
  { slug: 'synthesis-tester' },
  { slug: 'synthesis-probe' },
  { slug: 'tasks' },
  { slug: 'transitions' },
  { slug: 'wiki' },
  { slug: 'work-router' },
];
