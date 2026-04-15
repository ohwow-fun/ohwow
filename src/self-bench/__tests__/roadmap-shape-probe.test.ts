import { describe, it, expect } from 'vitest';
import {
  checkRoadmapShape,
  type RoadmapShapeInput,
} from '../experiments/roadmap-shape-probe.js';

const VALID_INDEX = [
  '# AUTONOMY_ROADMAP.md',
  '',
  'See [roadmap/gaps.md](roadmap/gaps.md) and',
  '[roadmap/iteration-log.md](roadmap/iteration-log.md).',
  '',
  '## 1. Current System State',
  'state',
  '',
  '## 2. Active Focus',
  'focus',
  '',
  '## 3. Next Steps',
  'next',
  '',
].join('\n');

const VALID_GAPS = [
  '# Known Gaps',
  '',
  'Links back to [../AUTONOMY_ROADMAP.md](../AUTONOMY_ROADMAP.md).',
  '',
  '## Known Gaps',
  '',
  '### P0 — Something',
  'body',
  '',
].join('\n');

const VALID_LOG = [
  '# Iteration Log',
  '',
  '[../AUTONOMY_ROADMAP.md](../AUTONOMY_ROADMAP.md)',
  '',
  '## Recent Iterations',
  '',
  '### 2026-04-15T16:15 — Newer',
  'body',
  '',
  '### 2026-04-15T10:40 — Older',
  'body',
  '',
  '### 2026-04-14 — Oldest',
  'body',
  '',
].join('\n');

function input(over: Partial<RoadmapShapeInput> = {}): RoadmapShapeInput {
  return { index: VALID_INDEX, gaps: VALID_GAPS, log: VALID_LOG, ...over };
}

describe('checkRoadmapShape', () => {
  it('returns no violations for a well-formed suite', () => {
    expect(checkRoadmapShape(input())).toEqual([]);
  });

  it('flags a missing file', () => {
    const violations = checkRoadmapShape(input({ gaps: null }));
    expect(violations.some((v) => v.rule === 'file-missing' && v.file === 'roadmap/gaps.md')).toBe(true);
  });

  it('flags an empty file', () => {
    const violations = checkRoadmapShape(input({ log: '   \n\n' }));
    expect(violations.map((v) => v.rule)).toContain('file-empty');
  });

  it('flags missing ## Known Gaps header', () => {
    const bad = VALID_GAPS.replace('## Known Gaps', '## Gaps');
    const violations = checkRoadmapShape(input({ gaps: bad }));
    expect(violations.map((v) => `${v.rule}:${v.file}`)).toContain(
      'missing-h2:roadmap/gaps.md',
    );
  });

  it('flags missing ## Recent Iterations header', () => {
    const bad = VALID_LOG.replace('## Recent Iterations', '## Log');
    const violations = checkRoadmapShape(input({ log: bad }));
    expect(violations.map((v) => `${v.rule}:${v.file}`)).toContain(
      'missing-h2:roadmap/iteration-log.md',
    );
  });

  it('flags iteration entries that are not ordered newest-first', () => {
    const reordered = [
      '## Recent Iterations',
      '',
      '### 2026-04-14 — Oldest first (wrong)',
      'body',
      '',
      '### 2026-04-15T10:40 — Older',
      'body',
      '',
      '### 2026-04-15T16:15 — Newest last (wrong)',
      'body',
      '',
    ].join('\n');
    const violations = checkRoadmapShape(input({ log: reordered }));
    expect(violations.map((v) => v.rule)).toContain('iteration-order');
  });

  it('flags a dangling cross-link between the roadmap files', () => {
    const bad = VALID_INDEX.replace(
      'roadmap/gaps.md](roadmap/gaps.md)',
      'roadmap/gaps.md](roadmap/does-not-exist.md)',
    );
    const violations = checkRoadmapShape(input({ index: bad }));
    expect(violations.map((v) => v.rule)).toContain('dangling-link');
  });
});
