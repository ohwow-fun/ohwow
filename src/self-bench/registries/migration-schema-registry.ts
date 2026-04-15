/**
 * Migration schema probe registry.
 *
 * Each row maps a SQL migration file to the tables it was supposed to
 * create. daemon/start.ts (via auto-registry.ts) instantiates one
 * MigrationSchemaProbeExperiment per row at boot.
 *
 * Why this exists
 * ---------------
 * The autonomous author was emitting one full TypeScript file per
 * migration — 17+ byte-identical classes parameterized only by these
 * two fields. Replacing those files with rows here cuts ~1500 lines
 * of duplicate source while preserving every existing experiment id
 * (slugs match what the deleted classes used, so historical findings
 * are still queryable).
 *
 * Maintaining this file
 * ---------------------
 * Append-only by convention, same as auto-registry.ts. When a new
 * migration lands in src/db/migrations/, add a row here. Eventually
 * the proposal generator's Rule 2 should be wired to append directly
 * here instead of fillMigrationSchemaProbe writing a new TS file —
 * pending Layer 1+2 of the autonomous-fixing safety floor.
 *
 * Schema for each row:
 *   migrationFile  the basename in src/db/migrations/ (.sql included)
 *   expectedTables tables the migration was supposed to create
 */

import type { MigrationSchemaProbeConfig } from '../experiments/migration-schema-probe.js';

export const MIGRATION_SCHEMA_REGISTRY: readonly MigrationSchemaProbeConfig[] = [
  { migrationFile: '008-plans.sql', expectedTables: ['agent_workforce_plans', 'agent_workforce_plan_steps'] },
  { migrationFile: '009-nudges.sql', expectedTables: ['agent_workforce_nudges'] },
  { migrationFile: '010-local-crm.sql', expectedTables: ['agent_workforce_contacts', 'agent_workforce_revenue_entries'] },
  { migrationFile: '012-orchestrator-memory.sql', expectedTables: ['orchestrator_memory'] },
  { migrationFile: '014-webhooks-and-triggers.sql', expectedTables: ['webhook_events', 'local_triggers', 'local_trigger_executions'] },
  { migrationFile: '015-file-attachments.sql', expectedTables: ['agent_workforce_attachments'] },
  { migrationFile: '016-dashboard-tables.sql', expectedTables: ['agent_workforce_departments', 'agent_workforce_team_members', 'agent_workforce_custom_roadmap_stages'] },
  { migrationFile: '017-workflow-triggers.sql', expectedTables: ['agent_workforce_workflow_triggers'] },
  { migrationFile: '018-workspace-onboarding.sql', expectedTables: ['agent_workforce_workspaces'] },
  { migrationFile: '023-local-file-access.sql', expectedTables: ['agent_file_access_paths'] },
  { migrationFile: '024-model-stats.sql', expectedTables: ['ollama_model_snapshots', 'ollama_model_stats'] },
  { migrationFile: '062-endocrine-system.sql', expectedTables: ['hormone_snapshots'] },
  { migrationFile: '072-biological-org.sql', expectedTables: ['agent_synapses'] },
  { migrationFile: '103-fix-person-models-fk.sql', expectedTables: ['agent_workforce_person_models'] },
  { migrationFile: '104-fix-person-observations-fk.sql', expectedTables: ['agent_workforce_person_observations'] },
  { migrationFile: '105-onboarding-plans.sql', expectedTables: ['agent_workforce_onboarding_plans'] },
  { migrationFile: '116-self-findings.sql', expectedTables: ['self_findings'] },
  { migrationFile: '117-experiment-validations.sql', expectedTables: ['experiment_validations'] },
  { migrationFile: '119-runtime-config-overrides.sql', expectedTables: ['runtime_config_overrides'] },
  { migrationFile: '101-llm-calls.sql', expectedTables: ['llm_calls'] },
  { migrationFile: '097-human-growth.sql', expectedTables: ['skill_progression', 'growth_milestones', 'delegation_decisions'] },
  { migrationFile: '095-transition-engine.sql', expectedTables: ['task_patterns', 'task_transitions'] },
  { migrationFile: '096-work-router.sql', expectedTables: ['work_routing_decisions', 'work_augmentations', 'notification_preferences'] },
  { migrationFile: '094-person-models.sql', expectedTables: ['agent_workforce_person_models', 'agent_workforce_person_observations'] },
  { migrationFile: '092-operational-pillars.sql', expectedTables: ['agent_workforce_operational_pillars', 'agent_workforce_pillar_instances'] },
  { migrationFile: '089-conversation-digests.sql', expectedTables: ['orchestrator_conversation_digests'] },
  { migrationFile: '090-goal-checkpoints.sql', expectedTables: ['orchestrator_goal_checkpoints'] },
  { migrationFile: '088-meeting-sessions.sql', expectedTables: ['meeting_sessions'] },
  { migrationFile: '087-arena-trajectories.sql', expectedTables: ['arena_trajectories'] },
  { migrationFile: '085-co-evolution.sql', expectedTables: ['agent_workforce_evolution_runs', 'agent_workforce_evolution_attempts'] },
  { migrationFile: '083-deliverables-enhancements.sql', expectedTables: ['agent_workforce_deliverables_new'] },
  { migrationFile: '084-recovery-audit-log.sql', expectedTables: ['recovery_audit_log'] },
  { migrationFile: '082-agent-evolution-lifecycle.sql', expectedTables: ['agent_workforce_lifecycle_events', 'agent_workforce_prompt_revisions'] },
  { migrationFile: '080-doc-mount-peer-mirrors.sql', expectedTables: ['doc_mount_peer_mirrors'] },
  { migrationFile: '081-sequential-sequences.sql', expectedTables: ['agent_workforce_sequence_runs'] },
  { migrationFile: '076-conversation-persistence.sql', expectedTables: ['orchestrator_conversations', 'orchestrator_messages'] },
  { migrationFile: '077-device-pinned-data.sql', expectedTables: ['device_data_manifest', 'data_fetch_approvals'] },
  { migrationFile: '075-bpp-wiring.sql', expectedTables: ['soul_snapshots', 'homeostasis_action_log', 'immune_state_transitions'] },
  { migrationFile: '072-document-processing-queue.sql', expectedTables: ['document_processing_queue'] },
  { migrationFile: '073-knowledge-graph.sql', expectedTables: ['knowledge_graph_entities', 'knowledge_graph_edges'] },
  { migrationFile: '070-connectors.sql', expectedTables: ['data_source_connectors'] },
  { migrationFile: '069-rag-corpus-stats.sql', expectedTables: ['rag_corpus_stats'] },
  { migrationFile: '068-hexis.sql', expectedTables: ['habits', 'habit_executions'] },
  { migrationFile: '067-ethos.sql', expectedTables: ['ethical_evaluations', 'moral_profile'] },
  { migrationFile: '066-narrative.sql', expectedTables: ['narrative_episodes', 'character_profiles'] },
  { migrationFile: '064-oneiros.sql', expectedTables: ['sleep_state', 'dream_associations'] },
  { migrationFile: '078-doc-mounts.sql', expectedTables: ['doc_mounts', 'doc_mount_pages'] },
  { migrationFile: '065-immune-system.sql', expectedTables: ['threat_signatures', 'immune_memories', 'immune_incidents'] },
  { migrationFile: '063-homeostasis.sql', expectedTables: ['homeostasis_set_points', 'allostasis_events'] },
  { migrationFile: '061-affect-system.sql', expectedTables: ['somatic_markers', 'affective_memories'] },
  { migrationFile: '060-consciousness-items.sql', expectedTables: ['consciousness_items'] },
];
