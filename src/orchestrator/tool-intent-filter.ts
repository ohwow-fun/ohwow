/**
 * Intent-based tool filtering for the orchestrator catalog.
 *
 * Maps tool names to the intent sections where they're relevant, plus a
 * priority tier for progressive revelation under tight context budgets.
 * Extracted from tool-definitions.ts so the data (tool schemas) and the
 * filtering algorithm live in separate modules.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export type IntentSection =
  | 'pulse' | 'agents' | 'projects' | 'business' | 'memory' | 'rag'
  | 'vision' | 'filesystem' | 'channels' | 'browser' | 'desktop' | 'project_instructions'
  | 'dev' | 'investigate';

/**
 * Maps each tool name to the intent sections where it's relevant.
 * Tools not listed here are included in ALL sections (always available).
 *
 * Exported so tests can verify every mapped tool name still corresponds to
 * a real tool in the merged catalog — catches future dead entries like the
 * mount_docs orphans removed in the Phase A refactor.
 */
export const TOOL_SECTION_MAP: Record<string, IntentSection[]> = {
  // Always included (not in map): update_plan

  // Agent/task management → 'agents' section
  list_agents: ['agents'],
  list_tasks: ['agents'],
  get_task_detail: ['agents'],
  get_pending_approvals: ['agents'],
  approve_task: ['agents'],
  reject_task: ['agents'],
  run_agent: ['agents'],
  run_sequence: ['agents'],
  evolve_task: ['agents'],
  spawn_agents: ['agents'],
  await_agent_results: ['agents'],
  queue_task: ['agents'],
  retry_task: ['agents'],
  cancel_task: ['agents'],
  get_agent_suggestions: ['agents'],
  list_available_presets: ['agents'],
  setup_agents: ['agents'],
  bootstrap_workspace: ['agents'],

  // Workspace stats/activity → 'pulse'
  get_workspace_stats: ['pulse'],
  get_activity_feed: ['pulse'],

  // Cloud data tools — NOT in section map so they're always available.
  // (Removing from map = included in every intent section.)

  // Automation builder → 'agents'
  discover_capabilities: ['agents'],
  propose_automation: ['agents'],
  create_automation: ['agents'],

  // Workflows → 'agents' (workflow management is agent-adjacent)
  list_workflows: ['agents'],
  run_workflow: ['agents'],
  get_workflow_detail: ['agents'],
  generate_workflow: ['agents'],
  create_workflow: ['agents'],
  update_workflow: ['agents'],
  delete_workflow: ['agents'],
  list_workflow_triggers: ['agents'],
  create_workflow_trigger: ['agents'],
  update_workflow_trigger: ['agents'],
  delete_workflow_trigger: ['agents'],
  get_agent_schedules: ['agents'],
  update_agent_schedule: ['agents'],

  // Projects/goals → 'projects'
  list_projects: ['projects'],
  create_project: ['projects'],
  update_project: ['projects'],
  get_project_board: ['projects'],
  move_task_column: ['projects'],
  list_goals: ['projects'],
  create_goal: ['projects'],
  update_goal: ['projects'],
  link_task_to_goal: ['projects'],
  link_project_to_goal: ['projects'],
  get_agent_state: ['agents'],
  set_agent_state: ['agents'],
  list_agent_state: ['agents'],
  delete_agent_state: ['agents'],
  clear_agent_state: ['agents'],

  // A2A / Peers → 'agents'
  list_a2a_connections: ['agents'],
  send_a2a_task: ['agents'],
  test_a2a_connection: ['agents'],
  list_peers: ['agents'],
  delegate_to_peer: ['agents'],
  ask_peer: ['agents'],
  list_peer_agents: ['agents'],

  // Channels → 'channels'
  connect_whatsapp: ['channels'],
  disconnect_whatsapp: ['channels'],
  get_whatsapp_status: ['channels'],
  update_whatsapp_chat: ['channels'],
  send_whatsapp_message: ['channels'],
  list_whatsapp_chats: ['channels'],
  list_whatsapp_connections: ['channels'],
  add_whatsapp_chat: ['channels'],
  remove_whatsapp_chat: ['channels'],
  get_whatsapp_messages: ['channels'],
  send_telegram_message: ['channels'],
  list_telegram_chats: ['channels'],
  list_telegram_connections: ['channels'],

  // Business intelligence → 'business', 'pulse'
  get_business_pulse: ['business', 'pulse'],
  get_body_state: ['business', 'pulse'],
  get_contact_pipeline: ['business'],
  get_daily_reps_status: ['business', 'pulse'],

  // CRM → 'business' (CRM intent maps to business section tools)
  list_contacts: ['business'],
  create_contact: ['business'],
  update_contact: ['business'],
  log_contact_event: ['business'],
  search_contacts: ['business'],

  // Scraping/research — always available (agents need web access by default)
  // scrape_url, scrape_search, deep_research: removed from map → always included
  scrape_bulk: ['rag', 'browser'],

  // Audio transcription → 'rag', 'vision'
  transcribe_audio: ['rag', 'vision'],

  // Meeting listener → always available (user may ask at any time)
  // start_meeting_listener, stop_meeting_listener, get_meeting_notes: removed from map → always included

  // Internet tools — always available (zero-cost fetch-based, no reason to gate)
  // youtube_transcript, read_rss_feed, github_search: removed from map → always included

  // OCR/vision → 'vision'
  ocr_extract_text: ['vision'],
  analyze_image: ['vision'],

  // Doc mount tools (mount_docs/unmount_docs/list_doc_mounts/search_mounted_docs)
  // are NOT mapped here. They live in src/execution/doc-mounts/doc-mount-tools.ts
  // and only get injected into the runtime tool list by engine.ts:executeTask
  // (phase G), which uses filterToolsByPolicy — never filterToolsByIntent.
  // Adding them to this map would have no effect on any execution path.

  // Knowledge base → 'rag'
  list_knowledge: ['rag'],
  upload_knowledge: ['rag'],
  add_knowledge_from_url: ['rag'],
  assign_knowledge: ['rag'],
  delete_knowledge: ['rag'],
  search_knowledge: ['rag'],
  get_knowledge_document: ['rag'],

  // Wiki — markdown synthesis layer above the raw KB. Tagged 'rag' so any
  // session that gets the knowledge-base toolset also gets the wiki
  // tools — reading + writing synthesized notes is part of the same
  // workflow as searching raw KB chunks.
  wiki_list_pages: ['rag'],
  wiki_read_page: ['rag'],
  wiki_write_page: ['rag'],
  wiki_read_log: ['rag'],
  wiki_read_index: ['rag'],
  wiki_lint: ['rag'],
  wiki_page_history: ['rag'],
  wiki_curate: ['rag'],

  // PDF → 'vision' (document processing)
  pdf_inspect_fields: ['vision'],
  pdf_fill_form: ['vision'],

  // Filesystem tools → 'filesystem'
  local_list_directory: ['filesystem'],
  local_read_file: ['filesystem'],
  local_search_files: ['filesystem'],
  local_search_content: ['filesystem'],
  local_write_file: ['filesystem'],
  local_edit_file: ['filesystem'],

  // Bash tools → 'filesystem' (shell access is filesystem-adjacent)
  run_bash: ['filesystem'],

  // File access gateway → 'filesystem'
  request_file_access: ['filesystem'],

  // LSP code intelligence → 'dev' + 'filesystem'
  lsp_diagnostics: ['dev', 'filesystem'],
  lsp_hover: ['dev', 'filesystem'],
  lsp_go_to_definition: ['dev', 'filesystem'],
  lsp_references: ['dev', 'filesystem'],
  lsp_completions: ['dev', 'filesystem'],

  // investigate_shell → 'investigate' + 'dev'. Mapped into its own
  // section so only the investigate sub-orchestrator focus (which
  // includes 'investigate' in its section set) and the dev-tier
  // workflows see it. The main orchestrator catalog exposes it too
  // via the 'dev' section, but it's excluded by default from
  // non-investigate sub-orchestrators because they don't request
  // 'investigate'.
  investigate_shell: ['investigate', 'dev'],

  // Browser tools → 'browser'
  request_browser: ['browser'],

  // X posting tools → 'browser' (they drive the real Chrome). Tagged
  // browser so any session routed for a web task gets them; they lazy-
  // activate the browser service on first call.
  x_compose_tweet: ['browser'],
  x_compose_thread: ['browser'],
  x_compose_article: ['browser'],
  x_list_dms: ['browser'],
  x_send_dm: ['browser'],
  x_delete_tweet: ['browser'],

  // Desktop tools → 'desktop'
  request_desktop: ['desktop'],

  // Media tools → 'agents' (media generation is agent-adjacent)
  generate_slides: ['agents'],
  export_slides_pdf: ['agents'],
};

