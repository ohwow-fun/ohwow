/**
 * Tool Registry — maps tool names to their handler functions.
 * Local runtime version using LocalToolContext instead of Supabase.
 */

import type { ToolHandler } from '../local-tool-types.js';
import { listAgents, updateAgentStatus, runAgent, spawnAgents, awaitAgentResults } from './agents.js';
import { runSequence } from './sequences.js';
import { listTasks, getTaskDetail, getPendingApprovals, approveTask, rejectTask, scheduleTask, retryTask, cancelTask } from './tasks.js';
import { getAgentSchedules, updateAgentSchedule } from './schedules.js';
import { listWorkflows, runWorkflow, getWorkflowDetail, createWorkflow, updateWorkflow, deleteWorkflow, generateWorkflow } from './workflows.js';
import { listWorkflowTriggers, createWorkflowTrigger, updateWorkflowTrigger, deleteWorkflowTrigger } from './triggers.js';
import { getWorkspaceStats, getActivityFeed } from './workspace.js';
import { listProjects, createProject, updateProject, getProjectBoard, moveTaskColumn } from './projects.js';
import { listGoals, createGoal, updateGoal, linkTaskToGoal, linkProjectToGoal } from './goals.js';
import { listA2AConnections, sendA2ATask, testA2AConnection } from './a2a.js';
import { connectWhatsApp, disconnectWhatsApp, getWhatsAppStatus, updateWhatsAppChat, sendWhatsAppMessage, listWhatsAppChats, addWhatsAppChat, removeWhatsAppChat, getWhatsAppMessages, listWhatsAppConnections } from './whatsapp.js';
import { sendTelegramMessage, listTelegramChats, listTelegramConnections } from './telegram.js';
import { getBusinessPulse } from './business-pulse.js';
import { getBodyState } from './body-state-tool.js';
import { getContactPipeline } from './contact-pipeline.js';
import { getDailyRepsStatus } from './daily-reps.js';
import { listContacts, createContact, updateContact, logContactEvent, searchContacts } from './crm.js';
import { deepResearch } from './research.js';
import { scrapeUrl, scrapeBulk, scrapeSearch } from './scraping.js';
import { ocrExtractText, analyzeImage } from './ocr.js';
import { listKnowledge, uploadKnowledge, addKnowledgeFromUrl, assignKnowledge, deleteKnowledge, searchKnowledge, getKnowledgeDocument } from './knowledge.js';
import { localListDirectory, localReadFile, localSearchFiles, localSearchContent, localWriteFile, localEditFile } from './filesystem.js';
import { localRunBash } from './bash.js';
import { pdfInspectFields, pdfFillForm } from './pdf.js';
import { listPeers, delegateToPeer, askPeer, listPeerAgentsTool } from './peers.js';
import { getAgentSuggestions } from './agent-suggestions.js';
import { listAvailablePresets, setupAgents, bootstrapWorkspace } from './setup-agents.js';
import { discoverCapabilities, proposeAutomation, createAutomation } from './automation-builder.js';
import { generateSlides, exportSlidesToPdf, generateMusic, generateVideo, generateVoice } from './media.js';
import { evolveTask } from './co-evolution.js';
import { openclawListSkills, openclawImportSkill, openclawRemoveSkill, openclawAuditSkill } from './openclaw.js';
import { getAgentState, setAgentState, listAgentState, deleteAgentState } from './state.js';
import { listConnectors, addConnector, removeConnector, syncConnector, testConnector } from './connectors.js';
import { youtubeTranscript, readRssFeed, githubSearch } from './internet.js';
import { transcribeAudio } from './audio.js';
import { startMeetingListener, stopMeetingListener, getMeetingNotes } from './meeting.js';
import { saveDeliverable } from './deliverables.js';
import { lspDiagnostics, lspHover, lspGoToDefinition, lspReferences, lspCompletions } from './lsp.js';
import { cloudListContacts, cloudListSchedules, cloudListAgents, cloudListTasks, cloudGetAnalytics, cloudListMembers } from './cloud-data.js';
import { assessOperations, getPillarDetail, buildPillar, updatePillarStatus } from './operational-pillars.js';
import { getPersonModel, listPersonModels, startPersonIngestion, updatePersonModel } from './person-model.js';
import { createTeamMember, listTeamMembers, updateTeamMember, assignGuideAgent, draftCloudInvite, sendCloudInvite, listMemberTasks } from './team.js';
import { activateGuidePersona, activatePersona, deactivatePersona, getActivePersona } from './persona.js';
import { proposeFirstMonthPlan, acceptOnboardingPlan, getOnboardingPlan, listOnboardingPlans } from './onboarding-plan.js';
import { getTransitionStatus, overrideTransitionStage, detectTaskPatterns, getTimeSaved } from './transitions.js';
import { routeTask, getRoutingRecommendations, getWorkloadBalance, recordRoutingOutcome, getTaskAugmentation, triggerPreWork } from './work-router.js';
import { getHumanGrowth, getSkillPaths, createSkillPath, getTeamHealth, getDelegationMetrics, recordSkillAssessment } from './human-growth.js';
import { getWorkPatterns, getTimeAllocation, detectAutomationOpportunities, getObservationInsights } from './observation.js';
import { getCrossPollination, scheduleTeamCouncil, getCollectiveBriefing, rebalanceWorkload } from './collective-intelligence.js';
import { llmTool } from './llm.js';
import { getDaemonInfo } from './daemon-info.js';
import { resyncWorkspaceToCloudTool } from './resync.js';

