/**
 * Skill Paths — Local Runtime
 *
 * Generates skill development paths with progressive milestones,
 * decreasing scaffolding, and measurable outcomes. Records skill
 * progression events for growth tracking.
 *
 * Phase 4 of Center of Operations.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Difficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert';
export type ScaffoldingLevel = 'high' | 'medium' | 'low' | 'none';
export type MilestoneStatus = 'pending' | 'achieved' | 'abandoned';
export type ProgressionSource = 'task_outcome' | 'self_assessment' | 'peer_observation' | 'training' | 'routing_feedback';

export interface SkillPath {
  skillName: string;
  currentLevel: number;
  targetLevel: number;
  milestones: Milestone[];
  overallProgress: number;
}

export interface Milestone {
  id: string;
  skillName: string;
  targetLevel: number;
  status: MilestoneStatus;
  difficulty: Difficulty;
  scaffoldingLevel: ScaffoldingLevel;
  suggestedTasks: string[];
  pathOrder: number;
  achievedAt: string | null;
}

export interface SkillProgressionEvent {
  id: string;
  skillName: string;
  previousLevel: number;
  newLevel: number;
  source: ProgressionSource;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIFFICULTY_LEVELS: Difficulty[] = ['beginner', 'intermediate', 'advanced', 'expert'];
const SCAFFOLDING_MAP: Record<Difficulty, ScaffoldingLevel> = {
  beginner: 'high',
  intermediate: 'medium',
  advanced: 'low',
  expert: 'none',
};
const LEVEL_THRESHOLDS: Record<Difficulty, number> = {
  beginner: 0.25,
  intermediate: 0.5,
  advanced: 0.75,
  expert: 0.9,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

function difficultyForLevel(level: number): Difficulty {
  if (level <= 0.25) return 'beginner';
  if (level <= 0.5) return 'intermediate';
  if (level <= 0.75) return 'advanced';
  return 'expert';
}

function generateSuggestedTasks(skillName: string, difficulty: Difficulty): string[] {
  const templates: Record<Difficulty, string[]> = {
    beginner: [
      `Read introductory materials on ${skillName}`,
      `Shadow an agent handling a ${skillName} task`,
      `Complete a guided ${skillName} exercise with full agent scaffolding`,
    ],
    intermediate: [
      `Handle a routine ${skillName} task with agent review`,
      `Draft a ${skillName} deliverable, agent polishes`,
      `Identify patterns in recent ${skillName} work`,
    ],
    advanced: [
      `Lead a complex ${skillName} project with minimal agent support`,
      `Review and improve an agent's ${skillName} output`,
      `Create a ${skillName} template or process for the team`,
    ],
    expert: [
      `Handle a novel ${skillName} challenge independently`,
      `Mentor others on ${skillName} best practices`,
      `Design a new ${skillName} workflow or strategy`,
    ],
  };
  return templates[difficulty];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SkillPathsEngine {
  constructor(private db: DatabaseAdapter, private workspaceId: string) {}

  /**
   * Generate a skill development path from current level to target.
   */
  async generateSkillPath(
    personModelId: string,
    skillName: string,
    targetLevel?: number,
  ): Promise<SkillPath | null> {
    const { data: person } = await this.db
      .from('agent_workforce_person_models')
      .select('skills_map')
      .eq('id', personModelId)
      .single();

    if (!person) return null;

    const skillsMap = parseJson<Record<string, number>>(person.skills_map, {});
    const currentLevel = skillsMap[skillName] || 0;
    const target = targetLevel ?? 0.75; // default: advanced

    if (currentLevel >= target) {
      return {
        skillName,
        currentLevel,
        targetLevel: target,
        milestones: [],
        overallProgress: 1,
      };
    }

    // Generate milestones for each difficulty level between current and target
    const currentDifficulty = difficultyForLevel(currentLevel);
    const targetDifficulty = difficultyForLevel(target);
    const startIdx = DIFFICULTY_LEVELS.indexOf(currentDifficulty);
    const endIdx = DIFFICULTY_LEVELS.indexOf(targetDifficulty);

    const milestones: Milestone[] = [];
    const now = new Date().toISOString();

    for (let i = startIdx; i <= endIdx; i++) {
      const difficulty = DIFFICULTY_LEVELS[i];
      const milestoneTarget = Math.min(target, LEVEL_THRESHOLDS[difficulty]);

      if (milestoneTarget <= currentLevel) continue;

      const id = crypto.randomUUID();
      await this.db.from('growth_milestones').insert({
        id,
        workspace_id: this.workspaceId,
        person_model_id: personModelId,
        skill_name: skillName,
        target_level: milestoneTarget,
        status: 'pending',
        difficulty,
        suggested_tasks: JSON.stringify(generateSuggestedTasks(skillName, difficulty)),
        scaffolding_level: SCAFFOLDING_MAP[difficulty],
        path_order: i - startIdx,
        created_at: now,
        updated_at: now,
      });

      milestones.push({
        id,
        skillName,
        targetLevel: milestoneTarget,
        status: 'pending',
        difficulty,
        scaffoldingLevel: SCAFFOLDING_MAP[difficulty],
        suggestedTasks: generateSuggestedTasks(skillName, difficulty),
        pathOrder: i - startIdx,
        achievedAt: null,
      });
    }

    logger.info({ personModelId, skillName, milestonesCreated: milestones.length }, 'Skill path generated');

    return {
      skillName,
      currentLevel,
      targetLevel: target,
      milestones,
      overallProgress: 0,
    };
  }

  /**
   * Get all active skill paths for a person.
   */
  async getSkillPaths(personModelId: string): Promise<SkillPath[]> {
    const { data: person } = await this.db
      .from('agent_workforce_person_models')
      .select('skills_map')
      .eq('id', personModelId)
      .single();

    if (!person) return [];

    const skillsMap = parseJson<Record<string, number>>(person.skills_map, {});

    const { data: milestones } = await this.db
      .from('growth_milestones')
      .select('*')
      .eq('person_model_id', personModelId)
      .in('status', ['pending', 'achieved'])
      .order('path_order', { ascending: true });

    if (!milestones || milestones.length === 0) return [];

    // Group by skill
    const pathMap = new Map<string, Milestone[]>();
    for (const m of milestones) {
      const skill = m.skill_name as string;
      const list = pathMap.get(skill) || [];
      list.push({
        id: m.id as string,
        skillName: skill,
        targetLevel: m.target_level as number,
        status: m.status as MilestoneStatus,
        difficulty: m.difficulty as Difficulty,
        scaffoldingLevel: m.scaffolding_level as ScaffoldingLevel,
        suggestedTasks: parseJson<string[]>(m.suggested_tasks, []),
        pathOrder: m.path_order as number,
        achievedAt: m.achieved_at as string | null,
      });
      pathMap.set(skill, list);
    }

    const paths: SkillPath[] = [];
    for (const [skill, ms] of pathMap) {
      const currentLevel = skillsMap[skill] || 0;
      const maxTarget = Math.max(...ms.map((m) => m.targetLevel));
      const achieved = ms.filter((m) => m.status === 'achieved').length;
      const progress = ms.length > 0 ? achieved / ms.length : 0;

      paths.push({
        skillName: skill,
        currentLevel,
        targetLevel: maxTarget,
        milestones: ms,
        overallProgress: progress,
      });
    }

    return paths;
  }

  /**
   * Record a skill level change and check milestones.
   */
  async recordSkillProgression(
    personModelId: string,
    skillName: string,
    newLevel: number,
    source: ProgressionSource,
    taskId?: string,
    notes?: string,
  ): Promise<void> {
    const { data: person } = await this.db
      .from('agent_workforce_person_models')
      .select('skills_map')
      .eq('id', personModelId)
      .single();

    if (!person) return;

    const skillsMap = parseJson<Record<string, number>>(person.skills_map, {});
    const previousLevel = skillsMap[skillName] || 0;

    // Log progression event
    await this.db.from('skill_progression').insert({
      id: crypto.randomUUID(),
      workspace_id: this.workspaceId,
      person_model_id: personModelId,
      skill_name: skillName,
      previous_level: previousLevel,
      new_level: newLevel,
      source,
      task_id: taskId || null,
      notes: notes || null,
      created_at: new Date().toISOString(),
    });

    // Update person model skills_map
    skillsMap[skillName] = newLevel;
    await this.db.from('agent_workforce_person_models').update({
      skills_map: JSON.stringify(skillsMap),
      updated_at: new Date().toISOString(),
    }).eq('id', personModelId);

    // Check and update milestones
    const now = new Date().toISOString();
    const { data: pendingMilestones } = await this.db
      .from('growth_milestones')
      .select('id, target_level')
      .eq('person_model_id', personModelId)
      .eq('skill_name', skillName)
      .eq('status', 'pending');

    for (const m of (pendingMilestones || [])) {
      if (newLevel >= (m.target_level as number)) {
        await this.db.from('growth_milestones').update({
          status: 'achieved',
          achieved_at: now,
          updated_at: now,
        }).eq('id', m.id as string);

        logger.info({ personModelId, skillName, milestone: m.id }, 'Growth milestone achieved');
      }
    }
  }

  /**
   * Get skill progression history for a person.
   */
  async getSkillHistory(personModelId: string, skillName?: string): Promise<SkillProgressionEvent[]> {
    let query = this.db
      .from('skill_progression')
      .select('id, skill_name, previous_level, new_level, source, created_at')
      .eq('person_model_id', personModelId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (skillName) {
      query = query.eq('skill_name', skillName);
    }

    const { data } = await query;
    return (data || []).map((d) => ({
      id: d.id as string,
      skillName: d.skill_name as string,
      previousLevel: d.previous_level as number,
      newLevel: d.new_level as number,
      source: d.source as ProgressionSource,
      createdAt: d.created_at as string,
    }));
  }
}