/** Always-included tools regardless of intent. Exported for coverage tests. */
export const ALWAYS_INCLUDED_TOOLS = new Set([
  'update_plan', 'delegate_subtask',
  'cloud_list_contacts', 'cloud_list_schedules', 'cloud_list_agents',
  'cloud_list_tasks', 'cloud_get_analytics', 'cloud_list_members',
  // Daemon introspection: always available so agents can discover paths
  // and key tables without relying on intent classification.
  'get_daemon_info',
  // X posting family — these drive the user's real Chrome via CDP and
  // must ALWAYS be the preferred path for anything touching @handle,
  // tweets, threads, articles, or DMs. They used to be gated on the
  // 'browser' intent, but "post a tweet" doesn't trigger any browser
  // keywords in the classifier (no url/navigate/scrape), so the tools
  // were invisible at chat time and the LLM fell back to run_agent +
  // a stale desktop-automation SOP that burned hundreds of thousands
  // of tokens without ever posting anything. Hoisting them into
  // ALWAYS_INCLUDED guarantees they show up in every chat context so
  // the LLM can pick them directly.
  'x_compose_tweet', 'x_compose_thread', 'x_compose_article',
  'x_send_dm', 'x_list_dms', 'x_delete_tweet',
  // Skills-as-code acceptance runner — callable only by explicit
  // name, but must be visible in the prompt whenever a caller asks
  // for it. Hoisted here because intent classification won't catch
  // "synthesis_run_acceptance" under any section.
  'synthesis_run_acceptance',
  // Autonomous learning entry: orchestrator proposes a new skill
  // from a goal + target URL. Always visible so the LLM can pick
  // up a "learn this" prompt without intent routing quirks.
  'synthesize_skill_for_goal',
]);

