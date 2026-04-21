/**
 * Migration schema probe registry.
 *
 * AUTO-GENERATED. Do NOT edit by hand — changes will be overwritten on
 * the next regen. Update by running:
 *
 *     npm run regen:migration-registry
 *
 * daemon/start.ts (via auto-registry.ts) instantiates one
 * MigrationSchemaProbeExperiment per row here. Each row names a SQL
 * migration file and the tables that migration should have created;
 * the probe periodically verifies those tables are still present.
 *
 * Regen rules (deterministic — see scripts/regen-migration-schema-registry.mjs):
 *   - Files enumerated in numerical order (lexical on the zero-padded prefix).
 *   - Tables parsed from CREATE/DROP/ALTER RENAME statements in each file.
 *   - First migration to CREATE a table wins; rename-in-place migrations
 *     yield no novel tables and are silently dropped.
 *   - Row emits only the novel tables for that migration, capped at
 *     50 per row.
 */

import type { MigrationSchemaProbeConfig } from '../experiments/migration-schema-probe.js';

export const MIGRATION_SCHEMA_REGISTRY: readonly MigrationSchemaProbeConfig[] = [
  { migrationFile: '001-data-plane-tables.sql', expectedTables: ['agent_workforce_tasks', 'agent_workforce_task_messages', 'agent_workforce_agent_memory', 'agent_workforce_memory_extraction_log', 'agent_workforce_browser_sessions', 'telegram_chat_messages', 'orchestrator_chat_sessions', 'agent_workforce_contact_events', 'agent_workforce_briefings', 'local_agent_configs', 'local_schedule_configs', 'local_workflow_configs'] },
  { migrationFile: '002-agents-table.sql', expectedTables: ['agent_workforce_agents', 'agent_workforce_activity'] },
  { migrationFile: '003-orchestrator-a2a.sql', expectedTables: ['a2a_connections', 'a2a_task_logs', 'agent_workforce_projects', 'agent_workforce_schedules', 'agent_workforce_workflows'] },
  { migrationFile: '004-whatsapp.sql', expectedTables: ['whatsapp_connections', 'whatsapp_allowed_chats', 'whatsapp_chat_messages'] },
  { migrationFile: '005-telegram.sql', expectedTables: ['telegram_connections'] },
  { migrationFile: '007-deliverables.sql', expectedTables: ['agent_workforce_deliverables'] },
  { migrationFile: '008-plans.sql', expectedTables: ['agent_workforce_plans', 'agent_workforce_plan_steps'] },
  { migrationFile: '009-nudges.sql', expectedTables: ['agent_workforce_nudges'] },
  { migrationFile: '010-local-crm.sql', expectedTables: ['agent_workforce_contacts', 'agent_workforce_revenue_entries'] },
  { migrationFile: '011-notification-preferences.sql', expectedTables: ['runtime_settings'] },
  { migrationFile: '012-orchestrator-memory.sql', expectedTables: ['orchestrator_memory'] },
  { migrationFile: '014-webhooks-and-triggers.sql', expectedTables: ['webhook_events', 'local_triggers', 'local_trigger_executions'] },
  { migrationFile: '015-file-attachments.sql', expectedTables: ['agent_workforce_attachments'] },
  { migrationFile: '016-dashboard-tables.sql', expectedTables: ['agent_workforce_departments', 'agent_workforce_team_members', 'agent_workforce_custom_roadmap_stages'] },
  { migrationFile: '017-openclaw-call-logs.sql', expectedTables: ['openclaw_call_logs'] },
  { migrationFile: '017-workflow-triggers.sql', expectedTables: ['agent_workforce_workflow_triggers'] },
  { migrationFile: '018-workspace-onboarding.sql', expectedTables: ['agent_workforce_workspaces'] },
  { migrationFile: '022-knowledge-base.sql', expectedTables: ['agent_workforce_knowledge_documents', 'agent_workforce_knowledge_chunks', 'agent_workforce_knowledge_agent_config'] },
  { migrationFile: '023-local-file-access.sql', expectedTables: ['agent_file_access_paths'] },
  { migrationFile: '024-model-stats.sql', expectedTables: ['ollama_model_snapshots', 'ollama_model_stats'] },
  { migrationFile: '025-workspace-peers.sql', expectedTables: ['workspace_peers'] },
  { migrationFile: '029-goals.sql', expectedTables: ['agent_workforce_goals'] },
  { migrationFile: '030-agent-suggestions.sql', expectedTables: ['agent_workforce_agent_suggestions'] },
  { migrationFile: '033-template-bundles.sql', expectedTables: ['template_bundles', 'template_installs'] },
  { migrationFile: '035-anomaly-alerts.sql', expectedTables: ['agent_workforce_anomaly_alerts'] },
  { migrationFile: '040-self-improvement-tables.sql', expectedTables: ['agent_workforce_routing_stats', 'agent_workforce_skills', 'agent_workforce_digital_twin_snapshots', 'agent_workforce_practice_sessions', 'agent_workforce_principles', 'agent_workforce_discovered_processes', 'agent_workforce_proactive_runs'] },
  { migrationFile: '044-multi-connection-fixes.sql', expectedTables: ['connection_locks'] },
  { migrationFile: '045-task-state.sql', expectedTables: ['agent_workforce_task_state'] },
  { migrationFile: '046-state-changelog.sql', expectedTables: ['agent_workforce_state_changelog'] },
  { migrationFile: '047-outbound-queue.sql', expectedTables: ['outbound_queue'] },
  { migrationFile: '051-execution-engine-tables.sql', expectedTables: ['agent_workforce_workflow_runs', 'agent_workforce_sessions', 'agent_workforce_action_journal', 'agent_workforce_autonomy_history', 'agent_workforce_prompt_versions', 'agent_workforce_data_store'] },
  { migrationFile: '053-llm-cache.sql', expectedTables: ['llm_response_cache'] },
  { migrationFile: '055-resource-usage.sql', expectedTables: ['resource_usage_daily'] },
  { migrationFile: '056-sandbox-tables.sql', expectedTables: ['agent_workforce_tool_recordings', 'agent_workforce_shadow_runs'] },
  { migrationFile: '057-persona-soul.sql', expectedTables: ['persona_observations', 'persona_model'] },
  { migrationFile: '058-turboquant-stats.sql', expectedTables: ['turboquant_stats'] },
  { migrationFile: '059-claude-code-sessions.sql', expectedTables: ['claude_code_sessions'] },
  { migrationFile: '060-consciousness-items.sql', expectedTables: ['consciousness_items'] },
  { migrationFile: '061-affect-system.sql', expectedTables: ['somatic_markers', 'affective_memories'] },
  { migrationFile: '062-endocrine-system.sql', expectedTables: ['hormone_snapshots'] },
  { migrationFile: '063-homeostasis.sql', expectedTables: ['homeostasis_set_points', 'allostasis_events'] },
  { migrationFile: '064-oneiros.sql', expectedTables: ['sleep_state', 'dream_associations'] },
  { migrationFile: '065-immune-system.sql', expectedTables: ['threat_signatures', 'immune_memories', 'immune_incidents'] },
  { migrationFile: '066-narrative.sql', expectedTables: ['narrative_episodes', 'character_profiles'] },
  { migrationFile: '067-ethos.sql', expectedTables: ['ethical_evaluations', 'moral_profile'] },
  { migrationFile: '068-hexis.sql', expectedTables: ['habits', 'habit_executions'] },
  { migrationFile: '069-rag-corpus-stats.sql', expectedTables: ['rag_corpus_stats'] },
  { migrationFile: '070-connectors.sql', expectedTables: ['data_source_connectors'] },
  { migrationFile: '072-biological-org.sql', expectedTables: ['agent_synapses'] },
  { migrationFile: '072-document-processing-queue.sql', expectedTables: ['document_processing_queue'] },
  { migrationFile: '073-knowledge-graph.sql', expectedTables: ['knowledge_graph_entities', 'knowledge_graph_edges'] },
  { migrationFile: '075-bpp-wiring.sql', expectedTables: ['soul_snapshots', 'homeostasis_action_log', 'immune_state_transitions'] },
  { migrationFile: '076-conversation-persistence.sql', expectedTables: ['orchestrator_conversations', 'orchestrator_messages'] },
  { migrationFile: '077-device-pinned-data.sql', expectedTables: ['device_data_manifest', 'data_fetch_approvals'] },
  { migrationFile: '078-doc-mounts.sql', expectedTables: ['doc_mounts', 'doc_mount_pages'] },
  { migrationFile: '080-doc-mount-peer-mirrors.sql', expectedTables: ['doc_mount_peer_mirrors'] },
  { migrationFile: '081-sequential-sequences.sql', expectedTables: ['agent_workforce_sequence_runs'] },
  { migrationFile: '082-agent-evolution-lifecycle.sql', expectedTables: ['agent_workforce_lifecycle_events', 'agent_workforce_prompt_revisions'] },
  { migrationFile: '084-recovery-audit-log.sql', expectedTables: ['recovery_audit_log'] },
  { migrationFile: '085-co-evolution.sql', expectedTables: ['agent_workforce_evolution_runs', 'agent_workforce_evolution_attempts'] },
  { migrationFile: '087-arena-trajectories.sql', expectedTables: ['arena_trajectories'] },
  { migrationFile: '088-meeting-sessions.sql', expectedTables: ['meeting_sessions'] },
  { migrationFile: '089-conversation-digests.sql', expectedTables: ['orchestrator_conversation_digests'] },
  { migrationFile: '090-goal-checkpoints.sql', expectedTables: ['orchestrator_goal_checkpoints'] },
  { migrationFile: '092-operational-pillars.sql', expectedTables: ['agent_workforce_operational_pillars', 'agent_workforce_pillar_instances'] },
  { migrationFile: '094-person-models.sql', expectedTables: ['agent_workforce_person_models', 'agent_workforce_person_observations'] },
  { migrationFile: '095-transition-engine.sql', expectedTables: ['task_patterns', 'task_transitions'] },
  { migrationFile: '096-work-router.sql', expectedTables: ['work_routing_decisions', 'work_augmentations', 'notification_preferences'] },
  { migrationFile: '097-human-growth.sql', expectedTables: ['skill_progression', 'growth_milestones', 'delegation_decisions'] },
  { migrationFile: '101-llm-calls.sql', expectedTables: ['llm_calls'] },
  { migrationFile: '105-onboarding-plans.sql', expectedTables: ['agent_workforce_onboarding_plans'] },
  { migrationFile: '116-self-findings.sql', expectedTables: ['self_findings'] },
  { migrationFile: '117-experiment-validations.sql', expectedTables: ['experiment_validations'] },
  { migrationFile: '119-runtime-config-overrides.sql', expectedTables: ['runtime_config_overrides'] },
  { migrationFile: '120-business-vitals.sql', expectedTables: ['business_vitals'] },
  { migrationFile: '122-video-jobs.sql', expectedTables: ['video_jobs', 'video_job_checkpoints'] },
  { migrationFile: '123-insight-distiller.sql', expectedTables: ['self_observation_baselines', 'self_insight_feedback'] },
  { migrationFile: '124-x-dm-messages.sql', expectedTables: ['x_dm_threads', 'x_dm_observations'] },
  { migrationFile: '125-x-dm-messages-bodies.sql', expectedTables: ['x_dm_messages'] },
  { migrationFile: '126-x-dm-signals.sql', expectedTables: ['x_dm_signals'] },
  { migrationFile: '129-x-posted-log.sql', expectedTables: ['x_posted_log'] },
  { migrationFile: '130-patches-attempted-log.sql', expectedTables: ['patches_attempted_log'] },
  { migrationFile: '131-research-citations-ledger.sql', expectedTables: ['research_citations_ledger'] },
  { migrationFile: '133-posted-log.sql', expectedTables: ['posted_log'] },
  { migrationFile: '134-lift-measurements.sql', expectedTables: ['lift_measurements'] },
  { migrationFile: '135-calendar-email.sql', expectedTables: ['calendar_accounts', 'calendar_events', 'email_accounts', 'email_messages', 'email_drafts'] },
  { migrationFile: '135-x-post-drafts.sql', expectedTables: ['x_post_drafts'] },
  { migrationFile: '136-deals-pipeline.sql', expectedTables: ['deal_stages', 'deals', 'deal_activities'] },
  { migrationFile: '137-documents.sql', expectedTables: ['document_templates', 'documents'] },
  { migrationFile: '138-support-tickets.sql', expectedTables: ['support_tickets', 'ticket_comments', 'analytics_snapshots'] },
  { migrationFile: '139-bookkeeping-time.sql', expectedTables: ['expense_categories', 'expenses', 'time_entries'] },
  { migrationFile: '140-yt-short-drafts.sql', expectedTables: ['yt_short_drafts', 'yt_episode_metrics'] },
  { migrationFile: '142-x-reply-drafts.sql', expectedTables: ['x_reply_drafts'] },
  { migrationFile: '143-phase-trios.sql', expectedTables: ['phase_trios', 'phase_rounds'] },
  { migrationFile: '144-director-arcs.sql', expectedTables: ['director_arcs', 'director_phase_reports', 'founder_inbox'] },
  { migrationFile: '147-cdp-trace-events.sql', expectedTables: ['cdp_trace_events'] },
  { migrationFile: '148-eternal-state.sql', expectedTables: ['eternal_state'] },
  { migrationFile: '149-eternal-notifications.sql', expectedTables: ['eternal_notifications'] },
];

// Migrations skipped (all tables claimed by an earlier migration —
// e.g. rename-in-place or additive ALTER-only shapes):
//   - 013-voice-profile-settings.sql
//   - 027-attachment-pdf-template-type.sql
//   - 032-nudge-type-update.sql
//   - 083-deliverables-enhancements.sql
//   - 103-fix-person-models-fk.sql
//   - 104-fix-person-observations-fk.sql
