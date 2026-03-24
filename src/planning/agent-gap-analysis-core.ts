/**
 * Agent Gap Analysis Core — Pure functions, no DB or AI calls.
 * Shared between cloud and local runtime analyzers.
 *
 * NOTE: This file is duplicated in src/lib/agents/services/agent-gap-analysis-core.ts
 * for the cloud version. Keep both in sync when modifying rules.
 *
 * 6 heuristic rules detect when a new specialized agent would help:
 * 1. Task Fallback — decomposer fell back to wrong agent (3+ in 30d)
 * 2. Overloaded Agent — one agent has 3x avg volume AND 15+ tasks
 * 3. Failed Domain — 5+ failed tasks sharing keywords no agent covers
 * 4. Growth Stage Gap — focus area keywords don't match any agent role
 * 5. Department Gap — business type presets have departments the workspace doesn't
 * 6. Goal Coverage Gap — active goal keywords matching no agent role
 */

// ============================================================================
// TYPES
// ============================================================================

export interface GapAnalysisInput {
  workspaceId: string;
  businessType: string;
  growthStage: number;
  agents: { id: string; name: string; role: string; department: string }[];
  departments: { id: string; name: string }[];
  taskStats: {
    byAgent: { agentId: string; agentName: string; total: number; failed: number }[];
    fallbackCount: number;
    failedTaskTitles: string[];
  };
  goals: { title: string; targetMetric: string | null; status: string }[];
  presets: { presetId: string; agentRole: string; departmentName: string; businessType: string }[];
  existingSuggestionRoles: string[];
  focusAreas: string[];
}

export type GapType =
  | 'task_fallback'
  | 'overloaded_agent'
  | 'failed_domain'
  | 'growth_stage_gap'
  | 'department_gap'
  | 'goal_coverage_gap';

export interface AgentSuggestion {
  gapType: GapType;
  title: string;
  reason: string;
  suggestedRole: string;
  suggestedDepartment?: string;
  presetId?: string;
  evidence: Record<string, unknown>;
}

// ============================================================================
// STATIC CONSTANTS
// ============================================================================

const FOCUS_AREA_ROLE_MAP: Record<string, string[]> = {
  'content': ['Content Writer', 'Content Strategist', 'Blog Writer'],
  'leads': ['Lead Generator', 'Outreach Specialist', 'Sales Development Rep'],
  'sales': ['Sales Rep', 'Sales Closer', 'Account Executive'],
  'marketing': ['Marketing Strategist', 'Social Media Manager', 'Email Marketer'],
  'seo': ['SEO Specialist', 'Content Optimizer'],
  'automation': ['Operations Manager', 'Process Automator'],
  'customer': ['Customer Success Manager', 'Support Agent'],
  'pricing': ['Pricing Analyst', 'Revenue Strategist'],
  'partnerships': ['Partnership Manager', 'Business Development'],
  'upsell': ['Account Manager', 'Revenue Growth Specialist'],
  'brand': ['Brand Strategist', 'PR Manager'],
  'thought leadership': ['Thought Leadership Writer', 'Industry Analyst'],
  'operations': ['Operations Manager', 'Process Automator'],
  'hiring': ['Recruiter', 'HR Manager'],
  'product': ['Product Manager', 'Product Researcher'],
  'mvp': ['Product Builder', 'Technical Lead'],
  'feedback': ['Customer Research Analyst', 'User Researcher'],
  'outreach': ['Outreach Specialist', 'Lead Generator'],
};

