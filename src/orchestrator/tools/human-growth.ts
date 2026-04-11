/**
 * Human Growth Engine orchestrator tools (local runtime).
 * Phase 4 of Center of Operations.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { HumanGrowthEngine } from '../../hexis/human-growth.js';
import { SkillPathsEngine } from '../../hexis/skill-paths.js';
import type { ProgressionSource } from '../../hexis/skill-paths.js';

export async function getHumanGrowth(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  if (!personId) return { success: false, error: 'person_id is required' };

  const engine = new HumanGrowthEngine(ctx.db, ctx.workspaceId);

  // Compute fresh snapshot
  const snapshot = await engine.computeAndStoreSnapshot(personId);
  if (!snapshot) return { success: false, error: 'Person not found' };

  // Get signals
  const signals = await engine.detectGrowthSignals(personId);

  // Get role evolution insight
  const roleInsight = await engine.detectRoleEvolution(personId);

  return {
    success: true,
    data: {
      message: `Growth snapshot computed. Direction: ${snapshot.competence > 0.5 ? 'strong' : 'developing'}.`,
      snapshot,
      signals,
      roleEvolution: roleInsight,
    },
  };
}

export async function getSkillPaths(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  if (!personId) return { success: false, error: 'person_id is required' };

  const engine = new SkillPathsEngine(ctx.db, ctx.workspaceId);
  const paths = await engine.getSkillPaths(personId);

  if (paths.length === 0) {
    return {
      success: true,
      data: {
        message: 'No active skill paths. Use create_skill_path to start one.',
        paths: [],
      },
    };
  }

  const activeMilestones = paths.reduce((s, p) => s + p.milestones.filter((m) => m.status === 'pending').length, 0);
  return {
    success: true,
    data: {
      message: `${paths.length} skill path${paths.length !== 1 ? 's' : ''} active. ${activeMilestones} milestone${activeMilestones !== 1 ? 's' : ''} remaining.`,
      paths,
    },
  };
}

export async function createSkillPath(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  const skillName = input.skill_name as string;
  if (!personId) return { success: false, error: 'person_id is required' };
  if (!skillName) return { success: false, error: 'skill_name is required' };

  const targetLevel = input.target_level as number | undefined;
  const engine = new SkillPathsEngine(ctx.db, ctx.workspaceId);
  const path = await engine.generateSkillPath(personId, skillName, targetLevel);

  if (!path) return { success: false, error: 'Person not found' };

  if (path.milestones.length === 0) {
    return {
      success: true,
      data: { message: `Already at or above target level for ${skillName}.`, path },
    };
  }

  return {
    success: true,
    data: {
      message: `Skill path created for ${skillName}: ${path.milestones.length} milestone${path.milestones.length !== 1 ? 's' : ''} from ${path.milestones[0].difficulty} to ${path.milestones[path.milestones.length - 1].difficulty}.`,
      path,
    },
  };
}

export async function getTeamHealth(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const engine = new HumanGrowthEngine(ctx.db, ctx.workspaceId);
  const report = await engine.assessTeamHealth();

  if (report.totalPeople === 0) {
    return {
      success: true,
      data: { message: 'No profiled team members yet. Run person ingestion first.', report },
    };
  }

  const criticalAlerts = report.alerts.filter((a) => a.severity === 'critical');
  const warningAlerts = report.alerts.filter((a) => a.severity === 'warning');

  return {
    success: true,
    data: {
      message: `Team: ${report.totalPeople} people. ${report.ascending} growing, ${report.plateau} plateaued, ${report.declining} declining.${
        criticalAlerts.length > 0 ? ` ${criticalAlerts.length} critical alert${criticalAlerts.length !== 1 ? 's' : ''}.` : ''
      }${warningAlerts.length > 0 ? ` ${warningAlerts.length} warning${warningAlerts.length !== 1 ? 's' : ''}.` : ''}`,
      report,
    },
  };
}

export async function getDelegationMetrics(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  if (!personId) return { success: false, error: 'person_id is required' };

  const engine = new HumanGrowthEngine(ctx.db, ctx.workspaceId);
  const metrics = await engine.getDelegationMetrics(personId);
  const opportunities = await engine.suggestDelegationOpportunities(personId);

  const ratePercent = Math.round(metrics.delegationRate * 100);

  return {
    success: true,
    data: {
      message: `${metrics.totalDecisions} decisions total. ${ratePercent}% delegated (${metrics.trendDirection}). ${metrics.successfulDelegations} successful, ${metrics.revertedDelegations} reverted.`,
      metrics,
      delegationOpportunities: opportunities,
    },
  };
}

export async function recordSkillAssessment(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  const skillName = input.skill_name as string;
  const newLevel = input.new_level as number;
  if (!personId) return { success: false, error: 'person_id is required' };
  if (!skillName) return { success: false, error: 'skill_name is required' };
  if (newLevel == null || newLevel < 0 || newLevel > 1) return { success: false, error: 'new_level must be 0-1' };

  const source = (input.source as ProgressionSource) || 'self_assessment';
  const engine = new SkillPathsEngine(ctx.db, ctx.workspaceId);
  await engine.recordSkillProgression(personId, skillName, newLevel, source, input.task_id as string | undefined, input.notes as string | undefined);

  return {
    success: true,
    data: { message: `${skillName} updated to ${Math.round(newLevel * 100)}% for this person.` },
  };
}