/**
 * Tool priority tiers for progressive revelation.
 * P1 = core tools always loaded, P2 = common extensions, P3 = rare/advanced.
 * Tools not listed default to P2 (included unless budget is very tight).
 *
 * Exported for coverage tests.
 */
export const TOOL_PRIORITY: Record<string, 1 | 2 | 3> = {
  // P1: Core tools per section (3-5 per section)
  run_agent: 1, run_sequence: 2, evolve_task: 2, list_agents: 1, list_tasks: 1, approve_task: 1, get_task_detail: 1,
  local_read_file: 1, local_list_directory: 1, local_write_file: 1, run_bash: 1,
  search_contacts: 1, list_contacts: 1, create_contact: 1,
  // Team management — chief-of-staff pattern. P1 so onboarding prompts always
  // load them regardless of model size or context budget.
  create_team_member: 1, list_team_members: 1, update_team_member: 1,
  assign_guide_agent: 1, draft_cloud_invite: 1, send_cloud_invite: 1, list_member_tasks: 1,
  start_person_ingestion: 1, update_person_model: 1, get_person_model: 1, list_person_models: 1,
  // Conversation persona — also P1 so the orchestrator can always reach
  // activate_guide_persona during onboarding chats, which is how an
  // assigned guide actually takes over the thread.
  activate_guide_persona: 1, activate_persona: 1, deactivate_persona: 1, get_active_persona: 1,
  // Onboarding plan — P1 so the COS can always reach it during ingestion
  propose_first_month_plan: 1, accept_onboarding_plan: 1, get_onboarding_plan: 1, list_onboarding_plans: 1,
  get_workspace_stats: 1, get_activity_feed: 1,
  cloud_get_analytics: 1, cloud_list_contacts: 2, cloud_list_schedules: 2, cloud_list_agents: 2, cloud_list_tasks: 2, cloud_list_members: 3,
  request_file_access: 1, request_browser: 1, request_desktop: 1,
  scrape_url: 1, deep_research: 1,
  // Doc mount tools — see TOOL_SECTION_MAP comment above. They never reach
  // filterToolsByIntent because the engine uses filterToolsByPolicy on its
  // own tool list. Priority entries here would be dead data.
  send_whatsapp_message: 1, list_whatsapp_chats: 1, connect_whatsapp: 1,
  send_telegram_message: 1, list_telegram_chats: 1,
  ocr_extract_text: 1, analyze_image: 1,
  search_knowledge: 1,
  // Wiki — read/write/list are P1 so the COS always gets them in
  // ingestion contexts (synthesizing a new page is a common next
  // step after KB upload). Lint/history/log are P2 — useful but not
  // every session needs them.
  wiki_list_pages: 1, wiki_read_page: 1, wiki_write_page: 1,
  wiki_read_index: 2, wiki_read_log: 2, wiki_lint: 2, wiki_page_history: 2,
  // wiki_curate is P1 — when the user says "clean up the wiki" the COS
  // needs the tool advertised at the top of its catalog so it picks
  // delegation over chained reads/writes that would bloat the parent.
  wiki_curate: 1,
  // X posting — P1 for launch week. "Post this to X" / "tweet this" /
  // "countdown tweet" must always surface the dedicated tools over
  // generic browser_navigate + browser_click chains.
  x_compose_tweet: 1, x_compose_thread: 1, x_compose_article: 1,
  x_list_dms: 1, x_send_dm: 1, x_delete_tweet: 1,
  lsp_diagnostics: 1,

  // P2: Common extensions (default for unlisted tools)
  queue_task: 2, reject_task: 2, retry_task: 2, cancel_task: 2,
  get_pending_approvals: 2, spawn_agents: 2, await_agent_results: 2,
  local_search_files: 2, local_search_content: 2, local_edit_file: 2,
  lsp_hover: 2, lsp_go_to_definition: 2, lsp_references: 2, lsp_completions: 3,
  update_contact: 2, log_contact_event: 2,
  get_business_pulse: 2, get_body_state: 2, get_contact_pipeline: 2, get_daily_reps_status: 2,
  get_whatsapp_status: 2, add_whatsapp_chat: 2, remove_whatsapp_chat: 2,
  get_whatsapp_messages: 2, disconnect_whatsapp: 2, update_whatsapp_chat: 2,
  list_whatsapp_connections: 2, list_telegram_connections: 2,
  discover_capabilities: 2, propose_automation: 2, create_automation: 2,
  list_projects: 2, create_project: 2, list_goals: 2, create_goal: 2,
  scrape_search: 2, list_knowledge: 2,
  get_agent_suggestions: 2,
  transcribe_audio: 2,
  start_meeting_listener: 2, stop_meeting_listener: 2, get_meeting_notes: 2,
  youtube_transcript: 2, read_rss_feed: 2, github_search: 2,

  // P3: Rare/advanced tools
  list_workflows: 3, run_workflow: 3, get_workflow_detail: 3,
  generate_workflow: 3, create_workflow: 3, update_workflow: 3, delete_workflow: 3,
  list_workflow_triggers: 3, create_workflow_trigger: 3, update_workflow_trigger: 3, delete_workflow_trigger: 3,
  get_agent_schedules: 3, update_agent_schedule: 3,
  update_project: 3, get_project_board: 3, move_task_column: 3,
  update_goal: 3, link_task_to_goal: 3, link_project_to_goal: 3,
  get_agent_state: 3, set_agent_state: 3, list_agent_state: 3, delete_agent_state: 3, clear_agent_state: 3,
  list_a2a_connections: 3, send_a2a_task: 3, test_a2a_connection: 3,
  list_peers: 3, delegate_to_peer: 3, ask_peer: 3, list_peer_agents: 3,
  scrape_bulk: 3, upload_knowledge: 3, add_knowledge_from_url: 3,
  assign_knowledge: 3, delete_knowledge: 3,
  pdf_inspect_fields: 3, pdf_fill_form: 3,
  list_available_presets: 3, setup_agents: 3, bootstrap_workspace: 3,
  generate_slides: 3, export_slides_pdf: 3,
};