export const BUSINESS_TYPE_RECOMMENDED_ROLES: Record<string, { role: string; department: string }[]> = {
  'saas': [
    { role: 'Content Writer', department: 'Marketing' },
    { role: 'Lead Generator', department: 'Sales' },
    { role: 'Customer Success Manager', department: 'Support' },
  ],
  'ecommerce': [
    { role: 'Social Media Manager', department: 'Marketing' },
    { role: 'Product Description Writer', department: 'Marketing' },
    { role: 'Customer Support Agent', department: 'Support' },
  ],
  'agency': [
    { role: 'Project Manager', department: 'Operations' },
    { role: 'Content Writer', department: 'Marketing' },
    { role: 'Account Manager', department: 'Sales' },
  ],
  'consulting': [
    { role: 'Research Analyst', department: 'Operations' },
    { role: 'Proposal Writer', department: 'Sales' },
    { role: 'Content Writer', department: 'Marketing' },
  ],
  'marketplace': [
    { role: 'Community Manager', department: 'Marketing' },
    { role: 'Content Writer', department: 'Marketing' },
    { role: 'Customer Support Agent', department: 'Support' },
  ],
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

function roleMatchesKeywords(role: string, keywords: string[]): boolean {
  const roleLower = role.toLowerCase();
  return keywords.some((kw) => roleLower.includes(kw));
}

function hasAgentWithRole(agents: { role: string }[], suggestedRole: string): boolean {
  const keywords = tokenize(suggestedRole);
  return agents.some((a) => roleMatchesKeywords(a.role, keywords));
}

function hasSuggestionWithRole(existingRoles: string[], suggestedRole: string): boolean {
  const keywords = tokenize(suggestedRole);
  return existingRoles.some((r) => roleMatchesKeywords(r, keywords));
}

// ============================================================================
// ANALYSIS RULES
// ============================================================================

function checkTaskFallback(input: GapAnalysisInput): AgentSuggestion | null {
  if (input.taskStats.fallbackCount < 3) return null;
  return {
    gapType: 'task_fallback',
    title: 'Tasks are being assigned to the wrong agent',
    reason: `${input.taskStats.fallbackCount} tasks in the last 30 days were assigned to a fallback agent because no good match was found. A specialized agent could handle these better.`,
    suggestedRole: 'General Purpose Assistant',
    evidence: { fallbackCount: input.taskStats.fallbackCount },
  };
}

function checkOverloadedAgent(input: GapAnalysisInput): AgentSuggestion | null {
  const stats = input.taskStats.byAgent;
  if (stats.length < 2) return null;

  const totalTasks = stats.reduce((sum, s) => sum + s.total, 0);
  const avgTasks = totalTasks / stats.length;

  for (const agent of stats) {
    if (agent.total >= 15 && agent.total >= avgTasks * 3) {
      const agentInfo = input.agents.find((a) => a.id === agent.agentId);
      const role = agentInfo?.role || 'General';
      return {
        gapType: 'overloaded_agent',
        title: `${agent.agentName} is handling way more than their share`,
        reason: `${agent.agentName} handled ${agent.total} tasks (average is ${Math.round(avgTasks)}). Adding another agent with a similar focus would balance the workload.`,
        suggestedRole: `${role} (Support)`,
        suggestedDepartment: agentInfo?.department,
        evidence: { agentId: agent.agentId, agentName: agent.agentName, taskCount: agent.total, average: Math.round(avgTasks) },
      };
    }
  }
  return null;
}

function checkFailedDomain(input: GapAnalysisInput): AgentSuggestion | null {
  const titles = input.taskStats.failedTaskTitles;
  if (titles.length < 5) return null;

  const wordCounts = new Map<string, number>();
  const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'is', 'are', 'was', 'with', 'that', 'this', 'it', 'from', 'by', 'at', 'as']);

  for (const title of titles) {
    const words = tokenize(title).filter((w) => w.length > 2 && !stopWords.has(w));
    const seen = new Set<string>();
    for (const word of words) {
      if (!seen.has(word)) {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        seen.add(word);
      }
    }
  }

  const sorted = Array.from(wordCounts.entries())
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) return null;

  const [topKeyword, count] = sorted[0];
  if (input.agents.some((a) => a.role.toLowerCase().includes(topKeyword))) return null;

  const suggestedRole = `${topKeyword.charAt(0).toUpperCase() + topKeyword.slice(1)} Specialist`;

  return {
    gapType: 'failed_domain',
    title: `Tasks about "${topKeyword}" keep failing`,
    reason: `${count} failed tasks in the last 30 days mention "${topKeyword}", but no agent specializes in it.`,
    suggestedRole,
    evidence: { keyword: topKeyword, failedCount: count },
  };
}

function checkGrowthStageGap(input: GapAnalysisInput): AgentSuggestion | null {
  const focusAreas = input.focusAreas;
  if (focusAreas.length === 0) return null;

  for (const area of focusAreas) {
    const areaLower = area.toLowerCase();
    for (const [keyword, roles] of Object.entries(FOCUS_AREA_ROLE_MAP)) {
      if (!areaLower.includes(keyword)) continue;

      const covered = roles.some((role) => hasAgentWithRole(input.agents, role));
      if (covered) continue;

      const suggestedRole = roles[0];
      if (hasSuggestionWithRole(input.existingSuggestionRoles, suggestedRole)) continue;

      const preset = input.presets.find(
        (p) => p.agentRole.toLowerCase().includes(keyword) &&
               (p.businessType === input.businessType || p.businessType === 'general'),
      );

      return {
        gapType: 'growth_stage_gap',
        title: `Your growth stage focuses on ${area.toLowerCase()}, but no agent handles it`,
        reason: `At stage ${input.growthStage}, "${area}" is a key focus area. Consider adding a ${suggestedRole} to cover this.`,
        suggestedRole,
        presetId: preset?.presetId,
        evidence: { focusArea: area, growthStage: input.growthStage },
      };
    }
  }

  return null;
}

