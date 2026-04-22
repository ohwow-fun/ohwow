/**
 * TUI colour palette — true-color hex values.
 * Use these instead of Ink's named colours for a cohesive look.
 */
export const C = {
  cyan:   '#00d4ff',  // primary chrome, borders, headers
  green:  '#39ff14',  // agent working, success, done
  idle:   '#2a5068',  // agent idle, dimmed indicators
  amber:  '#ffaa00',  // warnings, approvals, attention
  red:    '#ff2244',  // errors, critical, reject
  purple: '#aa44ff',  // workspace identity, cloud
  mint:   '#00ff88',  // completion flashes, soft success
  slate:  '#3a4a58',  // decorative borders, neutral dividers
  dim:    '#4a5568',  // secondary text, hints
} as const;
