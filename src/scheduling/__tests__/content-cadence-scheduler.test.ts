/**
 * Integration test: ContentCadenceScheduler against a real SQLite DB
 * with the full schema migrated and a fake RuntimeEngine.
 *
 * Why this exists
 * ---------------
 * The scheduler closes the business loop for ContentCadenceTunerExperiment:
 * it reads the runtime_config knob, finds an idle X-capable agent, dispatches
 * a post task, and updates the goal's current_value from the trailing-7d
 * post count so the tuner's validate() sees real signal. None of these
 * steps had test coverage when the scheduler shipped — and the very first
 * production tick failed silently because the agent-finding query filtered
 * for status='active' (a value no agent ever takes; the lifecycle is
 * idle ↔ working). This test would have caught it.
 *
 * The test exercises:
 *   - ensureGoalExists seeds the goal with a 7-day window on first tick
 *   - subsequent ticks roll the due_date forward when within 1 day of expiry
 *   - the agent-finding query matches idle agents, prefers content/social
 *     keywords, and falls back to any idle agent otherwise
 *   - dispatchXPostTask inserts a pending row and calls engine.executeTask
 *   - updateWeeklyGoalValue writes the trailing-7d count back to the goal
 *   - the daily budget gate suppresses dispatch when postsToday is at cap
 *
 * Uses initDatabase + createSqliteAdapter so the schema migrates from zero
 * the same way the daemon does on first boot, and the fluent query builder
 * behaves exactly like production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { ContentCadenceScheduler } from '../content-cadence-scheduler.js';
import {
  _resetRuntimeConfigCacheForTests,
  setRuntimeConfig,
} from '../../self-bench/runtime-config.js';
import { CONTENT_CADENCE_CONFIG_KEY } from '../../self-bench/experiments/content-cadence-tuner.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';

const WORKSPACE_ID = 'ws-cadence-integ-1';
const GOAL_ID = 'goal-x-posts-per-week';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: DatabaseAdapter;
  engine: { executeTask: ReturnType<typeof vi.fn> };
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-cadence-sched-'));
  const rawDb = initDatabase(join(dir, 'runtime.db'));
  const db = createSqliteAdapter(rawDb);
  const engine = { executeTask: vi.fn().mockResolvedValue(undefined) };
  return { dir, rawDb, db, engine };
}

function teardownEnv(env: Env): void {
  env.rawDb.close();
  rmSync(env.dir, { recursive: true, force: true });
}

function seedAgent(
  rawDb: Database.Database,
  opts: { id: string; name: string; status: 'idle' | 'working' },
): void {
  rawDb
    .prepare(
      `INSERT INTO agent_workforce_agents
        (id, workspace_id, name, role, status, config)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.id, WORKSPACE_ID, opts.name, 'test-role', opts.status, '{}');
}

function makeScheduler(env: Env): ContentCadenceScheduler {
  return new ContentCadenceScheduler(
    env.db,
    env.engine as unknown as RuntimeEngine,
    WORKSPACE_ID,
  );
}

describe('ContentCadenceScheduler — integration', () => {
  let env: Env;

  beforeEach(() => {
    _resetRuntimeConfigCacheForTests();
    env = setupEnv();
  });

  afterEach(() => {
    teardownEnv(env);
  });

  it('seeds the x_posts_per_week goal with a 7-day window on first tick', async () => {
    seedAgent(env.rawDb, { id: 'a-1', name: 'Content Writer', status: 'idle' });
    await makeScheduler(env).tick();

    const row = env.rawDb
      .prepare('SELECT id, target_metric, target_value, unit, due_date FROM agent_workforce_goals WHERE id = ?')
      .get(GOAL_ID) as
      | { id: string; target_metric: string; target_value: number; unit: string; due_date: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.target_metric).toBe('x_posts_per_week');
    expect(row!.target_value).toBe(7);
    expect(row!.unit).toBe('posts/week');

    // due_date should be ~7 days out (within ±1 day for clock skew).
    const dueMs = new Date(row!.due_date).getTime();
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(dueMs - expected)).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('dispatches a task to an idle agent, preferring social/content names', async () => {
    // Two idle agents; the scheduler should prefer the content one.
    seedAgent(env.rawDb, { id: 'a-fallback', name: 'Random Agent', status: 'idle' });
    seedAgent(env.rawDb, { id: 'a-social', name: 'Social Media Manager', status: 'idle' });
    await makeScheduler(env).tick();

    const tasks = env.rawDb
      .prepare("SELECT id, agent_id, status, title FROM agent_workforce_tasks WHERE workspace_id = ?")
      .all(WORKSPACE_ID) as Array<{ id: string; agent_id: string; status: string; title: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agent_id).toBe('a-social');
    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].title).toBe('Post one tweet today');

    expect(env.engine.executeTask).toHaveBeenCalledTimes(1);
    expect(env.engine.executeTask).toHaveBeenCalledWith('a-social', tasks[0].id);
  });

  it('falls back to any idle agent when no name matches the content keywords', async () => {
    seedAgent(env.rawDb, { id: 'a-only', name: 'Lead Qualifier', status: 'idle' });
    await makeScheduler(env).tick();

    const task = env.rawDb
      .prepare("SELECT agent_id FROM agent_workforce_tasks WHERE workspace_id = ?")
      .get(WORKSPACE_ID) as { agent_id: string } | undefined;
    expect(task?.agent_id).toBe('a-only');
  });

  it('skips dispatch when no idle agent exists (the original status-mismatch bug)', async () => {
    // All agents are working — none idle. The earlier bug filtered for
    // status='active' which never matched anything; this test pins the
    // correct semantics: no idle agent → no dispatch.
    seedAgent(env.rawDb, { id: 'a-busy', name: 'Content Writer', status: 'working' });
    await makeScheduler(env).tick();

    const tasks = env.rawDb
      .prepare("SELECT COUNT(*) as n FROM agent_workforce_tasks WHERE workspace_id = ?")
      .get(WORKSPACE_ID) as { n: number };
    expect(tasks.n).toBe(0);
    expect(env.engine.executeTask).not.toHaveBeenCalled();

    // Goal still got seeded so the tuner has something to anchor on.
    const goal = env.rawDb
      .prepare('SELECT id FROM agent_workforce_goals WHERE id = ?')
      .get(GOAL_ID);
    expect(goal).toBeDefined();
  });

  it('respects the daily budget — no dispatch when postsToday >= postsPerDay', async () => {
    seedAgent(env.rawDb, { id: 'a-1', name: 'Content Writer', status: 'idle' });

    // Pre-seed a delivered X deliverable so countXPostsAfter sees it.
    const todayStart = new Date();
    todayStart.setHours(8, 0, 0, 0);
    env.rawDb
      .prepare(
        `INSERT INTO agent_workforce_deliverables
          (id, workspace_id, agent_id, deliverable_type, title, content, status, provider, delivered_at)
         VALUES (?, ?, ?, 'post', 'earlier post', 'content', 'delivered', 'x', ?)`,
      )
      .run('del-already-posted', WORKSPACE_ID, 'a-1', todayStart.toISOString());

    // Default knob is 1/day. With 1 post already today, no dispatch.
    await makeScheduler(env).tick();

    const newTasks = env.rawDb
      .prepare("SELECT COUNT(*) as n FROM agent_workforce_tasks WHERE workspace_id = ? AND status = 'pending'")
      .get(WORKSPACE_ID) as { n: number };
    expect(newTasks.n).toBe(0);
    expect(env.engine.executeTask).not.toHaveBeenCalled();
  });

  it('dispatches when knob raises postsPerDay above postsToday', async () => {
    seedAgent(env.rawDb, { id: 'a-1', name: 'Content Writer', status: 'idle' });

    // Already 1 post today (via deliverable), but tuner widened the knob to 2.
    const earlier = new Date();
    earlier.setHours(8, 0, 0, 0);
    env.rawDb
      .prepare(
        `INSERT INTO agent_workforce_deliverables
          (id, workspace_id, agent_id, deliverable_type, title, content, status, provider, delivered_at)
         VALUES (?, ?, ?, 'post', 'first post', 'content', 'delivered', 'x', ?)`,
      )
      .run('del-1', WORKSPACE_ID, 'a-1', earlier.toISOString());
    await setRuntimeConfig(env.db, CONTENT_CADENCE_CONFIG_KEY, 2);

    await makeScheduler(env).tick();

    expect(env.engine.executeTask).toHaveBeenCalledTimes(1);
  });

  it('updates goal.current_value from the trailing-7d post count', async () => {
    seedAgent(env.rawDb, { id: 'a-1', name: 'Content Writer', status: 'idle' });

    // Three delivered X deliverables within the last 7 days.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const deliveredAt = new Date(now - (i + 1) * 24 * 60 * 60 * 1000).toISOString();
      env.rawDb
        .prepare(
          `INSERT INTO agent_workforce_deliverables
            (id, workspace_id, agent_id, deliverable_type, title, content, status, provider, delivered_at)
           VALUES (?, ?, ?, 'post', ?, 'content', 'delivered', 'x', ?)`,
        )
        .run(`del-wk-${i}`, WORKSPACE_ID, 'a-1', `post ${i}`, deliveredAt);
    }
    // One older than 7d — should NOT be counted.
    env.rawDb
      .prepare(
        `INSERT INTO agent_workforce_deliverables
          (id, workspace_id, agent_id, deliverable_type, title, content, status, provider, delivered_at)
         VALUES (?, ?, ?, 'post', 'old', 'content', 'delivered', 'x', ?)`,
      )
      .run('del-old', WORKSPACE_ID, 'a-1', new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString());

    await makeScheduler(env).tick();

    const goal = env.rawDb
      .prepare('SELECT current_value FROM agent_workforce_goals WHERE id = ?')
      .get(GOAL_ID) as { current_value: number };
    expect(goal.current_value).toBe(3);
  });

  it('rolls the due_date forward 7 days when the existing goal is within 1 day of expiry', async () => {
    seedAgent(env.rawDb, { id: 'a-1', name: 'Content Writer', status: 'idle' });

    // Pre-seed a goal whose due_date is in the past — simulates day 8+
    // after the original 7-day seed when the rolling refresh would have
    // failed to fire on prior ticks.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    env.rawDb
      .prepare(
        `INSERT INTO agent_workforce_goals
          (id, workspace_id, title, target_metric, target_value, current_value, unit, status, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'))`,
      )
      .run(GOAL_ID, WORKSPACE_ID, 'X posts per week', 'x_posts_per_week', 7, 0, 'posts/week', yesterday);

    await makeScheduler(env).tick();

    const refreshed = env.rawDb
      .prepare('SELECT due_date FROM agent_workforce_goals WHERE id = ?')
      .get(GOAL_ID) as { due_date: string };
    const dueMs = new Date(refreshed.due_date).getTime();
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(dueMs - expected)).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });
});