function checkDepartmentGap(input: GapAnalysisInput): AgentSuggestion | null {
  const totalTasks = input.taskStats.byAgent.reduce((sum, s) => sum + s.total, 0);
  if (totalTasks < 5) return null;

  const existingDeptNames = new Set(input.departments.map((d) => d.name.toLowerCase()));

  const matchingPresets = input.presets.filter(
    (p) => p.businessType === input.businessType && !existingDeptNames.has(p.departmentName.toLowerCase()),
  );

  if (matchingPresets.length === 0) return null;

  const deptPresets = new Map<string, typeof matchingPresets>();
  for (const p of matchingPresets) {
    const list = deptPresets.get(p.departmentName) || [];
    list.push(p);
    deptPresets.set(p.departmentName, list);
  }

  for (const [dept, presets] of deptPresets) {
    const first = presets[0];
    if (hasAgentWithRole(input.agents, first.agentRole)) continue;
    if (hasSuggestionWithRole(input.existingSuggestionRoles, first.agentRole)) continue;

    return {
      gapType: 'department_gap',
      title: `Other ${input.businessType} businesses have a ${dept} department`,
      reason: `Your workspace is missing a ${dept} department. Adding a ${first.agentRole} could fill this gap.`,
      suggestedRole: first.agentRole,
      suggestedDepartment: dept,
      presetId: first.presetId,
      evidence: { missingDepartment: dept, businessType: input.businessType },
    };
  }

  return null;
}

function checkGoalCoverageGap(input: GapAnalysisInput): AgentSuggestion | null {
  const activeGoals = input.goals.filter((g) => g.status === 'active');
  if (activeGoals.length === 0) return null;

  for (const goal of activeGoals) {
    const goalWords = tokenize(goal.title);
    const metricWords = goal.targetMetric ? tokenize(goal.targetMetric) : [];
    const keywords = [...goalWords, ...metricWords].filter((w) => w.length > 3);

    const covered = input.agents.some((a) => {
      const roleWords = tokenize(a.role);
      return keywords.some((kw) => roleWords.some((rw) => rw.includes(kw) || kw.includes(rw)));
    });

    if (covered) continue;

    for (const kw of keywords) {
      for (const [focusKey, roles] of Object.entries(FOCUS_AREA_ROLE_MAP)) {
        if (kw.includes(focusKey) || focusKey.includes(kw)) {
          const suggestedRole = roles[0];
          if (hasAgentWithRole(input.agents, suggestedRole)) continue;
          if (hasSuggestionWithRole(input.existingSuggestionRoles, suggestedRole)) continue;

          return {
            gapType: 'goal_coverage_gap',
            title: `No agent is aligned with your goal: "${goal.title}"`,
            reason: `Your goal "${goal.title}" involves ${kw}, but no agent specializes in this area. A ${suggestedRole} could help drive progress.`,
            suggestedRole,
            evidence: { goalTitle: goal.title, keyword: kw },
          };
        }
      }
    }
  }

  return null;
}

// ============================================================================
// MAIN ANALYZER
// ============================================================================

export function analyzeAgentGaps(input: GapAnalysisInput): AgentSuggestion[] {
  const suggestions: AgentSuggestion[] = [];
  const usedRoles = new Set<string>();

  const rules = [
    checkTaskFallback,
    checkOverloadedAgent,
    checkFailedDomain,
    checkGrowthStageGap,
    checkDepartmentGap,
    checkGoalCoverageGap,
  ];

  for (const rule of rules) {
    if (suggestions.length >= 3) break;

    const result = rule(input);
    if (!result) continue;

    if (usedRoles.has(result.suggestedRole.toLowerCase())) continue;
    if (hasAgentWithRole(input.agents, result.suggestedRole)) continue;
    if (hasSuggestionWithRole(input.existingSuggestionRoles, result.suggestedRole)) continue;

    suggestions.push(result);
    usedRoles.add(result.suggestedRole.toLowerCase());
  }

  return suggestions;
}
