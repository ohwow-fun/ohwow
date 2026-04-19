/**
 * Criterion 3: X experiment retirement.
 *
 * Verifies that experiments.ts does NOT register the four retired X experiments:
 *   - XAutonomyRampExperiment
 *   - XShapeTunerExperiment
 *   - XEngagementObserverExperiment
 *   - XOpsObserverExperiment
 *
 * Also verifies that XDmPollerScheduler and XDmReplyDispatcher are not imported
 * from their modules into experiments.ts (they are retired).
 *
 * Approach: read the source file as text and assert that the known class names /
 * import patterns are absent. This is intentionally a static check — the class
 * files themselves still exist so the build stays valid; what matters is that
 * experiments.ts stopped referencing them.
 *
 * Companion to criterion 2: the CONTENT_CADENCE_CONFIG_KEY=0 seed is tested in
 * the content-cadence-scheduler integration suite (X deprecation criterion 2).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS_SRC = readFileSync(
  path.join(__dirname, '..', 'experiments.ts'),
  'utf-8',
);

describe('experiments.ts X experiment retirement (criterion 3)', () => {
  it('does not import XAutonomyRampExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/import.*XAutonomyRampExperiment/);
  });

  it('does not register XAutonomyRampExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/new XAutonomyRampExperiment/);
  });

  it('does not import XShapeTunerExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/import.*XShapeTunerExperiment/);
  });

  it('does not register XShapeTunerExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/new XShapeTunerExperiment/);
  });

  it('does not import XEngagementObserverExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/import.*XEngagementObserverExperiment/);
  });

  it('does not register XEngagementObserverExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/new XEngagementObserverExperiment/);
  });

  it('does not import XOpsObserverExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/import.*XOpsObserverExperiment/);
  });

  it('does not register XOpsObserverExperiment', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/new XOpsObserverExperiment/);
  });

  it('does not import XDmPollerScheduler', () => {
    // Retirement comment allowed — only ban active imports.
    const importLines = EXPERIMENTS_SRC
      .split('\n')
      .filter((l) => l.startsWith('import') && l.includes('XDmPollerScheduler'));
    expect(importLines).toHaveLength(0);
  });

  it('does not import XDmReplyDispatcher', () => {
    const importLines = EXPERIMENTS_SRC
      .split('\n')
      .filter((l) => l.startsWith('import') && l.includes('XDmReplyDispatcher'));
    expect(importLines).toHaveLength(0);
  });

  it('does not instantiate XDmPollerScheduler', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/new XDmPollerScheduler/);
  });

  it('does not instantiate XDmReplyDispatcher', () => {
    expect(EXPERIMENTS_SRC).not.toMatch(/new XDmReplyDispatcher/);
  });

  it('seeds enabledPlatforms with threads only (not x)', () => {
    // The ContentCadenceScheduler construction in experiments.ts must pass
    // enabledPlatforms: ['threads'] — the 'x' value must not appear in that
    // call. We check by finding the scheduler instantiation block and
    // verifying it does not include 'x' in the enabledPlatforms array.
    const cadenceBlockMatch = EXPERIMENTS_SRC.match(
      /new ContentCadenceScheduler[\s\S]{0,400}enabledPlatforms[^}]+/,
    );
    expect(cadenceBlockMatch).not.toBeNull();
    const cadenceBlock = cadenceBlockMatch![0];
    // Must mention 'threads'
    expect(cadenceBlock).toContain("'threads'");
    // Must NOT include 'x' as a platform value in enabledPlatforms list
    // ('x' by itself between quotes / brackets, not as a substring of 'threads').
    expect(cadenceBlock).not.toMatch(/'x'/);
  });
});
