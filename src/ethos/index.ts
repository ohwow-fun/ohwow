export type {
  EthicalFramework,
  MoralConstraint,
  FrameworkResult,
  EthicalEvaluation,
  EthicalContext,
  MoralDevelopmentStage,
  MoralProfile,
  DutyRule,
} from './types.js';

export { HIGH_RISK_TOOLS, MEDIUM_RISK_TOOLS, SECRET_PATTERNS } from './types.js';
export { checkMoralConstraints } from './constraints.js';
export { checkDutyRules } from './deontological.js';
export { predictOutcomes } from './consequentialist.js';
export { assessCharacterAlignment } from './virtue-based.js';
export { assessRelationshipImpact } from './care-based.js';
export { detectDilemma } from './dilemma.js';
export { EthicsEngine } from './ethics-engine.js';
