/**
 * Shared node styles, dimensions, and colors for the flow builder.
 */

export const NODE_WIDTH = 280;
export const NODE_HEIGHT = 80;

export const STEP_TYPE_ICONS: Record<string, string> = {
  agent_prompt: 'robot',
  a2a_call: 'plugs-connected',
  run_agent: 'robot',
  save_contact: 'user-plus',
  update_contact: 'user-gear',
  log_contact_event: 'note',
  webhook_forward: 'webhooks-logo',
  transform_data: 'shuffle',
  conditional: 'git-branch',
  create_task: 'kanban',
  take_screenshot: 'camera',
  generate_chart: 'chart-bar',
};

export const STEP_TYPE_COLORS: Record<string, string> = {
  agent_prompt: '#818cf8',    // indigo
  a2a_call: '#a78bfa',       // violet
  run_agent: '#818cf8',      // indigo
  save_contact: '#34d399',   // emerald
  update_contact: '#2dd4bf', // teal
  log_contact_event: '#fbbf24', // amber
  webhook_forward: '#f472b6', // pink
  transform_data: '#60a5fa', // blue
  conditional: '#fb923c',    // orange
  create_task: '#a3e635',    // lime
  take_screenshot: '#38bdf8', // sky blue
  generate_chart: '#f472b6',  // pink
};

export const TRIGGER_TYPE_COLORS: Record<string, string> = {
  webhook: '#60a5fa',    // blue
  schedule: '#a78bfa',   // violet
  event: '#fbbf24',      // amber
  manual: '#34d399',     // emerald
};
