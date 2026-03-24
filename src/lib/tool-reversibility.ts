/**
 * Tool Reversibility Metadata (Local Runtime)
 * Classifies tools by their reversibility for future confirmation flows.
 * Ported from cloud: src/lib/agents/integration-tools/index.ts
 */

export type ToolReversibility = 'read_only' | 'reversible' | 'irreversible';

/**
 * Reversibility classification for all orchestrator + agent tools.
 * Used as metadata to support future confirmation flows for irreversible actions.
 */
export const TOOL_REVERSIBILITY: Record<string, ToolReversibility> = {
  // ── Orchestrator: read-only queries ──
  update_plan: 'reversible',
  list_agents: 'read_only',
  list_tasks: 'read_only',
  get_task_detail: 'read_only',
  get_pending_approvals: 'read_only',
  get_business_pulse: 'read_only',
  get_workspace_stats: 'read_only',
  get_activity_feed: 'read_only',
  get_daily_reps_status: 'read_only',
  get_agent_schedules: 'read_only',
  get_agent_suggestions: 'read_only',
  get_contact_pipeline: 'read_only',
  list_contacts: 'read_only',
  search_contacts: 'read_only',
  list_projects: 'read_only',
  get_project_board: 'read_only',
  list_goals: 'read_only',
  list_knowledge: 'read_only',
  search_knowledge: 'read_only',
  list_workflows: 'read_only',
  get_workflow_detail: 'read_only',
  list_workflow_triggers: 'read_only',
  list_a2a_connections: 'read_only',
  list_peers: 'read_only',
  list_peer_agents: 'read_only',
  list_whatsapp_chats: 'read_only',
  list_whatsapp_connections: 'read_only',
  get_whatsapp_messages: 'read_only',
  list_telegram_connections: 'read_only',
  list_telegram_chats: 'read_only',
  discover_capabilities: 'read_only',
  pdf_inspect_fields: 'read_only',
  ocr_extract_text: 'read_only',
  analyze_image: 'read_only',
  deep_research: 'read_only',
  scrape_url: 'read_only',
  scrape_search: 'read_only',
  scrape_bulk: 'read_only',
  test_a2a_connection: 'read_only',

  // ── Orchestrator: reversible mutations ──
  run_agent: 'reversible',
  queue_task: 'reversible',
  assign_knowledge: 'reversible',
  create_contact: 'reversible',
  update_contact: 'reversible',
  log_contact_event: 'reversible',
  create_project: 'reversible',
  update_project: 'reversible',
  create_goal: 'reversible',
  update_goal: 'reversible',
  link_task_to_goal: 'reversible',
  link_project_to_goal: 'reversible',
  upload_knowledge: 'reversible',
  add_knowledge_from_url: 'reversible',
  create_workflow: 'reversible',
  update_workflow: 'reversible',
  generate_workflow: 'reversible',
  create_workflow_trigger: 'reversible',
  update_workflow_trigger: 'reversible',
  update_agent_schedule: 'reversible',
  move_task_column: 'reversible',
  retry_task: 'reversible',
  delegate_subtask: 'reversible',
  spawn_agents: 'reversible',
  await_agent_results: 'read_only',
  add_whatsapp_chat: 'reversible',
  remove_whatsapp_chat: 'reversible',
  propose_automation: 'reversible',
  create_automation: 'reversible',
  pdf_fill_form: 'reversible',
  ask_peer: 'reversible',
  delegate_to_peer: 'reversible',

  // ── Orchestrator: irreversible actions ──
  approve_task: 'irreversible',
  reject_task: 'irreversible',
  cancel_task: 'irreversible',
  delete_knowledge: 'irreversible',
  delete_workflow: 'irreversible',
  delete_workflow_trigger: 'irreversible',
  send_whatsapp_message: 'irreversible',
  send_telegram_message: 'irreversible',
  send_a2a_task: 'irreversible',
  run_workflow: 'irreversible',

  // ── Browser tools ──
  browser_navigate: 'read_only',
  browser_snapshot: 'read_only',
  browser_screenshot: 'read_only',
  browser_scroll: 'read_only',
  browser_click: 'reversible',
  browser_type: 'reversible',
  request_browser: 'read_only',

  // ── Bash tools ──
  run_bash: 'irreversible',

  // ── Filesystem tools ──
  local_list_directory: 'read_only',
  local_read_file: 'read_only',
  local_search_files: 'read_only',
  local_search_content: 'read_only',
  local_write_file: 'reversible',
  local_edit_file: 'reversible',
};

/**
 * Get reversibility for a tool. MCP and unknown tools default to 'reversible'.
 */
export function getToolReversibility(toolName: string): ToolReversibility {
  return TOOL_REVERSIBILITY[toolName] ?? 'reversible';
}