/**
 * Determine the maximum tool priority tier based on model size and available context.
 * Smaller models / tighter contexts get fewer tools.
 */
export function getToolPriorityLimit(modelSizeGB: number, availableContextTokens: number): 1 | 2 | 3 {
  if (modelSizeGB < 1.5 || availableContextTokens < 6000) return 1;
  if (modelSizeGB < 5 || availableContextTokens < 12000) return 2;
  return 3;
}

/**
 * Detect explicit tool-name mentions in a user message. When the user
 * literally writes `upload_knowledge`, `delete_knowledge`, `run_bash`,
 * or any other snake_case tool name, those tools must always be loaded
 * regardless of which intent the classifier picks. Otherwise word-boundary
 * quirks around underscores (`\bknowledge\b` doesn't match inside
 * `upload_knowledge`) cause the classifier to miss intent and the model
 * reports "tool not available" for a tool the user literally named.
 *
 * Returns the set of tool names found in the text. Matches are exact
 * (whole identifier) and case-sensitive, so incidental prose won't trigger.
 */
export function extractExplicitToolNames(text: string, allTools: Tool[]): Set<string> {
  if (!text) return new Set();
  const hits = new Set<string>();
  // Single regex pass over the text: match any snake_case identifier of
  // reasonable length. Then intersect with the known tool set. Cheap and
  // robust — O(text length) + O(tools).
  const idents = text.match(/\b[a-z][a-z0-9_]{2,}\b/g);
  if (!idents) return hits;
  const toolNameSet = new Set(allTools.map((t) => t.name));
  for (const id of idents) {
    if (toolNameSet.has(id)) hits.add(id);
  }
  return hits;
}

/**
 * Filter tools to only those relevant to the active intent sections.
 * When `maxPriority` is set, additionally filters out tools above that priority tier.
 * Tools not in TOOL_SECTION_MAP or in ALWAYS_INCLUDED_TOOLS are always kept.
 *
 * `explicitToolNames` is a set of tool names the user literally named in
 * their prompt — those tools bypass intent and priority filters entirely.
 * This is the safety valve for classifier misses: if the user says "call
 * upload_knowledge", that tool is always in the loaded set.
 */
export function filterToolsByIntent(
  tools: Tool[],
  sections: Set<IntentSection>,
  maxPriority?: 1 | 2 | 3,
  explicitToolNames?: Set<string>,
): Tool[] {
  return tools.filter((t) => {
    if (ALWAYS_INCLUDED_TOOLS.has(t.name)) return true;
    if (explicitToolNames?.has(t.name)) return true;

    // Priority filter
    if (maxPriority) {
      const priority = TOOL_PRIORITY[t.name] ?? 2; // default to P2
      if (priority > maxPriority) return false;
    }

    const mappedSections = TOOL_SECTION_MAP[t.name];
    if (!mappedSections) return true; // Not mapped → always include
    return mappedSections.some((s) => sections.has(s));
  });
}