export const toolRegistry = new Map<string, ToolHandler>([
  // LLM organ — per-sub-task model routing via ModelRouter.selectForPurpose.
  ['llm', (ctx, input) => llmTool(ctx, input)],

  // Daemon introspection — canonical paths, db location, key tables
  ['get_daemon_info', (ctx) => getDaemonInfo(ctx)],

  // Maintenance — re-fire every synced row through the cloud sync path
  ['resync_workspace_to_cloud', (ctx, input) => resyncWorkspaceToCloudTool(ctx, input)],

  // Agent tools
  ['list_agents', (ctx) => listAgents(ctx)],
  ['update_agent_status', (ctx, input) => updateAgentStatus(ctx, input)],
  ['run_agent', (ctx, input) => runAgent(ctx, input)],
  ['run_sequence', (ctx, input) => runSequence(ctx, input)],
  ['evolve_task', (ctx, input) => evolveTask(ctx, input)],
  ['spawn_agents', (ctx, input) => spawnAgents(ctx, input)],
  ['await_agent_results', (ctx, input) => awaitAgentResults(ctx, input)],

  // Task tools
  ['list_tasks', (ctx, input) => listTasks(ctx, input)],
  ['get_task_detail', (ctx, input) => getTaskDetail(ctx, input)],
  ['get_pending_approvals', (ctx) => getPendingApprovals(ctx)],
  ['approve_task', (ctx, input) => approveTask(ctx, input)],
  ['reject_task', (ctx, input) => rejectTask(ctx, input)],
  ['queue_task', (ctx, input) => scheduleTask(ctx, input)],
  ['retry_task', (ctx, input) => retryTask(ctx, input)],
  ['cancel_task', (ctx, input) => cancelTask(ctx, input)],

  // Schedule tools
  ['get_agent_schedules', (ctx) => getAgentSchedules(ctx)],
  ['update_agent_schedule', (ctx, input) => updateAgentSchedule(ctx, input)],

  // Workflow tools
  ['list_workflows', (ctx) => listWorkflows(ctx)],
  ['run_workflow', (ctx, input) => runWorkflow(ctx, input)],
  ['get_workflow_detail', (ctx, input) => getWorkflowDetail(ctx, input)],
  ['create_workflow', (ctx, input) => createWorkflow(ctx, input)],
  ['update_workflow', (ctx, input) => updateWorkflow(ctx, input)],
  ['delete_workflow', (ctx, input) => deleteWorkflow(ctx, input)],
  ['generate_workflow', (ctx, input) => generateWorkflow(ctx, input)],

  // Workflow trigger tools
  ['list_workflow_triggers', (ctx, input) => listWorkflowTriggers(ctx, input)],
  ['create_workflow_trigger', (ctx, input) => createWorkflowTrigger(ctx, input)],
  ['update_workflow_trigger', (ctx, input) => updateWorkflowTrigger(ctx, input)],
  ['delete_workflow_trigger', (ctx, input) => deleteWorkflowTrigger(ctx, input)],

  // Workspace tools
  ['get_workspace_stats', (ctx) => getWorkspaceStats(ctx)],
  ['get_activity_feed', (ctx, input) => getActivityFeed(ctx, input)],

  // Project management tools
  ['list_projects', (ctx, input) => listProjects(ctx, input)],
  ['create_project', (ctx, input) => createProject(ctx, input)],
  ['update_project', (ctx, input) => updateProject(ctx, input)],
  ['get_project_board', (ctx, input) => getProjectBoard(ctx, input)],
  ['move_task_column', (ctx, input) => moveTaskColumn(ctx, input)],

  // Goal management tools
  ['list_goals', (ctx, input) => listGoals(ctx, input)],
  ['create_goal', (ctx, input) => createGoal(ctx, input)],
  ['update_goal', (ctx, input) => updateGoal(ctx, input)],
  ['link_task_to_goal', (ctx, input) => linkTaskToGoal(ctx, input)],
  ['link_project_to_goal', (ctx, input) => linkProjectToGoal(ctx, input)],

  // A2A tools
  ['list_a2a_connections', (ctx) => listA2AConnections(ctx)],
  ['send_a2a_task', (ctx, input) => sendA2ATask(ctx, input)],
  ['test_a2a_connection', (ctx, input) => testA2AConnection(ctx, input)],

  // WhatsApp tools
  ['connect_whatsapp', (ctx) => connectWhatsApp(ctx)],
  ['disconnect_whatsapp', (ctx) => disconnectWhatsApp(ctx)],
  ['get_whatsapp_status', (ctx) => getWhatsAppStatus(ctx)],
  ['update_whatsapp_chat', (ctx, input) => updateWhatsAppChat(ctx, input)],
  ['send_whatsapp_message', (ctx, input) => sendWhatsAppMessage(ctx, input)],
  ['list_whatsapp_chats', (ctx) => listWhatsAppChats(ctx)],
  ['add_whatsapp_chat', (ctx, input) => addWhatsAppChat(ctx, input)],
  ['remove_whatsapp_chat', (ctx, input) => removeWhatsAppChat(ctx, input)],
  ['get_whatsapp_messages', (ctx, input) => getWhatsAppMessages(ctx, input)],
  ['list_whatsapp_connections', (ctx) => listWhatsAppConnections(ctx)],

  // Telegram tools
  ['send_telegram_message', (ctx, input) => sendTelegramMessage(ctx, input)],
  ['list_telegram_chats', (ctx) => listTelegramChats(ctx)],
  ['list_telegram_connections', (ctx) => listTelegramConnections(ctx)],

  // Business intelligence
  ['get_business_pulse', (ctx) => getBusinessPulse(ctx)],
  ['get_body_state', (ctx) => getBodyState(ctx)],
  ['get_contact_pipeline', (ctx) => getContactPipeline(ctx)],
  ['get_daily_reps_status', (ctx) => getDailyRepsStatus(ctx)],

  // CRM tools
  ['list_contacts', (ctx, input) => listContacts(ctx, input)],
  ['create_contact', (ctx, input) => createContact(ctx, input)],
  ['update_contact', (ctx, input) => updateContact(ctx, input)],
  ['log_contact_event', (ctx, input) => logContactEvent(ctx, input)],
  ['search_contacts', (ctx, input) => searchContacts(ctx, input)],

  // Scraping
  ['scrape_url', (ctx, input) => scrapeUrl(ctx, input)],
  ['scrape_bulk', (ctx, input) => scrapeBulk(ctx, input)],
  ['scrape_search', (ctx, input) => scrapeSearch(ctx, input)],

  // Research
  ['deep_research', (ctx, input) => deepResearch(ctx, input)],

  // OCR
  ['ocr_extract_text', (ctx, input) => ocrExtractText(ctx, input)],
  ['analyze_image', (ctx, input) => analyzeImage(ctx, input)],

  // Knowledge base
  ['list_knowledge', (ctx, input) => listKnowledge(ctx, input)],
  ['upload_knowledge', (ctx, input) => uploadKnowledge(ctx, input)],
  ['add_knowledge_from_url', (ctx, input) => addKnowledgeFromUrl(ctx, input)],
  ['assign_knowledge', (ctx, input) => assignKnowledge(ctx, input)],
  ['delete_knowledge', (ctx, input) => deleteKnowledge(ctx, input)],
  ['search_knowledge', (ctx, input) => searchKnowledge(ctx, input)],
  ['get_knowledge_document', (ctx, input) => getKnowledgeDocument(ctx, input)],

  // Data source connector tools
  ['list_connectors', (ctx) => listConnectors(ctx)],
  ['add_connector', (ctx, input) => addConnector(ctx, input)],
  ['remove_connector', (ctx, input) => removeConnector(ctx, input)],
  ['sync_connector', (ctx, input) => syncConnector(ctx, input)],
  ['test_connector', (ctx, input) => testConnector(ctx, input)],

  // Filesystem tools
  ['local_list_directory', (ctx, input) => localListDirectory(ctx, input)],
  ['local_read_file', (ctx, input) => localReadFile(ctx, input)],
  ['local_search_files', (ctx, input) => localSearchFiles(ctx, input)],
  ['local_search_content', (ctx, input) => localSearchContent(ctx, input)],
  ['local_write_file', (ctx, input) => localWriteFile(ctx, input)],
  ['local_edit_file', (ctx, input) => localEditFile(ctx, input)],

  // Bash tools
  ['run_bash', (ctx, input) => localRunBash(ctx, input)],

  // PDF form tools
  ['pdf_inspect_fields', (ctx, input) => pdfInspectFields(ctx, input)],
  ['pdf_fill_form', (ctx, input) => pdfFillForm(ctx, input)],

  // Peer tools
  ['list_peers', (ctx) => listPeers(ctx)],
  ['delegate_to_peer', (ctx, input) => delegateToPeer(ctx, input)],
  ['ask_peer', (ctx, input) => askPeer(ctx, input)],
  ['list_peer_agents', (ctx, input) => listPeerAgentsTool(ctx, input)],

  // Agent suggestions
  ['get_agent_suggestions', (ctx, input) => getAgentSuggestions(ctx, input)],

  // Agent setup (onboarding)
  ['list_available_presets', (ctx, input) => listAvailablePresets(ctx, input)],
  ['setup_agents', (ctx, input) => setupAgents(ctx, input)],
  ['bootstrap_workspace', (ctx, input) => bootstrapWorkspace(ctx, input)],

  // Automation builder tools
  ['discover_capabilities', (ctx, input) => discoverCapabilities(ctx, input)],
  ['propose_automation', (ctx, input) => proposeAutomation(ctx, input)],
  ['create_automation', (ctx, input) => createAutomation(ctx, input)],

  // Media tools
  ['generate_slides', (ctx, input) => generateSlides(ctx, input)],
  ['export_slides_pdf', (ctx, input) => exportSlidesToPdf(ctx, input)],
  ['generate_music', (ctx, input) => generateMusic(ctx, input)],
  ['generate_video', (ctx, input) => generateVideo(ctx, input)],
  ['generate_voice', (ctx, input) => generateVoice(ctx, input)],

  // OpenClaw tools
  ['openclaw_list_skills', (ctx) => openclawListSkills(ctx, {})],
  ['openclaw_import_skill', (ctx, input) => openclawImportSkill(ctx, input)],
  ['openclaw_remove_skill', (ctx, input) => openclawRemoveSkill(ctx, input)],
  ['openclaw_audit_skill', (ctx, input) => openclawAuditSkill(ctx, input)],

  // Agent state tools (cross-task persistence)
  ['get_agent_state', (ctx, input) => getAgentState(ctx, input)],
  ['set_agent_state', (ctx, input) => setAgentState(ctx, input)],
  ['list_agent_state', (ctx, input) => listAgentState(ctx, input)],
  ['delete_agent_state', (ctx, input) => deleteAgentState(ctx, input)],

  // Internet tools (zero-cost, zero-config)
  ['youtube_transcript', (ctx, input) => youtubeTranscript(ctx, input)],
  ['read_rss_feed', (ctx, input) => readRssFeed(ctx, input)],
  ['github_search', (ctx, input) => githubSearch(ctx, input)],

  // Audio transcription
  ['transcribe_audio', (ctx, input) => transcribeAudio(ctx, input)],

  // Meeting listener
  ['start_meeting_listener', (ctx, input) => startMeetingListener(ctx, input)],
  ['stop_meeting_listener', (ctx, input) => stopMeetingListener(ctx, input)],
  ['get_meeting_notes', (ctx, input) => getMeetingNotes(ctx, input)],

  // Deliverables
  ['save_deliverable', (ctx, input) => saveDeliverable(ctx, input)],

  // LSP (code intelligence)
  ['lsp_diagnostics', (ctx, input) => lspDiagnostics(ctx, input)],
  ['lsp_hover', (ctx, input) => lspHover(ctx, input)],
  ['lsp_go_to_definition', (ctx, input) => lspGoToDefinition(ctx, input)],
  ['lsp_references', (ctx, input) => lspReferences(ctx, input)],
  ['lsp_completions', (ctx, input) => lspCompletions(ctx, input)],

  // Cloud data tools (query cloud DB via control plane)
  ['cloud_list_contacts', (ctx, input) => cloudListContacts(ctx, input)],
  ['cloud_list_schedules', (ctx, input) => cloudListSchedules(ctx, input)],
  ['cloud_list_agents', (ctx) => cloudListAgents(ctx)],
  ['cloud_list_tasks', (ctx, input) => cloudListTasks(ctx, input)],
  ['cloud_get_analytics', (ctx) => cloudGetAnalytics(ctx)],
  ['cloud_list_members', (ctx) => cloudListMembers(ctx)],

  // Operational pillars tools
  ['assess_operations', (ctx, input) => assessOperations(ctx, input)],
  ['get_pillar_detail', (ctx, input) => getPillarDetail(ctx, input)],
  ['build_pillar', (ctx, input) => buildPillar(ctx, input)],
  ['update_pillar_status', (ctx, input) => updatePillarStatus(ctx, input)],

  // Person model tools
  ['get_person_model', (ctx, input) => getPersonModel(ctx, input)],
  ['list_person_models', (ctx) => listPersonModels(ctx)],
  ['start_person_ingestion', (ctx, input) => startPersonIngestion(ctx, input)],
  ['update_person_model', (ctx, input) => updatePersonModel(ctx, input)],

  // Team member (human) tools — chief-of-staff pattern
  ['create_team_member', (ctx, input) => createTeamMember(ctx, input)],
  ['list_team_members', (ctx, input) => listTeamMembers(ctx, input)],
  ['update_team_member', (ctx, input) => updateTeamMember(ctx, input)],
  ['assign_guide_agent', (ctx, input) => assignGuideAgent(ctx, input)],
  ['draft_cloud_invite', (ctx, input) => draftCloudInvite(ctx, input)],
  ['send_cloud_invite', (ctx, input) => sendCloudInvite(ctx, input)],
  ['list_member_tasks', (ctx, input) => listMemberTasks(ctx, input)],

  // Conversation persona — install an agent as the driver of this chat
  ['activate_guide_persona', (ctx, input) => activateGuidePersona(ctx, input)],
  ['activate_persona', (ctx, input) => activatePersona(ctx, input)],
  ['deactivate_persona', (ctx, input) => deactivatePersona(ctx, input)],
  ['get_active_persona', (ctx, input) => getActivePersona(ctx, input)],

  // Onboarding plan — propose + persist + accept 4-week ramp plans for new hires
  ['propose_first_month_plan', (ctx, input) => proposeFirstMonthPlan(ctx, input)],
  ['accept_onboarding_plan', (ctx, input) => acceptOnboardingPlan(ctx, input)],
  ['get_onboarding_plan', (ctx, input) => getOnboardingPlan(ctx, input)],
  ['list_onboarding_plans', (ctx, input) => listOnboardingPlans(ctx, input)],

  // Transition engine tools
  ['get_transition_status', (ctx, input) => getTransitionStatus(ctx, input)],
  ['override_transition_stage', (ctx, input) => overrideTransitionStage(ctx, input)],
  ['detect_task_patterns', (ctx) => detectTaskPatterns(ctx)],
  ['get_time_saved', (ctx) => getTimeSaved(ctx)],

  // Work Router tools (Phase 3)
  ['route_task', (ctx, input) => routeTask(ctx, input)],
  ['get_routing_recommendations', (ctx, input) => getRoutingRecommendations(ctx, input)],
  ['get_workload_balance', (ctx) => getWorkloadBalance(ctx)],
  ['record_routing_outcome', (ctx, input) => recordRoutingOutcome(ctx, input)],
  ['get_task_augmentation', (ctx, input) => getTaskAugmentation(ctx, input)],
  ['trigger_pre_work', (ctx, input) => triggerPreWork(ctx, input)],

  // Human Growth Engine tools (Phase 4)
  ['get_human_growth', (ctx, input) => getHumanGrowth(ctx, input)],
  ['get_skill_paths', (ctx, input) => getSkillPaths(ctx, input)],
  ['create_skill_path', (ctx, input) => createSkillPath(ctx, input)],
  ['get_team_health', (ctx) => getTeamHealth(ctx)],
  ['get_delegation_metrics', (ctx, input) => getDelegationMetrics(ctx, input)],
  ['record_skill_assessment', (ctx, input) => recordSkillAssessment(ctx, input)],

  // Observation Layer tools (Phase 5)
  ['get_work_patterns', (ctx, input) => getWorkPatterns(ctx, input)],
  ['get_time_allocation', (ctx, input) => getTimeAllocation(ctx, input)],
  ['detect_automation_opportunities', (ctx) => detectAutomationOpportunities(ctx)],
  ['get_observation_insights', (ctx, input) => getObservationInsights(ctx, input)],

  // Collective Intelligence tools (Phase 6)
  ['get_cross_pollination', (ctx) => getCrossPollination(ctx)],
  ['schedule_team_council', (ctx) => scheduleTeamCouncil(ctx)],
  ['get_collective_briefing', (ctx, input) => getCollectiveBriefing(ctx, input)],
  ['rebalance_workload', (ctx) => rebalanceWorkload(ctx)],
]);
