/**
 * Person Model orchestrator tools (local runtime).
 *
 * Phase 1 of Center of Operations: Deep Person Ingestion.
 * Manages Person Models and conversational profiling.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  return raw as T;
}

// ---------------------------------------------------------------------------
// Interview Guides
// ---------------------------------------------------------------------------

const FOUNDER_INTERVIEW_GUIDE = {
  variant: 'founder',
  steps: [
    {
      step: 1, title: 'Vision and Context', dimension: 'ambitions',
      questions: [
        'Tell me about what you are building. What problem does it solve?',
        'Who is your ideal customer?',
        'What is working right now? What is stuck?',
        'Where do you want this business to be in 1 year? 3 years?',
      ],
    },
    {
      step: 2, title: 'Domain Expertise Mapping', dimension: 'domain_expertise',
      questions: [
        'On a scale of 1-10, how confident are you in: product development, marketing, sales, operations, finance, legal, design, community building?',
        'Which of these have you done professionally before?',
        'Which feel like complete unknowns?',
      ],
    },
    {
      step: 3, title: 'Work Style and Energy', dimension: 'energy_patterns',
      questions: [
        'When do you do your best deep work?',
        'Do you prefer long focused blocks or short bursts?',
        'What tools do you use daily?',
        'How do you prefer to communicate?',
      ],
    },
    {
      step: 4, title: 'Friction and Flow', dimension: 'friction_points',
      questions: [
        'What tasks do you always put off or dread doing?',
        'What could you do all day without getting tired?',
        'What is the most repetitive thing you do each week?',
        'When you are in the zone, what are you usually working on?',
      ],
    },
  ],
};

const TEAM_MEMBER_INTERVIEW_GUIDE = {
  variant: 'team_member',
  steps: [
    {
      step: 1, title: 'Background and Skills', dimension: 'skills_map',
      questions: [
        'Tell me about your background. What have you done before this role?',
        'What are you strongest at?',
        'What skills are you actively trying to develop?',
      ],
    },
    {
      step: 2, title: 'Work Style', dimension: 'communication_style',
      questions: [
        'How do you prefer to receive tasks and feedback?',
        'Do you prefer detailed instructions or high-level direction?',
        'When do you do your best work?',
      ],
    },
    {
      step: 3, title: 'Motivation and Growth', dimension: 'ambitions',
      questions: [
        'What excites you most about this role?',
        'What would you like to be doing more of?',
        'Is there anything draining or repetitive?',
        'Where do you see yourself growing?',
      ],
    },
    {
      step: 4, title: 'Tools and Preferences', dimension: 'tool_proficiency',
      questions: [
        'What tools do you use daily?',
        'Are there workflows that feel clunky?',
        'How do you learn best?',
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

export async function getPersonModel(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string | undefined;

  let query = ctx.db
    .from('agent_workforce_person_models')
    .select('*')
    .eq('workspace_id', ctx.workspaceId);

  if (personId) {
    query = query.eq('id', personId);
  }

  const { data, error } = await query.single();

  if (error || !data) {
    return {
      success: true,
      data: {
        message: personId
          ? 'No Person Model found for that ID. Use start_person_ingestion to create one.'
          : 'No Person Model found. Use start_person_ingestion to create one.',
        exists: false,
      },
    };
  }

  return {
    success: true,
    data: {
      personModel: {
        id: data.id,
        name: data.name,
        email: data.email,
        roleTitle: data.role_title,
        variant: data.variant,
        ingestionStatus: data.ingestion_status,
        domainExpertise: parseJson(data.domain_expertise, {}),
        blindSpots: parseJson(data.blind_spots, []),
        skillsMap: parseJson(data.skills_map, {}),
        toolProficiency: parseJson(data.tool_proficiency, {}),
        communicationStyle: parseJson(data.communication_style, {}),
        energyPatterns: parseJson(data.energy_patterns, {}),
        learningStyle: data.learning_style,
        ambitions: parseJson(data.ambitions, {}),
        valuesAndMotivations: parseJson(data.values_and_motivations, []),
        frictionPoints: parseJson(data.friction_points, []),
        flowTriggers: parseJson(data.flow_triggers, []),
        skillGapsToClose: parseJson(data.skill_gaps_to_close, []),
        growthArc: parseJson(data.growth_arc, {}),
        growthDirection: data.growth_direction,
        observationCount: data.observation_count,
        refinementCount: data.refinement_count,
      },
    },
  };
}

export async function listPersonModels(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const { data, error } = await ctx.db
    .from('agent_workforce_person_models')
    .select('id, name, email, role_title, variant, ingestion_status, growth_direction, observation_count')
    .eq('workspace_id', ctx.workspaceId);

  if (error) return { success: false, error: error.message };

  const models = (data || []).map((d: Record<string, unknown>) => ({
    id: d.id, name: d.name, email: d.email, roleTitle: d.role_title,
    variant: d.variant, ingestionStatus: d.ingestion_status,
    growthDirection: d.growth_direction, observationCount: d.observation_count,
  }));

  return {
    success: true,
    data: {
      message: models.length > 0
        ? `Found ${models.length} Person Model${models.length !== 1 ? 's' : ''}.`
        : 'No Person Models yet. Use start_person_ingestion to profile a team member or yourself.',
      models,
    },
  };
}

export async function startPersonIngestion(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name as string;
  const email = input.email as string | undefined;
  const roleTitle = input.role_title as string | undefined;
  const variant = (input.variant as string) || 'team_member';

  if (!name) return { success: false, error: 'name is required' };
  if (variant !== 'founder' && variant !== 'team_member') {
    return { success: false, error: 'variant must be "founder" or "team_member"' };
  }

  const now = new Date().toISOString();

  // Check for existing
  const { data: existing } = await ctx.db
    .from('agent_workforce_person_models')
    .select('id, ingestion_status')
    .eq('workspace_id', ctx.workspaceId)
    .eq('name', name)
    .single();

  if (existing) {
    await ctx.db
      .from('agent_workforce_person_models')
      .update({ ingestion_status: 'in_progress', ingestion_variant: variant, updated_at: now })
      .eq('id', existing.id as string);

    const guide = variant === 'founder' ? FOUNDER_INTERVIEW_GUIDE : TEAM_MEMBER_INTERVIEW_GUIDE;
    return {
      success: true,
      data: {
        message: `Resuming Person Ingestion for ${name}. Follow the interview guide conversationally.`,
        personModelId: existing.id,
        interviewGuide: guide,
        instructions: 'Work through each step conversationally. After each step, call update_person_model to save what you learned.',
      },
    };
  }

  const id = crypto.randomUUID();
  const { error } = await ctx.db
    .from('agent_workforce_person_models')
    .insert({
      id, workspace_id: ctx.workspaceId, name,
      email: email || null, role_title: roleTitle || null,
      variant, ingestion_status: 'in_progress', ingestion_variant: variant,
      created_at: now, updated_at: now,
    });

  if (error) return { success: false, error: error.message };

  const guide = variant === 'founder' ? FOUNDER_INTERVIEW_GUIDE : TEAM_MEMBER_INTERVIEW_GUIDE;
  return {
    success: true,
    data: {
      message: `Created Person Model for ${name} (${variant}). Follow the interview guide below. One topic at a time, conversationally.`,
      personModelId: id,
      interviewGuide: guide,
      instructions: 'Work through each step conversationally. After each step, call update_person_model to save what you learned. Mark ingestion_status as "initial_complete" when done.',
    },
  };
}

export async function updatePersonModel(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  const updates = input.updates as Record<string, unknown>;
  const observation = input.observation as string | undefined;
  const observationType = input.observation_type as string | undefined;

  if (!personId) return { success: false, error: 'person_id is required' };
  if (!updates || Object.keys(updates).length === 0) {
    return { success: false, error: 'updates must contain at least one dimension' };
  }

  const validDimensions = [
    'work_history', 'skills_map', 'domain_expertise', 'blind_spots',
    'tool_proficiency', 'communication_style', 'energy_patterns',
    'learning_style', 'collaboration_preferences', 'ambitions',
    'values_and_motivations', 'friction_points', 'flow_triggers',
    'skill_gaps_to_close', 'external_context', 'growth_arc',
    'ingestion_status', 'role_title',
  ];

  // Sonnet and other strong models frequently emit camelCase keys like
  // `communicationStyle` even when the schema says snake_case — they default
  // to JS conventions. Normalize incoming keys to snake_case and check
  // against the valid set. Be liberal in what we accept: it's cheaper to
  // translate than to reject and force a retry.
  const camelToSnake = (s: string): string =>
    s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const normalizedUpdates: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(updates)) {
    const key = validDimensions.includes(rawKey) ? rawKey : camelToSnake(rawKey);
    if (!validDimensions.includes(key)) {
      return { success: false, error: `Invalid dimension: "${rawKey}". Valid: ${validDimensions.join(', ')}` };
    }
    normalizedUpdates[key] = value;
  }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };

  for (const [key, value] of Object.entries(normalizedUpdates)) {
    // SQLite stores JSON as text
    updatePayload[key] = typeof value === 'object' ? JSON.stringify(value) : value;
  }

  if (normalizedUpdates.ingestion_status === 'initial_complete') {
    updatePayload.last_ingestion_at = new Date().toISOString();
  }

  const { error: updateError } = await ctx.db
    .from('agent_workforce_person_models')
    .update(updatePayload)
    .eq('id', personId)
    .eq('workspace_id', ctx.workspaceId);

  if (updateError) return { success: false, error: updateError.message };

  // Log observation. Bump observation_count on the parent model so callers
  // can cheaply check "have we accumulated enough for initial_complete yet"
  // without re-scanning the observations table.
  if (observation) {
    const { error: obsError } = await ctx.db
      .from('agent_workforce_person_observations')
      .insert({
        id: crypto.randomUUID(),
        person_model_id: personId,
        workspace_id: ctx.workspaceId,
        dimension: Object.keys(normalizedUpdates)[0] || 'general',
        observation_type: observationType || 'self_report',
        content: observation,
        data: JSON.stringify(normalizedUpdates),
        confidence: 0.8,
        processed: 1,
      });
    if (obsError) {
      // Observation persistence failure is NOT fatal to the structured
      // update — we already saved the dimensions above. Surface the error
      // so the caller knows narrative memory didn't persist.
      return {
        success: true,
        data: {
          message: `Updated ${Object.keys(normalizedUpdates).length} dimension(s) but observation logging failed: ${obsError.message}`,
          updatedDimensions: Object.keys(normalizedUpdates),
          observationLogged: false,
        },
      };
    }
    // Best-effort counter bump — we don't block on it.
    try {
      const { data: cur } = await ctx.db
        .from('agent_workforce_person_models')
        .select('observation_count')
        .eq('id', personId)
        .maybeSingle();
      const prev = ((cur as { observation_count?: number } | null)?.observation_count) ?? 0;
      await ctx.db
        .from('agent_workforce_person_models')
        .update({ observation_count: prev + 1 })
        .eq('id', personId);
    } catch { /* non-fatal */ }
  }

  return {
    success: true,
    data: {
      message: `Updated ${Object.keys(normalizedUpdates).length} dimension${Object.keys(normalizedUpdates).length !== 1 ? 's' : ''}${observation ? ' + observation logged' : ''}.`,
      updatedDimensions: Object.keys(normalizedUpdates),
      observationLogged: !!observation,
    },
  };
}
