/**
 * Telos — Purpose Derivation (Aristotle)
 *
 * "Every art and every inquiry, and similarly every action and pursuit,
 * is thought to aim at some good; and for this reason the good has
 * rightly been declared to be that at which all things aim."
 * — Aristotle, Nicomachean Ethics, Book I
 *
 * Every workspace has a telos: why it exists. The growth stage captures
 * WHERE the business is. The telos captures WHY it's going there.
 * Goals are fragments of telos. Tasks are steps toward goals.
 * Agents are instruments of telos.
 */

import type {
  TelosProfile,
  TelosInput,
  TelosAlignment,
  WorkImperative,
  WorkKind,
} from './types.js';

// ============================================================================
// WORK KIND KEYWORD MAPS
// ============================================================================

const THEORIA_KEYWORDS = /\b(research|analyze|compare|investigate|study|evaluate|report|audit|review|understand|assess|explore|discover|learn|benchmark)\b/i;
const POIESIS_KEYWORDS = /\b(build|create|design|write|generate|draft|develop|produce|implement|launch|ship|deploy|setup|configure|automate)\b/i;
const PRAXIS_KEYWORDS = /\b(send|post|publish|sell|contact|schedule|hire|negotiate|close|onboard|follow.?up|outreach|pitch|delegate|manage|coordinate)\b/i;

// ============================================================================
// TELOS DERIVATION
// ============================================================================

/**
 * Derive the workspace's telos (purpose) from its configuration.
 *
 * Pure function, no LLM calls, no DB access. Deterministic.
 */
export function deriveTelos(input: TelosInput): TelosProfile {
  const imperatives: WorkImperative[] = [];
  let nextId = 1;

  // 1. Growth stage focus areas become base imperatives
  for (const area of input.focusAreas) {
    imperatives.push({
      id: `stage-${nextId++}`,
      label: area,
      priority: 5, // mid-priority baseline
      source: 'growth_stage',
      workKind: classifyImperativeKind(area),
    });
  }

  // 2. Growth goals become higher-priority imperatives
  for (const goal of input.growthGoals) {
    if (!goal.trim()) continue;
    imperatives.push({
      id: `goal-${nextId++}`,
      label: goal.trim(),
      priority: 7,
      source: 'growth_goal',
      workKind: classifyImperativeKind(goal),
    });
  }

  // 3. Founder focus becomes highest-priority imperative
  if (input.founderFocus?.trim()) {
    imperatives.push({
      id: `founder-${nextId++}`,
      label: input.founderFocus.trim(),
      priority: 9,
      source: 'founder_focus',
      workKind: classifyImperativeKind(input.founderFocus),
    });
  }

  // 4. Business type adds implicit imperatives
  const typeImperatives = getBusinessTypeImperatives(input.businessType);
  for (const imp of typeImperatives) {
    imperatives.push({ ...imp, id: `type-${nextId++}` });
  }

  // 5. Deduplicate by keyword overlap
  const deduped = deduplicateImperatives(imperatives);

  // 6. Sort by priority (highest first)
  deduped.sort((a, b) => b.priority - a.priority);

  return {
    growthStageId: input.growthStageId,
    growthStageName: input.growthStageName,
    focusAreas: input.focusAreas,
    workImperatives: deduped.slice(0, 10), // cap at 10
    businessType: input.businessType,
    founderFocus: input.founderFocus,
  };
}

// ============================================================================
// TELOS ALIGNMENT
// ============================================================================

/**
 * Assess how well a task aligns with the workspace's purpose.
 *
 * Uses keyword overlap between task text and imperative labels.
 */
export function assessTelosAlignment(
  taskTitle: string,
  taskDescription: string | undefined,
  telos: TelosProfile,
): TelosAlignment {
  const taskText = `${taskTitle} ${taskDescription ?? ''}`.toLowerCase();
  const taskTokens = new Set(taskText.split(/[^a-z0-9]+/).filter(t => t.length > 2));

  let maxOverlap = 0;
  let maxPriority = 0;

  for (const imp of telos.workImperatives) {
    const impTokens = new Set(imp.label.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
    let overlap = 0;
    for (const token of impTokens) {
      if (taskTokens.has(token)) overlap++;
    }
    const normalizedOverlap = impTokens.size > 0 ? overlap / impTokens.size : 0;
    if (normalizedOverlap > maxOverlap) {
      maxOverlap = normalizedOverlap;
      maxPriority = imp.priority;
    }
  }

  // Also check focus area alignment
  for (const area of telos.focusAreas) {
    const areaTokens = new Set(area.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
    for (const token of areaTokens) {
      if (taskTokens.has(token)) {
        maxOverlap = Math.max(maxOverlap, 0.5);
      }
    }
  }

  // Combined score from overlap and priority
  const score = maxOverlap * 0.6 + (maxPriority / 10) * 0.4;

  if (score >= 0.7) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.3) return 'moderate';
  if (score >= 0.1) return 'tangential';
  return 'misaligned';
}

// ============================================================================
// INTERNAL
// ============================================================================

function classifyImperativeKind(text: string): WorkKind {
  if (THEORIA_KEYWORDS.test(text)) return 'theoria';
  if (PRAXIS_KEYWORDS.test(text)) return 'praxis';
  if (POIESIS_KEYWORDS.test(text)) return 'poiesis';
  return 'praxis'; // default: most work is action
}

function getBusinessTypeImperatives(businessType: string): Omit<WorkImperative, 'id'>[] {
  const type = businessType.toLowerCase();
  if (type.includes('saas')) return [
    { label: 'Reduce churn and increase retention', priority: 4, source: 'business_type', workKind: 'praxis' },
    { label: 'Build features users want', priority: 4, source: 'business_type', workKind: 'poiesis' },
  ];
  if (type.includes('ecommerce') || type.includes('e-commerce')) return [
    { label: 'Optimize conversion rate', priority: 4, source: 'business_type', workKind: 'praxis' },
    { label: 'Manage inventory and fulfillment', priority: 4, source: 'business_type', workKind: 'praxis' },
  ];
  if (type.includes('agency')) return [
    { label: 'Deliver client work on time', priority: 4, source: 'business_type', workKind: 'poiesis' },
    { label: 'Acquire and retain clients', priority: 4, source: 'business_type', workKind: 'praxis' },
  ];
  if (type.includes('content')) return [
    { label: 'Create engaging content consistently', priority: 4, source: 'business_type', workKind: 'poiesis' },
    { label: 'Grow audience reach', priority: 4, source: 'business_type', workKind: 'praxis' },
  ];
  return [];
}

function deduplicateImperatives(imperatives: WorkImperative[]): WorkImperative[] {
  const result: WorkImperative[] = [];
  for (const imp of imperatives) {
    const tokens = new Set(imp.label.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
    let isDuplicate = false;
    for (const existing of result) {
      const existingTokens = new Set(existing.label.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
      let overlap = 0;
      for (const t of tokens) { if (existingTokens.has(t)) overlap++; }
      const similarity = Math.max(tokens.size, existingTokens.size) > 0
        ? overlap / Math.max(tokens.size, existingTokens.size)
        : 0;
      if (similarity > 0.6) {
        // Keep the higher-priority one
        if (imp.priority > existing.priority) {
          result[result.indexOf(existing)] = imp;
        }
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) result.push(imp);
  }
  return result;
}
